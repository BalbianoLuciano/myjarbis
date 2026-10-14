#!/bin/bash
#
# E2E test: a project whose rows live in the shared brain actually resolves
# to it.
#
# This is the layer v0.3 shipped untested. `v03-isolation.sh` builds a shared
# database by calling `projects.create({ isolation: 'shared' })` against a
# loose file and asserts the tenant guard; `v03-migrate-merge.sh` asserts that
# merge copies rows and remaps ids. Neither one ever asks the question a user
# asks: *standing in this directory, which brain do I get?* Everything below
# failed before the fixes it guards, with 138 other assertions green.
#
# It asserts:
#   1. `init --isolation=shared` reaches the CLI at all, seeds the shared
#      brain, and leaves NO silo beside the project
#   2. a later command in that directory still finds no silo, and resolves to
#      the shared brain rather than re-seeding a v0.1 layout
#   3. `merge --retire-source` leaves the project resolving to the shared
#      brain, with its observations
#   4. a merge WITHOUT --retire-source says so, because it otherwise looks
#      successful and changes nothing observable
#   5. `initializeForSeed` honours an explicit dbPath
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/resolve.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-sharedres-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export MYJARBIS_HOME="$WORK/home"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"
SHARED="$WORK/home/memory.db"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

newrepo() {
  mkdir -p "$1" && cd "$1" && git init -q .
  git config user.email t@example.com && git config user.name Test
}

# ── [1] init --isolation=shared ───────────────────────────────────
echo "[1] init --isolation=shared"

newrepo "$WORK/shared-proj"
if "$MJ" init --isolation=shared --yes --skip-memory >"$WORK/init.log" 2>&1; then
  pass "init accepted --isolation=shared"
else
  oops "init rejected --isolation=shared: $(tail -2 "$WORK/init.log")"
fi

if [ -f "$WORK/shared-proj/.myjarbis/memory.db" ]; then
  oops "a silo was created beside a shared project"
else
  pass "no silo created beside the project"
fi

if [ -f "$SHARED" ] && node -e "
  const D = require('$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3');
  const d = new D('$SHARED', { readonly: true });
  const r = d.prepare('SELECT isolation FROM projects WHERE name = ?').get('shared-proj');
  process.exit(r && r.isolation === 'shared' ? 0 : 1);
" 2>/dev/null; then
  pass "project row is in the shared brain, isolation = shared"
else
  oops "project row did not reach the shared brain"
fi

# ── [2] a later command does not re-seed a silo ───────────────────
echo "[2] a later command resolves, and does not re-seed a silo"

cd "$WORK/shared-proj"
"$MJ" status >"$WORK/status.log" 2>&1 || true

if [ -f "$WORK/shared-proj/.myjarbis/memory.db" ]; then
  oops "running a command re-seeded a silo (migrateProject fired on a shared project)"
else
  pass "still no silo after running a command"
fi

if grep -q "home/memory.db" "$WORK/status.log"; then
  pass "status reports the shared brain"
else
  oops "status did not report the shared brain: $(grep -i brain "$WORK/status.log" || echo '(no Brain line)')"
fi

# ── [3] merge --retire-source leaves the project on the shared brain ──
echo "[3] merge --retire-source"

newrepo "$WORK/silo-proj"
"$MJ" init --yes --skip-memory >/dev/null 2>&1

if [ ! -f "$WORK/silo-proj/.myjarbis/memory.db" ]; then
  oops "a default init did not create a silo"
fi

# One observation, so there is something to find on the other side.
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const db = MyJarbisDB.openAtPath('$WORK/silo-proj/.myjarbis/memory.db');
const p = db.projects.findByPath('$WORK/silo-proj');
db.bindScope({ kind: 'project', id: p.id });
const m = db.modules.listByProject(p.id)[0];
const s = db.sessions.start(m.id);
db.observations.add({
  sessionId: s.id,
  kind: 'decision',
  title: 'the needle',
  content: 'findable after the merge',
});
db.close();
"

node "$CLI" merge --from="$WORK/silo-proj/.myjarbis/memory.db" \
  --retire-source >"$WORK/merge.log" 2>&1 || true

if [ -f "$WORK/silo-proj/.myjarbis/memory.db" ]; then
  oops "--retire-source left the source brain in place"
else
  pass "--retire-source renamed the source aside"
fi

if ls "$WORK/silo-proj/.myjarbis/"memory.db.merged-* >/dev/null 2>&1; then
  pass "the source was renamed, not deleted"
else
  oops "the source is gone and no .merged- copy exists"
fi

cd "$WORK/silo-proj"
RESOLVED=$(node --input-type=module -e "
import { resolveProject } from '$B/resolve.js';
const r = resolveProject({ cwd: '$WORK/silo-proj' });
if (!r) { console.log('NONE'); process.exit(0); }
const { db, project } = r;
db.bindScope({ kind: 'project', id: project.id });
const n = db.db.prepare('SELECT count(*) c FROM observations WHERE project_id = ?').get(project.id).c;
console.log(db.dbPath + ' ' + n);
db.close();
" 2>&1 || echo "ERR")

case "$RESOLVED" in
  "$SHARED 1")
    pass "the merged project resolves to the shared brain, with its observation"
    ;;
  NONE)
    oops "the merged project resolves to nothing"
    ;;
  *)
    oops "unexpected resolution: $RESOLVED (wanted '$SHARED 1')"
    ;;
esac

if [ -f "$WORK/silo-proj/.myjarbis/memory.db" ]; then
  oops "resolving re-seeded a silo over the merged project"
else
  pass "resolving did not re-seed a silo"
fi

# ── [4] a merge without --retire-source warns that it did nothing ──
echo "[4] merge without --retire-source warns"

newrepo "$WORK/quiet-proj"
"$MJ" init --yes --skip-memory >/dev/null 2>&1
node "$CLI" merge --from="$WORK/quiet-proj/.myjarbis/memory.db" \
  >"$WORK/merge2.log" 2>&1 || true

if grep -q "retire-source" "$WORK/merge2.log"; then
  pass "warns that the merge has no effect until the source is retired"
else
  oops "merged silently, leaving the source to win resolution"
fi

if [ -f "$WORK/quiet-proj/.myjarbis/memory.db" ]; then
  pass "the source is left in place without --retire-source"
else
  oops "the source was retired without being asked"
fi

# ── [5] initializeForSeed honours an explicit dbPath ──────────────
echo "[5] initializeForSeed honours dbPath"

SEEDPATH=$(node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const ctx = ServerContext.initializeForSeed('$WORK/shared-proj', '$SHARED');
console.log(ctx.db.dbPath);
ctx.close();
" 2>&1 || echo "ERR")

if [ "$SEEDPATH" = "$SHARED" ]; then
  pass "opened the brain it was given, not the silo path"
else
  oops "opened $SEEDPATH, wanted $SHARED"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v03-shared-resolution: all assertions passed"
  exit 0
fi
echo "✗ v03-shared-resolution: $FAILED assertion(s) failed" >&2
exit 1
