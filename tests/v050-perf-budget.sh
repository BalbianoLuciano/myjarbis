#!/bin/bash
#
# E2E test: budgets. What the agent waits for, and what it is made to read.
#
# `v03-benchmark.sh` measures and reports; nothing has ever FAILED on cost.
# That is the shape this repository has already paid for once: `doctor` passed
# green for months on hooks that never ran, because it asserted a file existed
# rather than that anything worked. A number nobody gates is a number that
# drifts.
#
# Two kinds of assertion here, and they are not equally trustworthy:
#
#   SIZE assertions are exact and cannot flake. Bytes are what become tokens,
#   so they are also the ones that matter most.
#
#   TIME assertions are set well above the measured value, because the point is
#   catching a regression of an order of magnitude, not defending a
#   sub-millisecond operation. A performance gate that flakes on a loaded
#   machine is a gate somebody deletes, and then there is no gate.
#
# The first two sections are the ones worth having. They answer "does my
# agent's context grow because of things it does not need" with a byte-exact
# comparison rather than with an opinion:
#
#   · the bootstrap payload must be IDENTICAL with 0 org notes and with 500
#   · the bootstrap payload must be IDENTICAL in a registry of 1 and of 50
#
# ─── why the JS lives in a file rather than in `node -e "..."` ───
#
# Every other suite passes its assertions as a double-quoted bash string. That
# works until the JS wants a backtick (bash runs it as a command — silently,
# see observation 1559), a `$` (expanded), or anything resembling command
# substitution. This suite's blocks are long enough that the hazard is a
# certainty rather than a risk: one of them silently acquired the output of a
# `git status` from elsewhere in the script and failed with
# `SyntaxError: Unexpected identifier 'files'`.
#
# So the JS is written with a QUOTED heredoc — no shell expansion at all — and
# the paths it needs arrive through the environment. The cost is one `import()`
# per module instead of a static import; the benefit is that the text node runs
# is exactly the text written here.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/db/index.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-perf-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

ASSERTS="$WORK/asserts.out"
BLOCK="$WORK/block.mjs"

# Assertions cross back through a FILE, never a pipe: `cmd | while read` puts
# the loop in a subshell and every FAILED++ is discarded on exit, so the suite
# prints ✗ lines and still exits 0.
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}

# Reads JS from stdin, runs it with the build path in the environment.
run_block() {
  local label="$1"
  cat > "$BLOCK"
  if ! MJ_BUILD="$B" MJ_WORK="$WORK" MJ_REG="$MYJARBIS_REGISTRY" \
       node "$BLOCK" > "$ASSERTS" 2>"$WORK/err.$label"; then
    echo "    ✗ $label crashed"
    sed 's/^/      /' "$WORK/err.$label" >&2
    FAILED=$((FAILED + 1))
    : > "$ASSERTS"
  fi
  read_asserts
}

mkdir -p "$WORK/app" && cd "$WORK/app" && git init -q -b master .
git config user.email p@p.test && git config user.name 'Perf Dev'
git remote add origin git@github.com:example/app.git
echo x > f.txt && git add f.txt && git -c commit.gpgsign=false commit -q -m init
"$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1
for m in auth catalog checkout; do
  "$MJ" module add "$m" --description="the $m vertical, with a description long enough to be worth clipping" >/dev/null 2>&1
done

echo "→ [1] the bootstrap does not grow with the org memory"
run_block bootstrap-vs-org <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession, endSession } = await import(B + '/tools/session.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

// Volatile by construction: a session id, the clock, and the id of the
// previous session. Comparing raw payloads compares those too, which is how
// the first version of this assertion "failed" on two identical bootstraps.
// Normalised, then compared BOTH ways: the shape, and the byte length — the
// first catches a field appearing, the second catches one growing.
const norm = (s) => JSON.stringify({
  ...s,
  sessionId: 0,
  startedAt: '',
  previousSession: s.previousSession
    ? { ...s.previousSession, id: 0, endedAt: '', daysSinceClose: 0 }
    : null,
  curatedResume: s.curatedResume ? { ...s.curatedResume, sessionId: 0, endedAt: '' } : undefined,
  autoClosedPrevious: s.autoClosedPrevious ? { sessionId: 0 } : undefined,
});

const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();

  // A throwaway session first, so BOTH measurements have a previousSession to
  // report. Without it the second payload legitimately carries a handoff the
  // first could not, and the comparison measures the fixture rather than the
  // feature — which is exactly what the first version of this test did.
  // The SAME handoff text as every later close, so previousSession is constant
  // too. With different text the payload differs by the length of the string
  // the fixture happened to pick — which is what the second version measured.
  startSession(ctx, { module: '_general' });
  endSession(ctx, { summary: 'a', next_session: 'b' });

  // Measured with NO org at all: the state every project on this machine is in.
  let s = startSession(ctx, { module: '_general' });
  const noOrg = norm(s);
  const noOrgBytes = JSON.stringify(s).length;
  endSession(ctx, { summary: 'a', next_session: 'b' });

  // Join an org and fill it with 500 notes — more than a team promotes in a year.
  const org = ctx.db.orgs.upsert({ slug: 'acme', name: 'Acme' });
  ctx.db.projects.setOrg(project.id, org.id);
  for (let i = 0; i < 500; i++) {
    const draft = {
      question: 'question number ' + i + ' about something a team learned',
      answer: 'the answer, several sentences long because a real one is. '.repeat(4),
      caveats: 'only when the thing is true',
      typeTags: 'gotcha',
    };
    ctx.db.orgNotes.add({
      orgId: org.id,
      projectId: i % 2 === 0 ? project.id : null,
      author: { handle: 'ana', email: null, source: 'git' },
      draft,
      contentHash: ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: null, draft }),
    });
  }
  t(ctx.db.orgNotes.countByOrg(org.id) === 500, '500 org notes are in the mirror');

  s = startSession(ctx, { module: '_general' });
  const withOrg = norm(s);
  const withOrgBytes = JSON.stringify(s).length;
  endSession(ctx, { summary: 'a', next_session: 'b' });

  t(noOrg === withOrg,
    noOrg === withOrg
      ? 'the session payload is IDENTICAL with 0 and with 500 org notes, field for field'
      : 'the session payload changed with the org memory: ' + noOrg + ' -> ' + withOrg);
  t(noOrgBytes === withOrgBytes,
    noOrgBytes === withOrgBytes
      ? 'and the same size (' + noOrgBytes + ' B)'
      : 'and grew: ' + noOrgBytes + ' -> ' + withOrgBytes + ' B');

  // And the notes ARE reachable — otherwise the assertion above is satisfied by
  // the feature being broken rather than by it being scoped.
  const hits = ctx.db.search('question number 7', { scope: 'module' });
  t(hits.some((h) => h.source === 'org_note'),
    'while search still finds them on demand, which is the point');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [2] the bootstrap does not grow with the fleet"
run_block bootstrap-vs-fleet <<'JS'
const B = process.env.MJ_BUILD;
const fs = await import('fs');
const { ServerContext } = await import(B + '/context.js');
const { startSession, endSession } = await import(B + '/tools/session.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

// Volatile by construction: a session id, the clock, and the id of the
// previous session. Comparing raw payloads compares those too, which is how
// the first version of this assertion "failed" on two identical bootstraps.
// Normalised, then compared BOTH ways: the shape, and the byte length — the
// first catches a field appearing, the second catches one growing.
const norm = (s) => JSON.stringify({
  ...s,
  sessionId: 0,
  startedAt: '',
  previousSession: s.previousSession
    ? { ...s.previousSession, id: 0, endedAt: '', daysSinceClose: 0 }
    : null,
  curatedResume: s.curatedResume ? { ...s.curatedResume, sessionId: 0, endedAt: '' } : undefined,
  autoClosedPrevious: s.autoClosedPrevious ? { sessionId: 0 } : undefined,
});

const ctx = ServerContext.initialize();
try {
  let s = startSession(ctx, { module: '_general' });
  const small = norm(s);
  const smallBytes = JSON.stringify(s).length;
  endSession(ctx, { summary: 'a', next_session: 'b' });

  // 49 more projects, in the brain AND the registry, each with modules and
  // context rows of its own — 2 KB per row, so a leak would be unmissable.
  const insP = ctx.db.db.prepare("INSERT INTO projects (name, path, isolation) VALUES (?, ?, 'shared')");
  const insM = ctx.db.db.prepare('INSERT INTO modules (project_id, name) VALUES (?, ?)');
  const insC = ctx.db.db.prepare(
    "INSERT INTO project_context (project_id, kind, title, content, content_hash) VALUES (?, 'convention', ?, ?, ?)",
  );
  const reg = JSON.parse(fs.readFileSync(process.env.MJ_REG, 'utf-8'));
  for (let i = 1; i <= 49; i++) {
    const name = 'other-project-' + i;
    const p = insP.run(name, '/tmp/fixture/' + name);
    for (let m = 0; m < 5; m++) insM.run(Number(p.lastInsertRowid), 'module-' + m);
    for (let c = 0; c < 10; c++)
      insC.run(Number(p.lastInsertRowid), 'a convention of ' + name, 'x'.repeat(2000), 'h' + i + '-' + c);
    reg.projects[name] = { name, path: '/tmp/fixture/' + name, framework: null, initialized: '2026-01-01' };
  }
  fs.writeFileSync(process.env.MJ_REG, JSON.stringify(reg, null, 2));

  s = startSession(ctx, { module: '_general' });
  const big = norm(s);
  const bigBytes = JSON.stringify(s).length;
  endSession(ctx, { summary: 'a', next_session: 'b' });

  t(small === big,
    small === big
      ? 'the session payload is IDENTICAL with 1 project and with 50, field for field'
      : 'the session payload changed with the fleet');
  t(smallBytes === bigBytes,
    smallBytes === bigBytes
      ? 'and the same size (' + smallBytes + ' B)'
      : 'and grew: ' + smallBytes + ' -> ' + bigBytes + ' B');
  t(!big.includes('other-project-'), 'and names no other project');
  t(!big.includes('x'.repeat(100)), 'nor any other project\'s context');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [3] size budgets on what the agent is made to read"
run_block size-budgets <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession, endSession } = await import(B + '/tools/session.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const s = startSession(ctx, { module: '_general' });
  const bytes = JSON.stringify(s).length;
  // 485 B measured on a 3-module project. The budget is for catching a feature
  // that dumps a corpus into the payload, not for shaving a handoff.
  t(bytes < 4000, 'start_session payload is ' + bytes + ' B (budget 4000)');
  const slugs = JSON.stringify(s.workflows ?? []);
  t(Array.isArray(s.workflows) && s.workflows.every((x) => typeof x === 'string'),
    'the workflow list is slugs, not objects');
  t(slugs.length < 200, 'and stays under 200 B (' + slugs.length + ')');
  endSession(ctx, { summary: 'a', next_session: 'b' });
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

# The hook is what the user and the model actually see at startup. It has its
# own budget in v046-bootstrap-size; re-asserted here so this suite reads on its
# own as "what the bootstrap costs".
HOOK_AC=$(cd "$WORK/app" && node "$B/cli.js" hook session-start 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print(len((d.get('hookSpecificOutput') or {}).get('additionalContext','') or ''))
except Exception: print(-1)
")
if [ "$HOOK_AC" -ge 0 ] && [ "$HOOK_AC" -lt 1200 ]; then
  pass "SessionStart hands the model $HOOK_AC B (budget 1200)"
else
  oops "SessionStart additionalContext is $HOOK_AC B (budget 1200)"
fi

echo "→ [4] time budgets, well above the measured value"
run_block time-budgets <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession, endSession } = await import(B + '/tools/session.js');
const { saveObservation } = await import(B + '/tools/observations.js');
const { promoteObservation } = await import(B + '/tools/orgMemory.js');
const { getWorkflow } = await import(B + '/tools/workflows.js');
const { startWorkflowRun, advanceWorkflowStep, closeWorkflowRun } =
  await import(B + '/tools/workflowRuns.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

// One untimed warmup, then the MEDIAN of N. The mean is the statistic a single
// scheduler hiccup ruins, and this runs on whichever machine happens to be busy.
const timeIt = (reps, fn) => {
  fn();
  const xs = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
};
const budget = (label, ms, max) =>
  t(ms < max, label + ': ' + ms.toFixed(2) + ' ms (budget ' + max + ')');

const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });

  budget('search over 500 org notes',
    timeIt(20, () => ctx.db.search('question number', { scope: 'module' })), 50);
  budget('search, no match',
    timeIt(20, () => ctx.db.search('zzzznotthere', { scope: 'module' })), 50);
  budget('get_workflow, 11 steps through 2 levels',
    timeIt(20, () => getWorkflow(ctx, { slug: 'session-close' })), 40);
  budget('list the reachable slugs',
    timeIt(20, () => ctx.db.workflows.listSlugs(ctx.requireProject().id, ctx.db.scopedOrgId)), 20);

  // A full ritual: open, advance every step, close. Closing matters — without
  // it the second iteration finds the run still open and throws, which is both
  // a broken measurement and the correct behaviour.
  const runOnce = () => {
    const r = startWorkflowRun(ctx, { slug: 'session-close' });
    for (let i = 0; i < r.steps.length; i++) advanceWorkflowStep(ctx, {});
    closeWorkflowRun(ctx, {});
  };
  budget('an 11-step run: open, advance all, close', timeIt(5, runOnce), 400);

  // Promotion, including the scrub against 50 projects.
  const obs = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'something worth sharing with the team',
    content: 'a body with no secrets, no paths and no client names in it at all',
  });
  budget('promote_observation incl. the scrub over 50 projects',
    timeIt(5, () => promoteObservation(ctx, { observation_id: obs.observationId })), 300);

  endSession(ctx, { summary: 'a', next_session: 'b' });
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [5] push and pull of a memory that has grown"
run_block push-pull <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { transportFor } = await import(B + '/org/memory/transport.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const transport = transportFor(ctx);
  const ms = (fn) => {
    const t0 = process.hrtime.bigint();
    const r = fn();
    return [Number(process.hrtime.bigint() - t0) / 1e6, r];
  };

  const [pushMs, pushed] = ms(() => transport.push(ctx));
  t(pushMs < 4000, 'push of ~500 notes: ' + pushMs.toFixed(0) + ' ms (budget 4000)');
  t(pushed.appended >= 500, 'and it wrote them all (' + pushed.appended + ')');

  // A second push must be a no-op, or every org project has something to commit
  // after every push and `git status` stops meaning anything.
  const [noopMs, again] = ms(() => transport.push(ctx));
  t(again.changed === false, 'a second push changes nothing');
  t(noopMs < 4000, 'and still costs ' + noopMs.toFixed(0) + ' ms (budget 4000)');

  const [pullMs, pulled] = ms(() => transport.pull(ctx));
  t(pullMs < 8000, 'pull of ~500 notes already present: ' + pullMs.toFixed(0) + ' ms (budget 8000)');
  t(pulled.added === 0 && pulled.duplicates >= 500, 'and added nothing, recognising them all');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-perf-budget E2E PASSED"
