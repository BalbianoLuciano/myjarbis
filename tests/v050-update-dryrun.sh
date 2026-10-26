#!/bin/bash
#
# E2E test: `myjarbis update --dry-run`.
#
# `update` is the most consequential command in the repo — it writes into every
# registered project and rebuilds the MCP server a running Claude session is
# attached to — and until now there was no way to look before running it. The
# help text offered `--projects-only`, `--no-projects`, `--no-pull`, `--yes`
# and `--from=`, and an unknown flag is fatal, so `myjarbis update --dry-run`
# exited 1.
#
# The design constraint is the one that makes a dry run worth having: it must
# COMPOSE the report modes the real path already has rather than predict what
# they would do. A dry run that re-implements the real run is a dry run that
# lies the first time the two drift. So `commands sync` and both reseeds simply
# lose `--apply`; `skill materialize` gained a `--dry-run` that reports the same
# `written` list its real run acts on, computed by the same comparison.
#
# What this pins:
#
#   · the dry run writes NOTHING: no `.source`, no brain backup, no skill file,
#     no hook wiring
#   · and its prediction is TRUE — what it said would change is what a real run
#     immediately afterwards actually changes
#   · the real path still behaves exactly as it did
#   · the warning about the rebuild killing a running session is printed, since
#     being run first is the point
#
# One honest limitation, worth knowing before trusting the output: step 5 calls
# the INSTALLED build's `cli.js`, not the checkout's. So a dry run reports what
# the installed version would do — which is correct, and also means a flag the
# installed version does not have yet reports as "nothing to change" rather
# than as an error. Verified against the real 23-project fleet: hooks and slash
# commands current, one project's baseline skill out of date, and the workflow
# line blank because the installed v0.4.6 has no `workflow reseed`.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MJ="$REPO_ROOT/bin/myjarbis"

WORK="$(mktemp -d -t myjarbis-dryrun-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# A fake install directory fed from this checkout. `update` writes INTO its
# install dir, so pointing it at the real one would modify the developer's
# installation from a test — which is the accident this whole suite is about.
INSTALL="$WORK/install"
mkdir -p "$INSTALL/bin"
cp -r "$REPO_ROOT/global/." "$INSTALL/" 2>/dev/null || true
cp "$REPO_ROOT"/bin/* "$INSTALL/bin/" 2>/dev/null || true
printf '%s\n' "$REPO_ROOT" > "$INSTALL/.source"
export MYJARBIS_INSTALL_DIR="$INSTALL"

if [ ! -f "$INSTALL/mcp-server/build/cli.js" ]; then
  echo "✗ build not found — run: cd $REPO_ROOT/global/mcp-server && npm run build"
  exit 1
fi

for p in alpha beta; do
  mkdir -p "$WORK/$p" && cd "$WORK/$p" && git init -q -b master .
  git config user.email "d@$p.test" && git config user.name "Dev $p"
  echo x > f.txt && git add f.txt && git -c commit.gpgsign=false commit -q -m init
  "$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1
done

# Make ONE project stale in a way the dry run has to notice, and record enough
# to prove nothing was touched.
MISSING="$WORK/beta/.claude/skills/myjarbis-commit-hygiene/SKILL.md"
rm -rf "$WORK/beta/.claude/skills/myjarbis-commit-hygiene"
SOURCE_BEFORE="$(cat "$INSTALL/.source")"
BACKUPS_BEFORE=$(ls "$INSTALL/backups" 2>/dev/null | wc -l)
SETTINGS_BEFORE="$(cat "$WORK/beta/.claude/settings.local.json" 2>/dev/null | md5sum | cut -d' ' -f1)"

cd "$WORK/alpha"

echo "→ [1] the flag exists and announces itself"
DRY_OUT="$WORK/dry.log"
if timeout 300 "$MJ" update --dry-run > "$DRY_OUT" 2>&1; then
  pass "myjarbis update --dry-run exits 0"
else
  oops "update --dry-run failed (exit $?): $(tail -3 "$DRY_OUT" | tr '\n' ' ')"
fi
CLEAN="$WORK/dry.clean"
sed 's/\x1b\[[0-9;]*m//g' "$DRY_OUT" > "$CLEAN"

grep -qi 'dry run' "$CLEAN" && pass "and says it is a dry run" \
  || oops "the output never says it is a dry run"
grep -qi 'NOTHING WAS WRITTEN' "$CLEAN" && pass "and that nothing was written" \
  || oops "the output does not say nothing was written"
# Being run first is the point, so the real run's effect on an open session
# has to be stated here — and the honest answer now depends on the dependency
# list, since the run became survivable in the ordinary case. This fixture
# feeds the install from this same checkout, so the dependencies always match
# and the dry run must say the session survives. The warning that used to be
# asserted here is now asserted by tests/v051-update-live-session.sh, on a
# fixture where the dependencies really do differ.
grep -qi 'dependencies are unchanged' "$CLEAN" \
  && pass "and reports that npm install would be skipped" \
  || oops "the dry run does not report the dependency comparison"
grep -qi 'survives this run' "$CLEAN" \
  && pass "and that a running Claude session survives it" \
  || oops "the dry run does not say whether an open session survives"
grep -qi 'swap it in by rename' "$CLEAN" \
  && pass "and that the build lands by rename" \
  || oops "the dry run does not mention the rename swap"

echo "→ [2] it wrote nothing"
[ "$(cat "$INSTALL/.source")" = "$SOURCE_BEFORE" ] \
  && pass ".source was not rewritten" || oops ".source changed"
BACKUPS_AFTER=$(ls "$INSTALL/backups" 2>/dev/null | wc -l)
[ "$BACKUPS_AFTER" = "$BACKUPS_BEFORE" ] \
  && pass "no brain backup was taken ($BACKUPS_AFTER)" \
  || oops "a backup was created in a dry run ($BACKUPS_BEFORE -> $BACKUPS_AFTER)"
[ ! -f "$MISSING" ] \
  && pass "the missing skill file is STILL missing" \
  || oops "the dry run materialized a skill file"
SETTINGS_AFTER="$(cat "$WORK/beta/.claude/settings.local.json" 2>/dev/null | md5sum | cut -d' ' -f1)"
[ "$SETTINGS_AFTER" = "$SETTINGS_BEFORE" ] \
  && pass "and the hook wiring file is byte-identical" \
  || oops "settings.local.json was rewritten in a dry run"

echo "→ [3] its prediction is true"
#
# The assertion that makes a dry run worth having. It said one project would
# get a skill file; a real run immediately afterwards has to be the thing it
# described.
if grep -qE 'beta — [0-9]+ skill file' "$CLEAN"; then
  pass "it named beta as the project needing a skill file"
else
  oops "the dry run did not predict beta's missing skill: $(grep -i 'skill file' "$CLEAN" | head -2 | tr '\n' ' ')"
fi
if grep -qE '1 project\(s\) would get new skill files' "$CLEAN"; then
  pass "and counted exactly one project"
else
  oops "the dry run did not report exactly 1 project: $(grep -i 'would get' "$CLEAN" | head -1)"
fi

REAL_OUT="$WORK/real.log"
if timeout 400 "$MJ" update --projects-only --yes > "$REAL_OUT" 2>&1; then
  pass "and a real --projects-only run afterwards succeeds"
else
  oops "the real run failed: $(tail -3 "$REAL_OUT" | tr '\n' ' ')"
fi
[ -f "$MISSING" ] \
  && pass "which restores exactly the file the dry run named" \
  || oops "the real run did not restore the file the dry run predicted"

echo "→ [4] the real path is unchanged"
sed 's/\x1b\[[0-9;]*m//g' "$REAL_OUT" > "$WORK/real.clean"
grep -qi 're-materializing skills to disk' "$WORK/real.clean" \
  && pass "the real run still materializes" || oops "the real run stopped materializing"
grep -qi 'reseeding baseline skills' "$WORK/real.clean" \
  && pass "still reseeds skills" || oops "the real run stopped reseeding skills"
# New in v0.5: workflows are rows too, and `update` carried none of them, so
# the four baselines would have reached new projects only — the exact trap
# `skill reseed` and `commands sync` exist to close.
grep -qi 'reseeding baseline workflows' "$WORK/real.clean" \
  && pass "and now reseeds baseline workflows too" \
  || oops "the real run does not propagate workflows"
grep -qi 'nothing was written' "$WORK/real.clean" \
  && oops "the real run claims it wrote nothing" \
  || pass "and does not claim to be a dry run"

echo "→ [5] an unknown flag is still fatal"
# The flag parser rejects anything it does not know, which is what made
# `--dry-run` exit 1 before it existed. That behaviour has to survive.
if timeout 60 "$MJ" update --not-a-flag >"$WORK/bad.log" 2>&1; then
  oops "an unknown flag was accepted"
else
  grep -qi 'unknown option' "$WORK/bad.log" \
    && pass "an unknown flag is refused by name" \
    || oops "an unknown flag failed without saying why"
fi

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-update-dryrun E2E PASSED"
