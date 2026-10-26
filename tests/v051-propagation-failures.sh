#!/usr/bin/env bash
#
# v0.5.1 — a propagation step that FAILS must say so, and must not be
# reported as success one layer up.
#
# The defect this exists for, found by running the real thing on a real fleet:
#
#   `myjarbis update --dry-run` promised "4 created" for every project.
#   `myjarbis update --projects-only` then printed "nothing to change".
#   `SELECT COUNT(*) FROM workflows` returned 0.
#
# Three independent faults lined up to produce that, and each one is
# individually enough to hide a total failure, so each is asserted separately:
#
#   1. The brain was on schema v4, where `workflows.standalone` and
#      `workflow_steps.uses` do not exist, so every INSERT failed. The error
#      surfaced as a caught `table workflows has no column named standalone`
#      — true, and useless to the person reading it. (That exact wording is
#      what SQLite emits for a failing INSERT; `no such column: ...` is the
#      SELECT-side phrasing, and an assertion written against it greps for a
#      string that can never appear.)
#   2. `workflow reseed` exited 0 anyway, so no caller could detect it.
#   3. `bin/myjarbis-update` discarded the status with `|| true` AND filtered
#      the output through a vocabulary of SUCCESS words
#      ("created|extended|left alone|unchanged"), so the error lines were
#      dropped and the fallback message was printed.
#
# A dry run cannot catch this by construction: comparing needs no INSERT, so
# the dry run was honest and the real run was not. That is why the assertions
# below are about the REAL run, with --apply.
#
# The v4 brain in the fixture is made v4 in BOTH ways a real one is: the meta
# row says 4 and the v5 columns are actually gone. So if the schema guard is
# removed the INSERT still fails, and these assertions still hold — for the
# right reason — instead of passing because the guard was the only thing
# being tested.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$REPO_ROOT/global/mcp-server/build/cli.js"

WORK="$(mktemp -d -t myjarbis-propfail-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

if [ ! -f "$CLI" ]; then
  echo "✗ build not found — run: cd $REPO_ROOT/global/mcp-server && npm run build"
  exit 1
fi

INSTALL="$WORK/install"
mkdir -p "$INSTALL/bin"
cp -r "$REPO_ROOT/global/." "$INSTALL/" 2>/dev/null || true
cp "$REPO_ROOT"/bin/* "$INSTALL/bin/" 2>/dev/null || true
printf '%s\n' "$REPO_ROOT" > "$INSTALL/.source"
export MYJARBIS_INSTALL_DIR="$INSTALL"

for p in alpha beta; do
  mkdir -p "$WORK/$p" && cd "$WORK/$p" && git init -q -b master .
  git config user.email "d@$p.test" && git config user.name "Dev $p"
  echo x > f.txt && git add f.txt && git -c commit.gpgsign=false commit -q -m init
  "$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1
done

BRAIN="$MYJARBIS_HOME/memory.db"
[ -f "$BRAIN" ] || { echo "✗ no brain at $BRAIN"; exit 1; }

# ── helper: query the brain through the build's own better-sqlite3 ──
cat > "$WORK/q.mjs" <<'QEOF'
import Database from 'better-sqlite3';
const db = new Database(process.env.BRAIN);
const rows = db.prepare(process.argv[2]).all();
console.log(JSON.stringify(rows));
QEOF
q() { BRAIN="$BRAIN" node --input-type=module -e "
  import Database from '$REPO_ROOT/global/mcp-server/node_modules/better-sqlite3/lib/index.js';
  const db = new Database('$BRAIN');
  console.log(JSON.stringify(db.prepare(\`$1\`).all()));
"; }

exec_sql() { BRAIN="$BRAIN" node --input-type=module -e "
  import Database from '$REPO_ROOT/global/mcp-server/node_modules/better-sqlite3/lib/index.js';
  const db = new Database('$BRAIN');
  db.exec(\`$1\`);
"; }

echo "→ [0] the fixture is a genuine v4 brain, in both senses"
# Clear any workflows a v5 init seeded, then take the brain back to v4.
exec_sql "DELETE FROM workflow_steps; DELETE FROM workflows;"
exec_sql "ALTER TABLE workflows DROP COLUMN standalone;"
exec_sql "ALTER TABLE workflow_steps DROP COLUMN uses;"
exec_sql "UPDATE meta SET value = '4' WHERE key LIKE '%schema%';"

SCHEMA="$(q "SELECT value AS v FROM meta WHERE key LIKE '%schema%'" | grep -o '"v":"[0-9]*"' | grep -o '[0-9]*')"
[ "$SCHEMA" = "4" ] && pass "meta reports schema v4" || oops "meta says '$SCHEMA', not 4"
q "SELECT name FROM pragma_table_info('workflows')" | grep -q 'standalone' \
  && oops "workflows.standalone still exists — the fixture is not v4" \
  || pass "workflows.standalone is genuinely absent"
WF_BEFORE="$(q "SELECT COUNT(*) AS c FROM workflows" | grep -o '[0-9]*')"
[ "$WF_BEFORE" = "0" ] && pass "no workflow rows to start with" || oops "$WF_BEFORE rows already present"

cd "$WORK/alpha"

# ── [1] the reseed refuses, actionably, and exits non-zero ──
echo "→ [1] workflow reseed --apply on a v4 brain fails LOUDLY"
RS_OUT="$WORK/reseed.log"
"$MJ" workflow reseed --all --apply > "$RS_OUT" 2>&1 && RS_RC=0 || RS_RC=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$RS_OUT"

[ "$RS_RC" != "0" ] \
  && pass "it exits non-zero ($RS_RC) — a caller can detect this" \
  || oops "it exited 0 on a run that could not write a single row"
grep -qi 'FAILED' "$RS_OUT" \
  && pass "and the word FAILED appears in the output" \
  || oops "the output does not say it failed: $(head -5 "$RS_OUT" | tr '\n' ' ')"
grep -qi 'migrate' "$RS_OUT" \
  && pass "and it names the remedy (migrate)" \
  || oops "the message does not tell the reader what to run"
grep -qiE 'schema v4|needs? v5' "$RS_OUT" \
  && pass "and names the schema as the cause" \
  || oops "the message does not explain why"
grep -qi 'has no column named' "$RS_OUT" \
  && oops "it leaks the raw SQLite error instead of explaining" \
  || pass "and does NOT leak a raw SQLite message"

WF_AFTER="$(q "SELECT COUNT(*) AS c FROM workflows" | grep -o '[0-9]*')"
[ "$WF_AFTER" = "0" ] \
  && pass "and wrote NOTHING (still 0 rows)" \
  || oops "it wrote $WF_AFTER row(s) on a run it reported as failed"

# ── [2] the update must not launder that into "nothing to change" ──
echo "→ [2] update --projects-only surfaces it instead of hiding it"
UP_OUT="$WORK/update.log"
"$MJ" update --projects-only < /dev/null > "$UP_OUT" 2>&1 && UP_RC=0 || UP_RC=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$UP_OUT"

# The exact string the bug printed. Its presence anywhere near the workflow
# step is the regression.
if grep -A2 -i 'reseeding baseline workflows' "$UP_OUT" | grep -qi 'nothing to change'; then
  oops "the workflow step STILL reports 'nothing to change' on a total failure"
else
  pass "the workflow step no longer says 'nothing to change'"
fi
grep -qi 'FAIL' "$UP_OUT" \
  && pass "a FAIL line is printed" \
  || oops "the update output contains no FAIL: $(grep -i workflow "$UP_OUT" | head -3 | tr '\n' ' ')"
grep -qi 'migrate' "$UP_OUT" \
  && pass "and the remedy survives into the update's output" \
  || oops "the actionable message was filtered out by the reporter"
[ "$UP_RC" != "0" ] \
  && pass "and the update itself exits non-zero ($UP_RC)" \
  || oops "update exited 0 though a propagation step failed"
grep -qi 'failed propagation step' "$UP_OUT" \
  && pass "and the closing line is not a plain 'Done'" \
  || oops "the run still ends as though everything worked"

# ── [2b] every OTHER v5 feature refuses the same way ──
#
# The reseed was found by running it. The audit that followed found that NO
# v5 path had a schema check: `org/sync.ts` guards on v4, which is right for
# the `orgs` table but wrong for `org_notes`, and the org memory and workflow
# runs had none at all. So a user who updates and does not migrate gets a raw
# SQLite error from whichever one they touch first.
#
# The guard now lives on the ACCESSOR, so this asserts the door rather than
# each room — a method added to either accessor tomorrow is covered.
echo "→ [2b] the other v5 features refuse on v4 with the same remedy"
exec_sql "DELETE FROM workflow_steps; DELETE FROM workflows;"
exec_sql "UPDATE meta SET value = '4' WHERE key LIKE '%schema%';"

for cmd in "org notes" "org push" "workflow runs"; do
  C_OUT="$WORK/v4-$(echo "$cmd" | tr ' ' '-').log"
  # shellcheck disable=SC2086
  "$MJ" $cmd > "$C_OUT" 2>&1 && C_RC=0 || C_RC=$?
  sed -i 's/\x1b\[[0-9;]*m//g' "$C_OUT"
  # Either it refuses for the schema, or it refuses EARLIER for a reason that
  # is also actionable (NO_ORG — this fixture joined no org). What must never
  # happen is a raw SQLite column message reaching the user.
  if grep -qi 'has no column named\|no such table\|no such column' "$C_OUT"; then
    oops "\`myjarbis $cmd\` leaked a raw SQLite error on a v4 brain"
  else
    pass "\`myjarbis $cmd\` did not leak a raw SQLite error"
  fi
  if grep -qiE 'migrate|NO_ORG|belongs to no org' "$C_OUT"; then
    pass "  and said something the reader can act on"
  else
    oops "  but said nothing actionable: $(head -3 "$C_OUT" | tr '\n' ' ')"
  fi
done

# And the guard itself, asserted directly rather than through a command that
# might refuse for an unrelated reason first.
GUARD_OUT="$WORK/guard.log"
BRAIN="$BRAIN" node --input-type=module -e "
  import { MyJarbisDB } from '$REPO_ROOT/global/mcp-server/build/db/index.js';
  const db = MyJarbisDB.openExisting('$BRAIN');
  try {
    db.orgNotes.ttlDays;
    console.log('NO REFUSAL');
  } catch (e) {
    console.log('REFUSED:', e.type || '', e.message);
  }
" > "$GUARD_OUT" 2>&1 || true
grep -q 'SCHEMA_TOO_OLD' "$GUARD_OUT" \
  && pass "touching db.orgNotes on a v4 brain throws SCHEMA_TOO_OLD" \
  || oops "the accessor guard did not fire: $(head -3 "$GUARD_OUT" | tr '\n' ' ')"
grep -qi 'myjarbis migrate' "$GUARD_OUT" \
  && pass "and the message names the command that fixes it" \
  || oops "the guard message does not name migrate"

# ── [3] the happy path is untouched ──
echo "→ [3] after migrating, the same commands succeed and say so"
MIG_OUT="$WORK/migrate.log"
"$MJ" migrate --yes > "$MIG_OUT" 2>&1 || "$MJ" migrate > "$MIG_OUT" 2>&1
SCHEMA2="$(q "SELECT value AS v FROM meta WHERE key LIKE '%schema%'" | grep -o '"v":"[0-9]*"' | grep -o '[0-9]*')"
[ "$SCHEMA2" = "5" ] \
  && pass "migrate took the fixture to v5" \
  || oops "the brain is on '$SCHEMA2' after migrate — the rest of [3] proves nothing"

RS2="$WORK/reseed2.log"
"$MJ" workflow reseed --all --apply > "$RS2" 2>&1 && RS2_RC=0 || RS2_RC=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$RS2"
[ "$RS2_RC" = "0" ] \
  && pass "the reseed now exits 0" \
  || oops "the reseed still fails after migrating (exit $RS2_RC): $(head -5 "$RS2" | tr '\n' ' ')"
grep -qi 'FAILED' "$RS2" \
  && oops "it reports FAILED on a run that should have worked" \
  || pass "and reports no failure"
WF_FINAL="$(q "SELECT COUNT(*) AS c FROM workflows" | grep -o '[0-9]*')"
[ "$WF_FINAL" -gt 0 ] \
  && pass "and the rows actually landed ($WF_FINAL workflows)" \
  || oops "still 0 rows after a successful reseed on a v5 brain"

UP2="$WORK/update2.log"
"$MJ" update --projects-only < /dev/null > "$UP2" 2>&1 && UP2_RC=0 || UP2_RC=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$UP2"
[ "$UP2_RC" = "0" ] \
  && pass "and the update exits 0 again" \
  || oops "update still fails on a healthy fleet (exit $UP2_RC)"
grep -qi 'failed propagation step' "$UP2" \
  && oops "it claims a failed step on a healthy run" \
  || pass "and closes as Done"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "PASS  v051-propagation-failures"
  exit 0
fi
echo "FAIL  v051-propagation-failures ($FAILED assertion(s))" >&2
exit 1
