#!/bin/bash
#
# E2E test: sessions close themselves.
#
# `sessions.summary` was NULL on 2 of 2 sessions in one real project and 2
# of 10 in another, and this repository's own brain has five modules with
# three sessions, none closed. The cost is not a missing paragraph: `resume`
# returns nothing and `list_modules` reports hasNextSession=false and
# lastSessionEndedAt=null for every module, which is the signal used both to
# pick up where you left off AND to choose which module to open.
#
# The old mitigation was a Stop hook printing a reminder for the agent. This
# tests the replacement, which does not depend on the agent remembering:
#
#   1. a session with work gets closed on SessionEnd, with a summary built
#      from its observations and the commits made during it
#   2. project_state, when set, becomes the resume point — it is the one
#      field written deliberately to say where things stand
#   3. when NO hook fires at all (killed terminal, crash, reboot) the next
#      start_session closes it retroactively, so the guarantee does not
#      depend on a clean exit
#   4. a session the agent closed properly is NEVER overwritten, including
#      when an auto-close lands in the same second — `ended_at` has
#      one-second granularity, so that tie is ordinary rather than rare
#   5. generated text is labelled, and the agent is told it is generated
#   6. the opt-out is honoured
#   7. a curated handoff with auto-closes stacked ON TOP of it is still
#      reachable. Automatic closing is always the newest close, so it wins
#      every "last closed session" lookup and pushes the real handoff one
#      level down per occurrence. Seen in a real module: a 3538-char handoff,
#      then two sessions left open on later days, auto-closed with 292 and
#      124 chars of synthetic text. The agent read the emptiest of the three
#      and told the user there was no resume point.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/tools/autoClose.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-autoclose-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export MYJARBIS_HOME="$WORK/home"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Assertions produced by a node block are read back through a FILE, not a pipe.
#
# `cmd | while read ... oops` puts the loop in a subshell, so every
# FAILED=$((FAILED+1)) inside it is discarded when the subshell exits. The
# suite printed the ✗ lines and then exited 0 anyway, which means none of the
# assertions made this way could ever turn the suite red. Found by reverting a
# real fix and watching six ✗ lines still report "all assertions passed".
ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}


mkdir -p "$WORK/proj"
cd "$WORK/proj"
git init -q .
git config user.email t@example.com
git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
echo seed > a.txt && git add -A && git commit -qm "chore: seed the repo"

# ─── 1. work happens, the agent never closes ───
echo "→ [1] a session with work, left open, closed by the hook"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'decision', title:'Use a materialised view for the nightly rollup', content:'WHY: the join timed out past a million rows.' });
saveObservation(ctx, { kind:'gotcha',   title:'The nightly job runs in UTC, not local time', content:'WHY: off-by-one at month boundaries.' });
saveObservation(ctx, { kind:'progress', title:'Closed API-12: rollup endpoint shipped', content:'Behind a flag.' });
ctx.close();
"

# The commit the summary is supposed to report has to land AFTER the session
# opened, because `commitsSince` asks git for `--since <session start>`. This
# used to be committed before the session, and passed only when the commit and
# the session start happened to fall inside the same second — `--since` is
# inclusive at one-second granularity. It was a coin flip that the suite could
# not report either way, because the assertion ran inside a pipe.
echo rollup > b.txt && git add b.txt && git commit -qm "feat(api): add the rollup endpoint"

# Before: this is the state the project has been living in.
BEFORE=$(node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
console.log(JSON.stringify(resume(ctx, { module: '_general' }).hasNextSession));
ctx.close();
")
[ "$BEFORE" = "false" ] \
  && pass "before the hook, resume has nothing to return" \
  || oops "expected hasNextSession=false before closing, got $BEFORE"

node "$CLI" hook session-end >/dev/null 2>&1

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
import { listModules } from '$B/tools/discovery.js';
const ctx = ServerContext.initialize();
const r = resume(ctx, { module: '_general' });
const m = listModules(ctx, {}).modules.find((x) => x.name === '_general');
const out = [];
const t = (c, msg) => out.push((c ? 'PASS|' : 'FAIL|') + msg);

t(r.hasNextSession === true, 'resume now returns a next_session');
t(m.lastSessionEndedAt !== null, 'list_modules reports lastSessionEndedAt');
t(m.hasNextSession === true, 'list_modules reports hasNextSession — the module-picking signal');
t(r.summary.startsWith('[auto]'), 'the summary is labelled [auto]');
t(/1 decision, 1 gotcha, 1 progress/.test(r.summary), 'the summary counts what was saved, by kind');
t(/rollup endpoint/.test(r.summary), 'the summary names the observations');
t(/feat\(api\): add the rollup endpoint/.test(r.summary), 'the summary includes commits made during the session');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# ─── 2. project_state becomes the resume point ───
echo "→ [2] with project_state set, that becomes the resume point"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { setProjectState } from '$B/tools/state.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
setProjectState(ctx, { content: 'On release/2.1. Rollup is hourly behind ROLLUP_V2. NEXT: enable the flag in staging.' });
ctx.close();
"
node "$CLI" hook session-end >/dev/null 2>&1
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const r = resume(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(/ROLLUP_V2/.test(r.nextSession), 'the living state is used verbatim as the resume point');
t(/set deliberately/.test(r.nextSession), 'and is marked as the trustworthy source');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# ─── 3. no hook fires at all ───
echo "→ [3] no hook fires (killed terminal): the next start_session closes it"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'error', title:'Flag rollout stuck on a config cache', content:'WHY: cached 5 minutes.' });
ctx.close(); // process dies here; no hook runs
"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const s = startSession(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(s.autoClosedPrevious !== undefined, 'start_session reports it closed a stale session');
t(s.autoClosedPrevious?.observations === 1, 'and counted its observations');
t(/MACHINE-WRITTEN/.test(s.hint ?? ''), 'the hint warns the agent the resume point is generated');
t(/auto-closed/.test(s.hint ?? ''), 'and tells it to say so to the user');
const p = ctx.requireProject();
t(ctx.db.sessions.listOpenByProject(p.id).length === 1,
  'exactly one session open afterwards: the new one');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# ─── 4. a curated close is never overwritten, even on a same-second tie ───
echo "→ [4] a curated close wins, including against a same-second auto-close"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession, resume } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
// Leave one session open so the NEXT start_session auto-closes it in the
// same second that the curated session is created and closed. ended_at is
// only second-granular, so without an id tie-break resume could return
// either of the two — and it returned the wrong one before the fix.
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'discovery', title:'dangling session marker', content:'x' });
startSession(ctx, { module: '_general' });
endSession(ctx, { summary: 'Shipped the hourly rollup and verified it in staging.',
                  next_session: 'Ask for sign-off on API-12, then enable ROLLUP_V2 in prod.' });
const r = resume(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(!r.summary.startsWith('[auto]'), 'resume returns the CURATED summary, not the auto one');
t(/verified it in staging/.test(r.summary), 'and it is the right curated summary');
t(/sign-off on API-12/.test(r.nextSession), 'with the curated next_session');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# A properly closed session leaves the hook nothing to do.
OUT=$(node "$CLI" hook session-end 2>&1)
echo "$OUT" | grep -q "no open session to close" \
  && pass "with nothing open, the hook is a no-op" \
  || oops "the hook did something unexpected: $(echo "$OUT" | head -1)"

# ─── 5. opt-out ───
echo "→ [5] settings.session.auto_close_on_exit = false is honoured"
node -e "
const fs = require('fs'), p = '.myjarbis/config/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.session = { ...(s.session || {}), auto_close_on_exit: false };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
ctx.close();
"
node "$CLI" hook session-end >/dev/null 2>&1
REMAIN=$(node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const ctx = ServerContext.initialize();
console.log(ctx.db.sessions.listOpenByProject(ctx.requireProject().id).length);
ctx.close();
")
[ "$REMAIN" = "1" ] \
  && pass "the session stays open when the setting is off" \
  || oops "expected the session to stay open, $REMAIN remained"

# ─── 6. the hook is wired into the plugin ───
echo "→ [6] SessionEnd is registered, and is not Stop"
node -e "
const d = require('$WORK/proj/.claude-plugin/hooks/hooks.json');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(Array.isArray(d.hooks.SessionEnd), 'hooks.json registers SessionEnd');
t(/session-end\.sh/.test(JSON.stringify(d.hooks.SessionEnd)), 'pointing at session-end.sh');
t(!/session-end\.sh/.test(JSON.stringify(d.hooks.Stop)),
  'and Stop does NOT close sessions — it fires every turn');
console.log(out.join('\n'));
" > "$ASSERTS"
read_asserts
[ -x "$WORK/proj/.claude-plugin/scripts/session-end.sh" ] \
  && pass "session-end.sh is executable in the provisioned project" \
  || oops "session-end.sh missing or not executable"

# ─── 7. a curated handoff is reachable under a stack of auto-closes ───
#
# A fresh project, because this exercises the fallback branches of
# composeNextSession: proj has project_state set by [2], and that branch
# deliberately carries no pointer (a living state set on purpose is more
# current than an older handoff).
echo "→ [7] two auto-closes on top of a curated handoff, which is still reachable"
mkdir -p "$WORK/proj2"
cd "$WORK/proj2"
git init -q .
git config user.email t@example.com
git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1

# The curated handoff.
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'progress', title:'Closed BILL-7: invoice export', content:'Behind a flag.' });
endSession(ctx, { summary: 'Shipped the invoice export and verified the CSV byte-for-byte.',
                  next_session: 'CURATED HANDOFF: get sign-off on BILL-7, then turn on EXPORT_V2 for the pilot tenant.' });
ctx.close();
"
# Two sessions left open on later days, each closed by the hook. This is the
# shape that buried the real handoff: every auto-close is the newest close.
for n in 1 2; do
  node --input-type=module -e "
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  saveObservation(ctx, { kind:'progress', title:'poked at the exporter, nothing written up', content:'x' });
  ctx.close();
  "
  node "$CLI" hook session-end >/dev/null 2>&1
done

# Age the curated close by 20 days. Without this the whole chain is same-day
# and the staleness assertion below could not tell the two clocks apart —
# which is the second half of the bug: an auto-close that ran today sets
# previousSession.daysSinceClose to 0 for a handoff that is weeks old.
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const ctx = ServerContext.initialize();
const p = ctx.requireProject();
const m = ctx.db.modules.listByProject(p.id).find((x) => x.name === '_general');
const curated = ctx.db.sessions.findLastCuratedByModule(m.id);
ctx.db.db.prepare(\"UPDATE sessions SET ended_at = datetime('now','-20 days') WHERE id = ?\").run(curated.id);
ctx.close();
"

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const r = resume(ctx, { module: '_general' });
const s = startSession(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

t(s.previousSession.nextSession.startsWith('[auto]'),
  'previousSession is the machine-written close, as before');
t(s.curatedResume !== undefined, 'start_session surfaces curatedResume');
t(/CURATED HANDOFF/.test(s.curatedResume?.nextSession ?? ''),
  'and it is the handoff a human wrote');
t(s.curatedResume?.buriedUnder === 2, 'reporting it was buried under 2 automatic closes');
t(/verified the CSV/.test(s.curatedResume?.summary ?? ''),
  'with the curated summary alongside it');
t(/curatedResume/.test(s.hint ?? ''), 'the hint points the agent at curatedResume');
t(s.curatedResume?.stale === true,
  'the curated handoff is stale on ITS OWN clock (20 days)');
t(s.previousSession.stale === false,
  'while previousSession is not — the automatic close reset that clock');
t(/session #/.test(s.previousSession.nextSession),
  'the synthetic text itself points back at the curated session');
t(r.curatedResume !== undefined, 'resume surfaces it too');
t(/CURATED HANDOFF/.test(r.curatedResume?.nextSession ?? ''), 'and the same text');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# The hook output is what the USER reads, and it was showing the empty one.
HOOKOUT=$(node "$CLI" hook session-start 2>/dev/null)
echo "$HOOKOUT" | grep -q "CURATED HANDOFF" \
  && pass "the SessionStart hook prints the curated handoff, not the synthetic one" \
  || oops "the hook still shows the machine-written resume point"
echo "$HOOKOUT" | grep -qi "automátic\|automatic\|automát" \
  && pass "and says the newest close was automatic" \
  || oops "the hook does not explain why an older note is being shown"

# A curated close on top of auto-closes goes back to the normal path.
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession, resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
endSession(ctx, { summary: 'Wrote it up properly this time.', next_session: 'NEWEST CURATED: enable EXPORT_V2 everywhere.' });
const r = resume(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(/NEWEST CURATED/.test(r.nextSession), 'resume returns the newest curated handoff');
t(r.curatedResume === undefined,
  'and curatedResume is absent — nothing is buried, so nothing is duplicated');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v03-auto-close E2E PASSED"
