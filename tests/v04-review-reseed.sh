#!/bin/bash
#
# E2E test: review and skill reseed.
#
# Both write to a brain that already holds real work, so the assertions
# that matter are the ones about what they must NOT do:
#
#   · review links notes, it never deletes or merges them
#   · reseed must not touch a skill the project owns — `interaction-style`
#     is composed per project from the user's language and persona, so
#     every project legitimately differs from the baseline and a naive
#     hash comparison flags all of them. Reseeding it would replace that
#     config with a placeholder in every project at once. This test exists
#     because the first draft of the command did exactly that.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/review.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-review-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
DB="$WORK/proj/.myjarbis/memory.db"

# Three notes about one topic, one about another.
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const db = MyJarbisDB.openExisting('$DB');
const p = db.projects.findByPath('$WORK/proj');
db.bindScope({ kind: 'project', id: p.id });
const m = db.modules.listByProject(p.id)[0];
const s = db.sessions.start(m.id);
const add = (kind, title) => db.observations.add({ sessionId: s.id, kind, title, content: title });
add('progress', 'Checkout payment gateway wired to the sandbox credentials');
add('progress', 'Checkout payment gateway wired to production credentials');
add('progress', 'Checkout payment gateway credentials rotated after the leak');
add('decision', 'Chose cursor pagination over offset for the activity feed');
db.close();
"

# ── [1] review groups, and writes nothing without --apply ─────────
echo "[1] review reports"
node "$CLI" review --json > "$WORK/r1.json" 2>&1 || true

if node -e "process.exit(require('$WORK/r1.json').clusters.length===1?0:1)"; then
  pass "found exactly one cluster"
else
  oops "expected 1 cluster, got $(node -e "console.log(require('$WORK/r1.json').clusters.length)")"
fi
if node -e "process.exit(require('$WORK/r1.json').clusters[0].members.length===3?0:1)"; then
  pass "the cluster holds the three related notes"
else
  oops "cluster size wrong"
fi
if node -e "
  const c=require('$WORK/r1.json').clusters[0];
  const cur=c.members.filter(m=>m.role==='current');
  process.exit(cur.length===1 && cur[0].title.includes('rotated')?0:1)"; then
  pass "the newest note is the current one"
else
  oops "wrong note marked current"
fi
if node -e "
  const D=require('$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3');
  const d=new D('$DB',{readonly:true});
  const n=d.prepare('SELECT count(*) c FROM observations WHERE topic_key IS NOT NULL').get().c;
  d.close(); process.exit(n===0?0:1)"; then
  pass "wrote nothing without --apply"
else
  oops "wrote topic_key without --apply"
fi

# ── [2] --apply links, and destroys nothing ───────────────────────
echo "[2] review --apply"
BEFORE=$(node -e "
  const D=require('$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3');
  const d=new D('$DB',{readonly:true});console.log(d.prepare('SELECT count(*) c FROM observations').get().c);d.close();")
node "$CLI" review --apply --json > "$WORK/r2.json" 2>&1 || true
AFTER=$(node -e "
  const D=require('$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3');
  const d=new D('$DB',{readonly:true});console.log(d.prepare('SELECT count(*) c FROM observations').get().c);d.close();")

if [ "$BEFORE" = "$AFTER" ]; then
  pass "no note was deleted or merged ($BEFORE before, $AFTER after)"
else
  oops "note count changed: $BEFORE -> $AFTER"
fi
if node -e "
  const D=require('$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3');
  const d=new D('$DB',{readonly:true});
  const keyed=d.prepare('SELECT count(*) c FROM observations WHERE topic_key IS NOT NULL').get().c;
  const sup=d.prepare('SELECT count(*) c FROM observations WHERE supersedes IS NOT NULL').get().c;
  // One key (the current note), two supersedes links: topic_key is
  // UNIQUE(project_id, topic_key), so it names the live row, not the pile.
  d.close(); process.exit(keyed===1 && sup===2 ? 0 : 1)"; then
  pass "the current note is keyed, 2 supersedes links chained"
else
  oops "linking wrong"
fi
if node -e "
  const D=require('$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3');
  const d=new D('$DB',{readonly:true});
  const n=d.prepare(\"SELECT count(*) c FROM observations WHERE kind='decision' AND topic_key IS NOT NULL\").get().c;
  d.close(); process.exit(n===0?0:1)"; then
  pass "the unrelated note was left alone"
else
  oops "grouped a note of a different kind"
fi

node "$CLI" review --json > "$WORK/r3.json" 2>&1 || true
if node -e "process.exit(require('$WORK/r3.json').clusters.length===0?0:1)"; then
  pass "a second run has nothing left to group"
else
  oops "re-reported already grouped notes"
fi

# ── [3] reseed refuses to overwrite what the project owns ─────────
echo "[3] skill reseed"

MINE="PERSONALISED BY THE USER — must survive"
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const db = MyJarbisDB.openExisting('$DB');
const p = db.projects.findByPath('$WORK/proj');
db.bindScope({ kind: 'project', id: p.id });
db.skills.upsert({ projectId: p.id, name: 'interaction-style', content: '$MINE' });
db.skills.upsert({ projectId: p.id, name: 'commit-hygiene', content: 'STALE COPY' });
db.close();
"

node "$CLI" skill reseed --json > "$WORK/s1.json" 2>&1 || true
if node -e "
  const r=require('$WORK/s1.json').results[0];
  const all=[...r.updated,...r.inserted];
  process.exit(all.includes('commit-hygiene') && !all.includes('interaction-style') ? 0 : 1)"; then
  pass "offers commit-hygiene, never interaction-style"
else
  oops "reseed targeted a skill the project owns"
fi

node "$CLI" skill reseed --apply --json > "$WORK/s2.json" 2>&1 || true
GOT=$(node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const db = MyJarbisDB.openExisting('$DB');
const p = db.projects.findByPath('$WORK/proj');
db.bindScope({ kind: 'project', id: p.id });
console.log(db.skills.findByName(p.id, null, 'interaction-style').content);
db.close();
")
if [ "$GOT" = "$MINE" ]; then
  pass "the user's interaction-style survived --apply"
else
  oops "reseed overwrote the user's interaction-style"
fi

# Assert the row EQUALS the baseline, not that it contains some phrase.
# This used to grep for 'Dónde:', which made the assertion depend on the
# baseline's wording — editing the skill turned the test red without
# anything being broken.
if node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
import { BASELINE_SKILLS } from '$B/db/migrate.js';
const db = MyJarbisDB.openExisting('$DB');
const p = db.projects.findByPath('$WORK/proj');
db.bindScope({ kind: 'project', id: p.id });
const c = db.skills.findByName(p.id, null, 'commit-hygiene').content;
db.close();
const baseline = BASELINE_SKILLS.find((s) => s.name === 'commit-hygiene').content;
process.exit(c !== 'STALE COPY' && c === baseline ? 0 : 1);
"; then
  pass "commit-hygiene was refreshed from the baseline"
else
  oops "commit-hygiene was not refreshed"
fi

node "$CLI" skill reseed --json > "$WORK/s3.json" 2>&1 || true
if node -e "
  const r=require('$WORK/s3.json').results[0];
  process.exit(r.updated.length===0 && r.inserted.length===0 ? 0 : 1)"; then
  pass "a second reseed is a no-op"
else
  oops "re-offered a baseline that is already current"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v04-review-reseed: all assertions passed"
  exit 0
fi
echo "✗ v04-review-reseed: $FAILED assertion(s) failed" >&2
exit 1
