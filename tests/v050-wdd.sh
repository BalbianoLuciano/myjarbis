#!/bin/bash
#
# E2E test: workflow-driven development — composition, and running a ritual.
#
# The workflows subsystem shipped in v0.3 and has held zero rows ever since, so
# three defects sat in it undisturbed. Two are fixed here and pinned, and the
# first is a cross-tenant leak:
#
#   · `scope = 'user'` was read WITHOUT its scope_id, while the write side has
#     always keyed user rows by project. In a shared brain that made a
#     user-scope workflow written in one project resolvable from every other
#     project in the file.
#   · adding one step at project scope rewrote the workflow's display name to
#     its slug, so an org workflow called "Closing a ticket (Acme)" lost its
#     name as a side effect of changing a gate.
#
# Then composition. A step can carry `uses: <slug>`, and the ordering decision
# is the whole design: layers resolve FIRST, expansion happens over the
# resolved list. Section [5] is the assertion that encodes it — a project
# override of a CHILD's step must be visible through the parent. Under the
# other ordering it would not be, and overriding one child step would mean
# writing it into every parent that invokes the child.
#
# And runs, which answer "where was I" with a row instead of with prose.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/tools/workflowRuns.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-wdd-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}

# Two projects in ONE shared brain: the arrangement where a scope leak is
# possible at all.
for p in one two; do
  mkdir -p "$WORK/$p" && cd "$WORK/$p" && git init -q -b master .
  git config user.email "d@$p.test" && git config user.name "Dev $p"
  git remote add origin "git@github.com:example/$p.git"
  "$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1
done

echo "→ [1] a user-scope workflow no longer leaks into another project"
cd "$WORK/one"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  setWorkflowStep(ctx, { slug: 'my-private-ritual', name: 'do-the-thing', scope: 'user', actor: 'agent' });
  t(true, 'project one defines a user-scope workflow');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e1a" || { echo "    ✗ node block crashed"; cat "$WORK/e1a" >&2; FAILED=$((FAILED+1)); }
read_asserts

cd "$WORK/two"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { listWorkflowsTool, getWorkflow } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  t(ctx.requireProject().name === 'two', 'this connection resolved to project two');
  const listed = listWorkflowsTool(ctx).workflows.map((w) => w.slug);
  t(!listed.includes('my-private-ritual'), 'project two does not list it');
  let threw = null;
  try { getWorkflow(ctx, { slug: 'my-private-ritual' }); } catch (e) { threw = e; }
  t(threw !== null && String(threw.type) === 'WORKFLOW_NOT_FOUND',
    'and cannot resolve it either — the leak is closed');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e1b" || { echo "    ✗ node block crashed"; cat "$WORK/e1b" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [2] overriding a step no longer renames the workflow"
cd "$WORK/one"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep, getWorkflow } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  // Stand in for an org layer: a workflow that already has a display name.
  const org = ctx.db.orgs.upsert({ slug: 'acme', name: 'Acme' });
  ctx.db.projects.setOrg(project.id, org.id);
  const wf = ctx.db.workflows.upsert({
    slug: 'ticket-close', name: 'Closing a ticket (Acme)', scope: 'org', scopeId: org.id,
  });
  ctx.db.workflowSteps.upsert({ workflowId: wf.id, position: 10, name: 'run-tests', actor: 'agent' });

  setWorkflowStep(ctx, { slug: 'ticket-close', name: 'extra-check', scope: 'project', actor: 'agent' });
  t(getWorkflow(ctx, { slug: 'ticket-close' }).name === 'Closing a ticket (Acme)',
    'adding a project step keeps the name the org gave it');

  setWorkflowStep(ctx, {
    slug: 'ticket-close', name: 'extra-check', scope: 'project', actor: 'agent',
    workflow_name: 'Closing a ticket (project rules)',
  });
  t(getWorkflow(ctx, { slug: 'ticket-close' }).name === 'Closing a ticket (project rules)',
    'and an explicit name overrides it, as the more specific layer should');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e2" || { echo "    ✗ node block crashed"; cat "$WORK/e2" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [3,4] composition: a parent made of children, flat and namespaced"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep, getWorkflow, listWorkflowsTool } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const S = (a) => setWorkflowStep(ctx, { scope: 'project', actor: 'agent', ...a });

  // grandchild, child, parent. The collision is deliberate: 'parent' and
  // 'child' BOTH define a step called run-tests, which is exactly what
  // namespacing exists to keep apart.
  S({ slug: 'gchild', name: 'g1', position: 10 });
  S({ slug: 'child', name: 'run-tests', position: 10 });
  S({ slug: 'child', name: 'deep', position: 20, uses: 'gchild' });
  S({ slug: 'child', name: 'c2', position: 30 });
  S({ slug: 'parent', name: 'p1', position: 10 });
  S({ slug: 'parent', name: 'call-child', position: 20, uses: 'child' });
  S({ slug: 'parent', name: 'run-tests', position: 30 });

  const r = getWorkflow(ctx, { slug: 'parent' });
  const names = r.steps.map((s) => s.name);
  t(r.steps.length === 5, 'the parent resolves to five flat steps, not four');
  t(JSON.stringify(names) ===
      JSON.stringify(['p1', 'child/run-tests', 'gchild/g1', 'child/c2', 'run-tests']),
    'in invocation order, with child steps spliced in where the step sat');
  t(names.filter((n) => n === 'run-tests').length === 1 &&
      names.includes('child/run-tests'),
    'the colliding step name survives on both sides because the child is namespaced');

  const byName = Object.fromEntries(r.steps.map((s) => [s.name, s]));
  t(byName['p1'].fromWorkflow === 'parent' && byName['p1'].depth === 0,
    \"the parent's own step reports itself at depth 0\");
  t(byName['child/run-tests'].fromWorkflow === 'child' && byName['child/run-tests'].depth === 1,
    'a child step reports the child, at depth 1');
  t(byName['gchild/g1'].fromWorkflow === 'gchild' && byName['gchild/g1'].depth === 2,
    'and a grandchild reports itself at depth 2, prefixed once and not twice');
  t(JSON.stringify(r.steps.map((s) => s.order)) === JSON.stringify([1, 2, 3, 4, 5]),
    'order is the running sequence');
  t(byName['child/c2'].position === 30,
    \"while position stays the step's own, which is what an override inherits\");
  t(r.expanded.map((e) => e.slug + '@' + e.depth).join(',') === 'child@1,gchild@2',
    'and the expansion is reported, child then grandchild');

  // A namespaced name is a resolved address, not a writable one.
  let threw = null;
  try { S({ slug: 'parent', name: 'child/run-tests' }); } catch (e) { threw = e; }
  t(threw !== null, 'writing to a namespaced name is refused');
  t(threw && String(threw.message).includes('slug: \"child\"'),
    'and the refusal says where to write instead');

  // A step cannot both delegate and act.
  let threw2 = null;
  try { S({ slug: 'parent', name: 'both', uses: 'child', capability: 'ci.run' }); } catch (e) { threw2 = e; }
  t(threw2 !== null, 'a step with both uses and capability is refused');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e3" || { echo "    ✗ node block crashed"; cat "$WORK/e3" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [5] THE ordering decision: a child override reaches every parent"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep, getWorkflow } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  // 'child' is overridden at USER scope — the most specific layer — and the
  // parent is not touched at all. If expansion happened BEFORE layer
  // resolution, the child's steps would already be sitting in the parent's
  // name space and this override would never reach the parent's view.
  setWorkflowStep(ctx, {
    slug: 'child', name: 'run-tests', scope: 'user', actor: 'human', gate: 'approve',
  });

  const viaChild = getWorkflow(ctx, { slug: 'child' });
  const direct = viaChild.steps.find((s) => s.name === 'run-tests');
  t(direct.gate === 'approve' && direct.from === 'user',
    'the child itself shows the user-scope override');

  const viaParent = getWorkflow(ctx, { slug: 'parent' });
  const through = viaParent.steps.find((s) => s.name === 'child/run-tests');
  t(through !== undefined, 'the parent still sees the child step');
  t(through.gate === 'approve',
    'and sees the override THROUGH the parent — one rule, one place, every parent');
  t(through.from === 'user', 'reported as coming from the user layer');
  t(through.fromWorkflow === 'child',
    'and still owned by the child, which is where it was changed');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e5" || { echo "    ✗ node block crashed"; cat "$WORK/e5" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [6] cycles, hidden children, and a guarded delete"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep, getWorkflow, listWorkflowsTool } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const S = (a) => setWorkflowStep(ctx, { scope: 'project', actor: 'agent', ...a });

  // a → b → a
  S({ slug: 'cyc-a', name: 'to-b', position: 10, uses: 'cyc-b' });
  S({ slug: 'cyc-b', name: 'to-a', position: 10, uses: 'cyc-a' });
  let threw = null;
  try { getWorkflow(ctx, { slug: 'cyc-a' }); } catch (e) { threw = e; }
  t(threw !== null, 'a cycle is refused rather than hanging');
  t(threw && String(threw.message).includes('cyc-a → cyc-b → cyc-a'),
    'and the message prints the path, not just the word cycle');

  // One broken workflow must not take the whole list with it. Listing resolves
  // every slug, so a cycle used to make list_workflows throw — and an agent
  // that cannot list any workflow cannot find the healthy ones either.
  const listing = listWorkflowsTool(ctx);
  t(listing.workflows.length > 1, 'list_workflows still returns the healthy ones');
  t(listing.broken !== undefined && listing.broken.some((b) => b.slug === 'cyc-a'),
    'and reports the broken one as broken rather than omitting it');
  t(String(listing.hint).includes('do not resolve'), 'with a hint saying so');

  // A step that invokes itself is refused at write time.
  let threw2 = null;
  try { S({ slug: 'selfie', name: 'loop', uses: 'selfie' }); } catch (e) { threw2 = e; }
  t(threw2 !== null, 'a self-invoking step is refused when written');

  // A child marked non-standalone disappears from the menu but stays usable.
  S({ slug: 'gchild', name: 'g1', position: 10, standalone: false });
  const listed = listWorkflowsTool(ctx).workflows.map((w) => w.slug);
  t(!listed.includes('gchild'), 'a non-standalone workflow is not offered on its own');
  t(listed.includes('parent'), 'while the parent still is');
  const pr = getWorkflow(ctx, { slug: 'parent' });
  t(pr.steps.some((s) => s.name === 'gchild/g1'),
    'and it is still expanded inside the parent that invokes it');
  t(getWorkflow(ctx, { slug: 'gchild' }).standalone === false,
    'it also still resolves by slug, reporting that it is a child');
  const parentEntry = listWorkflowsTool(ctx).workflows.find((w) => w.slug === 'parent');
  t(Array.isArray(parentEntry.uses) && parentEntry.uses.includes('child'),
    'the listing says which children a parent invokes');

  // Deleting a workflow something else invokes is refused, naming the parent.
  const childRow = ctx.db.workflows.find('child', 'project', ctx.requireProject().id);
  let threw3 = null;
  try { ctx.db.workflows.delete(childRow.id); } catch (e) { threw3 = e; }
  t(threw3 !== null && String(threw3.message).includes('parent'),
    'deleting an invoked child is refused and names the parent');
  t(getWorkflow(ctx, { slug: 'parent' }).steps.length === 5,
    'so the parent still resolves — nothing was half-deleted');

  // A missing child is reported against the step that invokes it.
  S({ slug: 'dangling', name: 'go', position: 10, uses: 'nope-not-here' });
  let threw4 = null;
  try { getWorkflow(ctx, { slug: 'dangling' }); } catch (e) { threw4 = e; }
  t(threw4 !== null && String(threw4.message).includes('step \"go\"'),
    'a missing child names the parent step, not just the absent slug');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e6" || { echo "    ✗ node block crashed"; cat "$WORK/e6" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [7] a run: advance, skip with a reason, times, and resumability"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { startWorkflowRun, advanceWorkflowStep, closeWorkflowRun, getWorkflowRun } from '$B/tools/workflowRuns.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });
  const run = startWorkflowRun(ctx, { slug: 'parent' });
  t(run.steps.length === 5, 'the run snapshots the five expanded steps');
  t(run.steps[0].status === 'active', 'the first step is active immediately');
  t(run.steps.slice(1).every((s) => s.status === 'pending'), 'the rest are pending');
  t(run.current.name === 'p1', 'and the run knows which step it is on');
  t(run.display.includes('[>]'), 'the rendered view marks the active step');

  // Asking to start it again answers where it got to.
  const again = startWorkflowRun(ctx, { slug: 'parent' });
  t(again.runId === run.runId, 'starting it again returns the SAME run');
  t(String(again.hint).includes('already in progress'), 'and says so');
  t(ctx.db.workflowRuns.listByProject(ctx.requireProject().id).length === 1,
    'so there is exactly one run, not a split history');

  // The common call takes no arguments: the open run and its active step.
  let v = advanceWorkflowStep(ctx, {});
  t(v.steps[0].status === 'done', 'advancing with no arguments completes the active step');
  t(v.current.name === 'child/run-tests', 'and activates the next');

  // A skip needs a reason.
  let threw = null;
  try { advanceWorkflowStep(ctx, { status: 'skipped' }); } catch (e) { threw = e; }
  t(threw !== null && String(threw.type) === 'INVALID_INPUT', 'a skip with no reason is refused');
  v = advanceWorkflowStep(ctx, { status: 'skipped', note: 'no tests in this child yet' });
  t(v.steps[1].status === 'skipped' && v.steps[1].note.includes('no tests'),
    'and with one it is recorded, reason included');

  // Closing as done while steps are unfinished is refused.
  let threw2 = null;
  try { closeWorkflowRun(ctx, {}); } catch (e) { threw2 = e; }
  t(threw2 !== null && String(threw2.message).includes('unfinished'),
    'closing as done with steps left is refused');

  advanceWorkflowStep(ctx, {});
  advanceWorkflowStep(ctx, {});
  advanceWorkflowStep(ctx, {});
  const closed = closeWorkflowRun(ctx, {});
  t(closed.status === 'done', 'once every step is accounted for, it closes');

  const timings = ctx.db.workflowRunSteps.timings(run.runId);
  t(timings.length === 5, 'every step has a timing row');
  t(timings.every((x) => x.seconds !== null), 'and every finished step has a measured duration');
  t(timings.some((x) => x.fromWorkflow === 'child'),
    'with the workflow each step came from, so the hours can be split by ritual');

  t(getWorkflowRun(ctx, { run_id: run.runId }).status === 'done', 'and the run reads back closed');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e7" || { echo "    ✗ node block crashed"; cat "$WORK/e7" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [8] the session dies under a run"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { startWorkflowRun, advanceWorkflowStep } from '$B/tools/workflowRuns.js';
import { autoCloseAll } from '$B/tools/autoClose.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const s = startSession(ctx, { module: '_general' });
  const run = startWorkflowRun(ctx, { slug: 'child' });
  advanceWorkflowStep(ctx, {});

  // What the SessionEnd hook does.
  const res = autoCloseAll(ctx, {});
  t(Array.isArray(res) && res.length >= 1, 'the session was auto-closed');
  t(res.some((c) => c.runsAbandoned === 1), 'and reports the run it abandoned');

  const row = ctx.db.workflowRuns.findById(run.runId);
  t(row.status === 'abandoned', 'the run is abandoned, not left open forever');
  const steps = ctx.db.workflowRunSteps.listByRun(run.runId);
  t(steps[0].status === 'done' && steps[0].completed_at !== null,
    'the step that WAS finished keeps its result');
  const blocked = steps.find((x) => x.status === 'blocked');
  t(blocked !== undefined, 'the step it died on is blocked');
  t(blocked && String(blocked.note).startsWith('[auto]'),
    'marked [auto], the same marker a synthetic session close uses');

  // And the ritual is startable again, which is the point of reconciling.
  startSession(ctx, { module: '_general' });
  const fresh = startWorkflowRun(ctx, { slug: 'child' });
  t(fresh.runId !== run.runId, 'a new run can be opened afterwards');
  t(fresh.steps[0].status === 'active', 'starting clean rather than resuming a dead one');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e8" || { echo "    ✗ node block crashed"; cat "$WORK/e8" >&2; FAILED=$((FAILED+1)); }
read_asserts

echo "→ [9] the baseline rituals, and a reseed that can be run twice"
#
# They are shipped rather than left to the user because the subsystem spent two
# releases fully implemented and holding zero rows — a composition feature with
# no data is one nobody will find a bug in. And they are the fixture the
# composition above wants, with real content: session-close uses commit-ritual
# uses pre-push-checks, three levels and one shared child.
mkdir -p "$WORK/fresh" && cd "$WORK/fresh" && git init -q -b master .
git config user.email f@f.test && git config user.name Fresh
git remote add origin git@github.com:example/fresh.git
"$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { getWorkflow, listWorkflowsTool, setWorkflowStep } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const listed = listWorkflowsTool(ctx).workflows;
  const slugs = listed.map((w) => w.slug).sort();
  t(JSON.stringify(slugs) === JSON.stringify(['branch-per-session', 'commit-ritual', 'session-close']),
    'a fresh init offers three rituals');
  t(!slugs.includes('pre-push-checks'), 'and hides the fragment the other two share');
  t(ctx.db.workflows.listSlugs(ctx.requireProject().id, null, { includeNonStandalone: true }).length === 4,
    'while all four rows exist');

  // The three-level chain, with real content.
  const close = getWorkflow(ctx, { slug: 'session-close' });
  t(close.steps.length === 11, 'session-close expands to eleven flat steps');
  t(close.expanded.map((e) => e.slug + '@' + e.depth).join(',') === 'commit-ritual@1,pre-push-checks@2',
    'through commit-ritual at depth 1 and pre-push-checks at depth 2');
  t(close.steps.some((s) => s.name === 'pre-push-checks/confirm-green' && s.gate === 'approve'),
    'and a gate two levels down survives the flattening');
  t(close.steps.every((s) => typeof s.notes === 'string' && s.notes.length > 20),
    'every step says what it means, not just what it is called');

  // The same child is reached by a second parent, which is the point of a child.
  const commit = getWorkflow(ctx, { slug: 'commit-ritual' });
  t(commit.expanded.some((e) => e.slug === 'pre-push-checks'),
    'commit-ritual reaches the same child');

  // Overriding the shared child once changes it for both parents.
  setWorkflowStep(ctx, {
    slug: 'pre-push-checks', name: 'confirm-green', scope: 'project', actor: 'human', gate: 'none',
  });
  t(getWorkflow(ctx, { slug: 'session-close' }).steps
      .find((s) => s.name === 'pre-push-checks/confirm-green').gate === 'none',
    'and overriding it once reaches session-close');
  t(getWorkflow(ctx, { slug: 'commit-ritual' }).steps
      .find((s) => s.name === 'pre-push-checks/confirm-green').gate === 'none',
    'and commit-ritual too — one rule, one place');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e9" || { echo "    ✗ node block crashed"; cat "$WORK/e9" >&2; FAILED=$((FAILED+1)); }
read_asserts

# The reseed rule that decides whether anybody runs it a second time: a step
# the user changed is never reverted.
RESEED="$("$MJ" workflow reseed --json 2>/dev/null)"
if echo "$RESEED" | grep -q '"applied": *false'; then
  pass "workflow reseed is a dry run by default"
else
  oops "reseed did not report itself as a dry run"
fi

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep } from '$B/tools/workflows.js';
const ctx = ServerContext.initialize();
// A step the user owns, at user scope, plus one deleted from the project layer
// so the reseed has something legitimate to add back.
setWorkflowStep(ctx, { slug: 'commit-ritual', name: 'push', scope: 'user', actor: 'agent', gate: 'none' });
const row = ctx.db.workflows.find('commit-ritual', 'project', ctx.requireProject().id);
const step = ctx.db.workflowSteps.listByWorkflow(row.id).find((s) => s.name === 'stage-by-name');
ctx.db.workflowSteps.delete(step.id);
ctx.close();
" 2>/dev/null

RESEED2="$("$MJ" workflow reseed --apply --json 2>/dev/null)"
if echo "$RESEED2" | grep -q 'commit-ritual/push (user)'; then
  pass "a step the user overrode is reported as left alone"
else
  oops "reseed did not preserve the user's override (got: $(echo "$RESEED2" | head -c 200))"
fi
if echo "$RESEED2" | grep -q '+1 step'; then
  pass "while a genuinely missing step is added back"
else
  oops "reseed did not restore the deleted step"
fi

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { getWorkflow } from '$B/tools/workflows.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const r = getWorkflow(ctx, { slug: 'commit-ritual' });
  const push = r.steps.find((s) => s.name === 'push');
  t(push.gate === 'none' && push.from === 'user',
    \"and after --apply the user's gate is still the user's\");
  t(r.steps.some((s) => s.name === 'stage-by-name'), 'with the missing step restored');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/e9b" || { echo "    ✗ node block crashed"; cat "$WORK/e9b" >&2; FAILED=$((FAILED+1)); }
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-wdd E2E PASSED"
