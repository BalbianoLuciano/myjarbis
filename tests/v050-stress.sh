#!/bin/bash
#
# E2E test: two processes at once, and a store that has grown.
#
# Nothing in `tests/` has ever opened two connections to one brain at the same
# time. The only suite that backgrounds a process, `v045-update-self-overwrite`,
# backgrounds a bash script that touches no database; and the one suite with a
# genuine two-machine fixture, `v050-org-sync`, uses two SEPARATE brains joined
# by a git clone. So every claim this codebase makes about concurrency has been
# a claim about reading the code.
#
# Several of those claims were wrong, and this suite is what found them:
#
#   · `orgNotes.add` wrote the note and its content as two separate commits,
#     so a concurrent reader could see a note whose content row did not exist
#     yet — and `listByOrg` INNER JOINs them, so it silently omitted it.
#   · `seq` was `MAX(seq) + 1` read outside any transaction, so two writers
#     inserting different notes both got the same number, which breaks the
#     incremental `sinceSeq` read it exists for.
#   · `workflowRuns.open` committed the run row before its steps, so any
#     failure in the step loop left an open run holding a prefix — and
#     `findOpen` then answers "already in progress" forever.
#   · a parent invoking the same child twice produced two steps with one name,
#     which `UNIQUE(run_id, step_name)` rejected with a raw SqliteError in the
#     middle of opening a run.
#
# The JS goes in files with a QUOTED heredoc, not in `node -e "..."`: these
# blocks are run as separate PROCESSES, and a block that bash has partially
# expanded is not the block that was written. See observation 1559.
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

WORK="$(mktemp -d -t myjarbis-stress-XXXXXX)"
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

run_block() {
  local label="$1"
  cat > "$WORK/$label.mjs"
  if ! MJ_BUILD="$B" MJ_WORK="$WORK" MJ_REG="$MYJARBIS_REGISTRY" \
       node "$WORK/$label.mjs" > "$ASSERTS" 2>"$WORK/err.$label"; then
    echo "    ✗ $label crashed"
    sed 's/^/      /' "$WORK/err.$label" >&2
    FAILED=$((FAILED + 1))
    : > "$ASSERTS"
  fi
  read_asserts
}

# Writes a worker script without running it, for the two-process sections.
write_worker() { cat > "$WORK/$1.mjs"; }

mkdir -p "$WORK/app" && cd "$WORK/app" && git init -q -b master .
git config user.email s@s.test && git config user.name 'Stress Dev'
git remote add origin git@github.com:example/app.git
echo x > f.txt && git add f.txt && git -c commit.gpgsign=false commit -q -m init
"$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1

run_block setup <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const out = [];
const ctx = ServerContext.initialize();
const project = ctx.requireProject();
const org = ctx.db.orgs.upsert({ slug: 'acme', name: 'Acme' });
ctx.db.projects.setOrg(project.id, org.id);
out.push('PASS|the fixture project belongs to an org');
ctx.close();
console.log(out.join('\n'));
JS

# ─────────────────────────────────────────────────────────────────────
echo "→ [1] two processes promote the same lesson at once"
#
# The mem0 #6515 class: a check-then-insert dedup produces PERMANENT
# duplicates under concurrency. The constraint is supposed to close it, and
# until now nothing proved that with two processes.
write_worker promote-race <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const org = ctx.db.orgs.findBySlug('acme');
  const draft = {
    question: 'why does the same lesson arrive twice',
    answer: 'because two people learned it in the same minute',
    typeTags: 'gotcha',
  };
  // Both workers wait for the same wall-clock moment, so they are inside
  // `add` together rather than merely close to each other.
  const goAt = Number(process.env.MJ_GO_AT);
  while (Date.now() < goAt) { /* spin */ }
  const r = ctx.db.orgNotes.add({
    orgId: org.id,
    projectId: project.id,
    author: { handle: process.env.MJ_WHO, email: null, source: 'git' },
    draft,
    contentHash: ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: project.name, draft }),
  });
  console.log(process.env.MJ_WHO + ' ' + r.status + ' ' + r.row.id + ' ' + (r.content ? 'has-content' : 'NO-CONTENT'));
} finally { ctx.close(); }
JS

GO_AT=$(( $(date +%s%N) / 1000000 + 1200 ))
( cd "$WORK/app" && MJ_BUILD="$B" MJ_WHO=ana MJ_GO_AT="$GO_AT" node "$WORK/promote-race.mjs" > "$WORK/r.ana" 2>"$WORK/e.ana" ) &
( cd "$WORK/app" && MJ_BUILD="$B" MJ_WHO=bob MJ_GO_AT="$GO_AT" node "$WORK/promote-race.mjs" > "$WORK/r.bob" 2>"$WORK/e.bob" ) &
wait

for who in ana bob; do
  if [ -s "$WORK/e.$who" ]; then
    oops "$who crashed: $(head -2 "$WORK/e.$who" | tr '\n' ' ')"
  fi
done
RESULTS="$(cat "$WORK/r.ana" "$WORK/r.bob" 2>/dev/null)"
INSERTED=$(printf '%s\n' "$RESULTS" | grep -c ' inserted ' || true)
DUPES=$(printf '%s\n' "$RESULTS" | grep -c ' duplicate ' || true)
[ "$INSERTED" = "1" ] && pass "exactly one process inserted" \
  || oops "expected 1 insert, got $INSERTED ($RESULTS)"
[ "$DUPES" = "1" ] && pass "and the other was told it was a duplicate" \
  || oops "expected 1 duplicate, got $DUPES ($RESULTS)"
if printf '%s\n' "$RESULTS" | grep -q 'NO-CONTENT'; then
  oops "a process got a note back with no content row — the torn write is back"
else
  pass "and NEITHER saw a note without its content row"
fi

run_block after-promote-race <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const org = ctx.db.orgs.findBySlug('acme');
  const rows = ctx.db.db
    .prepare('SELECT COUNT(*) AS c FROM org_notes WHERE org_id = ?')
    .get(org.id);
  t(rows.c === 1, 'the brain holds exactly one row for that lesson (' + rows.c + ')');
  const orphans = ctx.db.db
    .prepare('SELECT COUNT(*) AS c FROM org_notes n LEFT JOIN org_note_content c ON c.note_id = n.id WHERE c.note_id IS NULL')
    .get();
  t(orphans.c === 0, 'and no note anywhere is missing its content row');
  const dupSeq = ctx.db.db
    .prepare('SELECT COUNT(*) AS c FROM (SELECT org_id, seq FROM org_notes GROUP BY org_id, seq HAVING COUNT(*) > 1)')
    .get();
  t(dupSeq.c === 0, 'and no two notes in one org share a seq');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

# ─────────────────────────────────────────────────────────────────────
echo "→ [2] two processes write DIFFERENT notes at once"
#
# The seq collision needs two different notes: the same-hash case is settled by
# the constraint, but `MAX(seq)+1` read outside a transaction gives two writers
# the same number, and `sinceSeq` then skips or re-delivers rows.
write_worker seq-race <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const org = ctx.db.orgs.findBySlug('acme');
  const goAt = Number(process.env.MJ_GO_AT);
  while (Date.now() < goAt) { /* spin */ }
  const made = [];
  for (let i = 0; i < 15; i++) {
    const draft = {
      question: process.env.MJ_WHO + ' lesson ' + i,
      answer: 'body ' + i,
      typeTags: 'gotcha',
    };
    const r = ctx.db.orgNotes.add({
      orgId: org.id,
      projectId: project.id,
      author: { handle: process.env.MJ_WHO, email: null, source: 'git' },
      draft,
      contentHash: ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: project.name, draft }),
    });
    made.push(r.row.seq);
  }
  console.log(process.env.MJ_WHO + ' ' + made.join(','));
} finally { ctx.close(); }
JS

GO_AT=$(( $(date +%s%N) / 1000000 + 1200 ))
( cd "$WORK/app" && MJ_BUILD="$B" MJ_WHO=ana MJ_GO_AT="$GO_AT" node "$WORK/seq-race.mjs" > "$WORK/s.ana" 2>"$WORK/se.ana" ) &
( cd "$WORK/app" && MJ_BUILD="$B" MJ_WHO=bob MJ_GO_AT="$GO_AT" node "$WORK/seq-race.mjs" > "$WORK/s.bob" 2>"$WORK/se.bob" ) &
wait
for who in ana bob; do
  [ -s "$WORK/se.$who" ] && oops "$who crashed writing 15 notes: $(head -2 "$WORK/se.$who" | tr '\n' ' ')"
done

run_block after-seq-race <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const org = ctx.db.orgs.findBySlug('acme');
  const total = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes WHERE org_id = ?').get(org.id).c;
  t(total === 31, 'all 30 concurrent notes landed, plus the one from section 1 (' + total + ')');
  const dupSeq = ctx.db.db
    .prepare('SELECT seq, COUNT(*) AS c FROM org_notes WHERE org_id = ? GROUP BY seq HAVING c > 1')
    .all(org.id);
  t(dupSeq.length === 0,
    dupSeq.length === 0
      ? 'and every seq is unique, so an incremental read cannot skip a row'
      : 'two notes share a seq: ' + JSON.stringify(dupSeq));
  const orphans = ctx.db.db
    .prepare('SELECT COUNT(*) AS c FROM org_notes n LEFT JOIN org_note_content c ON c.note_id = n.id WHERE c.note_id IS NULL')
    .get().c;
  t(orphans === 0, 'and nothing is missing its content row');

  // The thing seq exists for: reading everything after N must see each row once.
  const half = ctx.db.orgNotes.listByOrg(org.id, { sinceSeq: 15, limit: 1000 });
  const seqs = half.map((n) => n.seq);
  t(new Set(seqs).size === seqs.length, 'an incremental read returns no row twice');
  t(seqs.every((s) => s > 15), 'and nothing at or below the watermark');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

# ─────────────────────────────────────────────────────────────────────
echo "→ [3] two processes start the same ritual at once"
write_worker run-race <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession } = await import(B + '/tools/session.js');
const { startWorkflowRun } = await import(B + '/tools/workflowRuns.js');
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });
  const goAt = Number(process.env.MJ_GO_AT);
  while (Date.now() < goAt) { /* spin */ }
  const r = startWorkflowRun(ctx, { slug: 'commit-ritual' });
  console.log(process.env.MJ_WHO + ' run=' + r.runId + ' steps=' + r.steps.length);
} finally { ctx.close(); }
JS

GO_AT=$(( $(date +%s%N) / 1000000 + 1200 ))
( cd "$WORK/app" && MJ_BUILD="$B" MJ_WHO=ana MJ_GO_AT="$GO_AT" node "$WORK/run-race.mjs" > "$WORK/w.ana" 2>"$WORK/we.ana" ) &
( cd "$WORK/app" && MJ_BUILD="$B" MJ_WHO=bob MJ_GO_AT="$GO_AT" node "$WORK/run-race.mjs" > "$WORK/w.bob" 2>"$WORK/we.bob" ) &
wait
for who in ana bob; do
  [ -s "$WORK/we.$who" ] && oops "$who crashed starting a run: $(head -3 "$WORK/we.$who" | tr '\n' ' ')"
done

run_block after-run-race <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const runs = ctx.db.db
    .prepare("SELECT id FROM workflow_runs WHERE project_id = ? AND slug = 'commit-ritual'")
    .all(project.id);
  t(runs.length <= 2, 'at most one run per racing process (' + runs.length + ')');

  // The property that matters is not the count — it is that no run is a
  // fragment. A run with fewer steps than the workflow resolves to is the
  // half-opened row that used to wedge the ritual forever.
  let fragments = 0;
  for (const r of runs) {
    const n = ctx.db.workflowRunSteps.listByRun(r.id).length;
    if (n === 0 || n < 6) fragments++;
  }
  t(fragments === 0,
    fragments === 0
      ? 'and every run that exists holds its whole step list'
      : fragments + ' run(s) were committed with a partial step list');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

# ─────────────────────────────────────────────────────────────────────
echo "→ [4] a parent that invokes one child twice"
#
# The diamond. Expansion produced the child's steps twice with identical
# namespaced names, and `UNIQUE(run_id, step_name)` then raised a raw
# SqliteError in the middle of opening a run — AFTER the run row was written.
run_block diamond <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { setWorkflowStep, getWorkflow } = await import(B + '/tools/workflows.js');
const { startSession } = await import(B + '/tools/session.js');
const { startWorkflowRun } = await import(B + '/tools/workflowRuns.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });
  const S = (a) => setWorkflowStep(ctx, { scope: 'project', actor: 'agent', ...a });

  S({ slug: 'shared-child', name: 'do-it', position: 10 });
  S({ slug: 'twice', name: 'first', position: 10, uses: 'shared-child' });
  S({ slug: 'twice', name: 'middle', position: 20 });
  S({ slug: 'twice', name: 'second', position: 30, uses: 'shared-child' });

  let err = null;
  try { getWorkflow(ctx, { slug: 'twice' }); } catch (e) { err = e; }
  t(err !== null, 'resolving it is refused rather than producing two steps with one name');
  t(err && String(err.type) === 'INVALID_INPUT', 'as INVALID_INPUT, not a raw SQLite error');
  t(err && String(err.message).includes('shared-child/do-it'),
    'naming the step that collided');
  t(err && /two steps called/.test(String(err.message)), 'and saying what the problem is');

  // And nothing was written on the way to finding out.
  const before = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM workflow_runs').get().c;
  let err2 = null;
  try { startWorkflowRun(ctx, { slug: 'twice' }); } catch (e) { err2 = e; }
  t(err2 !== null, 'starting a run on it is refused too');
  const after = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM workflow_runs').get().c;
  t(before === after, 'and no run row was left behind (' + before + ' -> ' + after + ')');

  // Two DIFFERENT parents reaching one child stays legal: that is the whole
  // point of a child, and it was never the broken case.
  S({ slug: 'other-parent', name: 'also-uses-it', position: 10, uses: 'shared-child' });
  const ok = getWorkflow(ctx, { slug: 'other-parent' });
  t(ok.steps.some((s) => s.name === 'shared-child/do-it'),
    'while a second parent reaching the same child still resolves');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

# ─────────────────────────────────────────────────────────────────────
echo "→ [5] a brain that has grown"
run_block scale <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { setWorkflowStep, getWorkflow } = await import(B + '/tools/workflows.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const S = (a) => setWorkflowStep(ctx, { scope: 'project', actor: 'agent', ...a });

  // A hundred steps.
  for (let i = 0; i < 100; i++) S({ slug: 'wide', name: 'step-' + i, position: (i + 1) * 10 });
  const t0 = process.hrtime.bigint();
  const wide = getWorkflow(ctx, { slug: 'wide' });
  const wideMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t(wide.steps.length === 100, 'a 100-step workflow resolves to 100 steps');
  t(wideMs < 500, 'in ' + wideMs.toFixed(0) + ' ms (budget 500)');

  // A ten-level chain. Each level invokes the next, so this is also the
  // deepest the cycle guard's chain gets.
  for (let i = 0; i < 10; i++) {
    S({ slug: 'deep-' + i, name: 'work-' + i, position: 10 });
    if (i > 0) S({ slug: 'deep-' + (i - 1), name: 'go-deeper', position: 20, uses: 'deep-' + i });
  }
  const t1 = process.hrtime.bigint();
  const deep = getWorkflow(ctx, { slug: 'deep-0' });
  const deepMs = Number(process.hrtime.bigint() - t1) / 1e6;
  t(deep.steps.length === 10, 'a 10-level chain flattens to 10 steps (' + deep.steps.length + ')');
  t(deep.expanded.length === 9, 'reporting 9 expansions');
  t(Math.max(...deep.steps.map((s) => s.depth)) === 9, 'with the deepest at depth 9');
  t(deepMs < 500, 'in ' + deepMs.toFixed(0) + ' ms (budget 500)');

  // And the names stay unique all the way down, which is what the refusal in
  // section 4 is protecting.
  const names = deep.steps.map((s) => s.name);
  t(new Set(names).size === names.length, 'and every name in the flat list is unique');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-stress E2E PASSED"
