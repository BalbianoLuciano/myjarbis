#!/bin/bash
#
# E2E test: health, gc and backfill-remotes.
#
# These three read and delete across the whole machine, so the test runs
# with HOME pointed at a sandbox. That is not a convenience — `gc` edits
# ~/.claude.json and removes directories under ~/.claude/projects, and a
# test that ran against the real home would be a loaded gun.
#
# It asserts:
#   1. `health --json` reports the fleet, and adoption counts are real
#   2. `gc` reports a dead registry entry and does NOT remove it without
#      --apply
#   3. `gc --apply` removes it, and backs the registry up first
#   4. `gc` never collects a rollback copy (.silo-retired-, .merged-)
#   5. `gc` only removes a Claude project dir whose MEMORY.md it wrote
#   6. `backfill-remotes` records a remote that `init` predates
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/gc.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-maint-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# Sandbox everything these commands reach for.
export HOME="$WORK/home"
mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }
jqn()  { node -e "const r=require('$1');console.log(eval('r$2'))"; }

mkdir -p "$WORK/alpha" && cd "$WORK/alpha" && git init -q .
git config user.email t@example.com && git config user.name Test
git remote add origin git@github.com:acme/alpha.git
"$MJ" init --yes --skip-memory >/dev/null 2>&1

# ── [1] health ────────────────────────────────────────────────────
echo "[1] health"
node "$CLI" health --json > "$WORK/h1.json" 2>&1 || true

if [ "$(jqn "$WORK/h1.json" ".totals.projects")" = "1" ]; then
  pass "reports the one project"
else
  oops "expected 1 project, got $(jqn "$WORK/h1.json" ".totals.projects")"
fi

if node "$CLI" health 2>&1 | grep -q "Shipped, and actually used"; then
  pass "pretty output renders the adoption section"
else
  oops "adoption section missing from pretty output"
fi

# ── [2][3] gc on a dead registry entry ────────────────────────────
echo "[2] gc reports, and does not act without --apply"

node -e "
const fs=require('fs');
const p='$MYJARBIS_REGISTRY';
const r=JSON.parse(fs.readFileSync(p,'utf8'));
r.projects['ghost']={name:'ghost',path:'$WORK/ghost-never-existed'};
fs.writeFileSync(p,JSON.stringify(r,null,2));
"
node "$CLI" gc --json > "$WORK/gc1.json" 2>&1 || true
if node -e "process.exit(require('$WORK/gc1.json').items.some(i=>i.kind==='dead-registry'&&i.what==='ghost')?0:1)"; then
  pass "found the dead registry entry"
else
  oops "did not report the dead registry entry"
fi
if grep -q '"ghost"' "$MYJARBIS_REGISTRY"; then
  pass "left it alone without --apply"
else
  oops "removed it without --apply"
fi

echo "[3] gc --apply"
node "$CLI" gc --apply --json > "$WORK/gc2.json" 2>&1 || true
if grep -q '"ghost"' "$MYJARBIS_REGISTRY"; then
  oops "--apply did not remove the dead entry"
else
  pass "--apply removed it"
fi
if ls "$MYJARBIS_REGISTRY".bak-* >/dev/null 2>&1; then
  pass "backed the registry up first"
else
  oops "no registry backup was written"
fi
if grep -q '"alpha"' "$MYJARBIS_REGISTRY"; then
  pass "the live project survived"
else
  oops "the live project was removed too"
fi

# ── [4] rollback copies are never collected ───────────────────────
echo "[4] rollback copies are left alone"

OLD=$(node -e "console.log(new Date(Date.now()-90*86400000).toISOString().replace(/[:.]/g,'-'))")
touch -d '90 days ago' "$WORK/alpha/.myjarbis/memory.db.pre-v4.$OLD"
touch -d '90 days ago' "$WORK/alpha/.myjarbis/memory.db.silo-retired-$OLD"
touch -d '90 days ago' "$WORK/alpha/.myjarbis/memory.db.merged-$OLD"

node "$CLI" gc --json > "$WORK/gc3.json" 2>&1 || true
if node -e "process.exit(require('$WORK/gc3.json').items.some(i=>i.what.includes('pre-v4'))?0:1)"; then
  pass "a 90-day-old pre-v4 backup is collectable"
else
  oops "did not offer to collect an old pre-v4 backup"
fi
if node -e "process.exit(require('$WORK/gc3.json').items.some(i=>i.what.includes('silo-retired')||i.what.includes('.merged-'))?1:0)"; then
  pass "rollback copies are not collectable"
else
  oops "offered to collect a rollback copy"
fi

# Fresh backups are kept.
touch "$WORK/alpha/.myjarbis/memory.db.pre-v4.fresh-2026-01-01T00-00-00-000Z"
node "$CLI" gc --json > "$WORK/gc4.json" 2>&1 || true
if node -e "process.exit(require('$WORK/gc4.json').items.some(i=>i.what.includes('fresh-'))?1:0)"; then
  pass "a backup newer than the threshold is kept"
else
  oops "collected a backup newer than --older-than"
fi

# ── [5] Claude project dirs: only ours, only temp paths ───────────
echo "[5] only removes a MEMORY.md it wrote"

mine="$HOME/.claude/projects/-tmp-gone-proj/memory"
theirs="$HOME/.claude/projects/-tmp-real-work/memory"
mkdir -p "$mine" "$theirs"
printf '# Auto-memory pointer\n\ngenerated\n' > "$mine/MEMORY.md"
printf '# My own notes\n\nhand written\n'     > "$theirs/MEMORY.md"

node "$CLI" gc --json > "$WORK/gc5.json" 2>&1 || true
if node -e "process.exit(require('$WORK/gc5.json').items.some(i=>i.what.includes('-tmp-gone-proj'))?0:1)"; then
  pass "collects a dir holding only a generated MEMORY.md"
else
  oops "did not collect the generated one"
fi
if node -e "process.exit(require('$WORK/gc5.json').items.some(i=>i.what.includes('-tmp-real-work'))?1:0)"; then
  pass "leaves a hand-written MEMORY.md alone"
else
  oops "offered to delete a MEMORY.md it did not write"
fi

# A transcript makes a directory untouchable whatever else is in it.
echo '{}' > "$HOME/.claude/projects/-tmp-gone-proj/session.jsonl"
node "$CLI" gc --json > "$WORK/gc6.json" 2>&1 || true
if node -e "process.exit(require('$WORK/gc6.json').items.some(i=>i.what.includes('-tmp-gone-proj'))?1:0)"; then
  pass "a directory with a transcript is never collected"
else
  oops "offered to delete a directory containing a transcript"
fi

# ── [6] backfill-remotes ──────────────────────────────────────────
echo "[6] backfill-remotes"

node -e "
const {MyJarbisDB}=require('$B/db/index.js');
" 2>/dev/null || true
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const db = MyJarbisDB.openExisting('$WORK/alpha/.myjarbis/memory.db');
const p = db.projects.findByPath('$WORK/alpha');
db.projects.setRemote(p.id, null);
db.close();
"
node "$CLI" backfill-remotes --json > "$WORK/bf1.json" 2>&1 || true
if node -e "process.exit(require('$WORK/bf1.json').updated.some(u=>u.project==='alpha')?0:1)"; then
  pass "reports the project as missing its remote"
else
  oops "did not report alpha: $(cat "$WORK/bf1.json")"
fi

node "$CLI" backfill-remotes --apply --json > "$WORK/bf2.json" 2>&1 || true
GOT=$(node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const db = MyJarbisDB.openExisting('$WORK/alpha/.myjarbis/memory.db');
console.log(db.projects.findByPath('$WORK/alpha').git_remote ?? '');
db.close();
")
if [ -n "$GOT" ]; then
  pass "--apply recorded it ($GOT)"
else
  oops "--apply recorded nothing"
fi

node "$CLI" backfill-remotes --json > "$WORK/bf3.json" 2>&1 || true
if node -e "process.exit(require('$WORK/bf3.json').updated.length===0?0:1)"; then
  pass "a second run is a no-op"
else
  oops "re-reported a project that already records its remote"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v03-maintenance: all assertions passed"
  exit 0
fi
echo "✗ v03-maintenance: $FAILED assertion(s) failed" >&2
exit 1
