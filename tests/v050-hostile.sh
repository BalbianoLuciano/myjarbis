#!/bin/bash
#
# E2E test: files that are broken and input nobody imagined.
#
# Every refusal in the org memory existed and none of them had ever run. A
# coverage audit of this branch found eleven `throw` sites that no test
# reached, and the one at the top of the list is the one that matters most:
# the cross-org refusal in `org pull`. If that regresses, pulling in the wrong
# checkout re-parents a project to another org, and the next `org push` writes
# one client's lessons into another client's repository.
#
# The assertion shape is the same for every case here, and it is the point:
#
#   REFUSE with a message that names the problem, WRITE NOTHING, and leave the
#   store readable.
#
# A crash is a failure. A silent partial write is a worse one, because the next
# run looks like it succeeded.
#
# The JS is in files with a QUOTED heredoc — no shell expansion — because these
# blocks contain NUL bytes, backticks, `$`, quotes and SQL. In a `node -e "..."`
# string bash would run some of it. See observation 1559.
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

WORK="$(mktemp -d -t myjarbis-hostile-XXXXXX)"
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

init_project() {  # name, org-slug-or-empty
  mkdir -p "$WORK/$1" && cd "$WORK/$1" && git init -q -b master .
  git config user.email "d@$1.test" && git config user.name "Dev $1"
  git remote add origin "git@github.com:example/$1.git"
  echo x > f.txt && git add f.txt && git -c commit.gpgsign=false commit -q -m init
  "$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1
}

init_project acme
init_project globex
init_project loner

# ─── acme gets an org and one promoted note, then pushes ───
cd "$WORK/acme"
run_block seed <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession } = await import(B + '/tools/session.js');
const { saveObservation } = await import(B + '/tools/observations.js');
const { promoteObservation } = await import(B + '/tools/orgMemory.js');
const { transportFor } = await import(B + '/org/memory/transport.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const org = ctx.db.orgs.upsert({ slug: 'acme', name: 'Acme' });
  ctx.db.projects.setOrg(project.id, org.id);
  startSession(ctx, { module: '_general' });
  const o = saveObservation(ctx, {
    kind: 'gotcha',
    // Deliberately free of the project's own name: the scrub catches that,
    // correctly, and the first version of this fixture tripped over it.
    title: 'a lesson about contentless FTS indexes',
    content: 'nothing sensitive in here at all',
  });
  promoteObservation(ctx, { observation_id: o.observationId });
  const r = transportFor(ctx).push(ctx);
  t(r.appended === 1, 'acme promoted and pushed one note');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

# globex gets its own org, and a COPY of acme's committed files. This is the
# shape of the accident: a developer in the wrong checkout, or a file copied
# between repositories.
cd "$WORK/globex"
run_block seed-globex <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const out = [];
const ctx = ServerContext.initialize();
const project = ctx.requireProject();
const org = ctx.db.orgs.upsert({ slug: 'globex', name: 'Globex' });
ctx.db.projects.setOrg(project.id, org.id);
out.push('PASS|globex belongs to its own org');
ctx.close();
console.log(out.join('\n'));
JS
mkdir -p "$WORK/globex/.myjarbis/org"
cp "$WORK/acme/.myjarbis/org/"* "$WORK/globex/.myjarbis/org/"

echo "→ [1] a pull that would move a project between orgs"
cd "$WORK/globex"
run_block cross-org <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { transportFor } = await import(B + '/org/memory/transport.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const before = ctx.db.scopedOrgId;
  const notesBefore = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes').get().c;

  let err = null;
  try { transportFor(ctx).pull(ctx); } catch (e) { err = e; }
  t(err !== null, 'the pull is REFUSED');
  t(err && /Refusing to move a project between orgs/.test(String(err.message)),
    'saying exactly that, rather than failing obscurely');
  t(err && /acme/.test(String(err.message)) && /globex/.test(String(err.message)),
    'and naming both orgs so the mistake is obvious');

  t(ctx.db.scopedOrgId === before, 'the project still belongs to its own org');
  t(ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes').get().c === notesBefore,
    "and NOT ONE of the other org's notes was written");
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [2] files that are broken"
cd "$WORK/acme"
ORGDIR="$WORK/acme/.myjarbis/org"
cp -r "$ORGDIR" "$WORK/org-good"

broken_pull() {  # label, expect-refusal (true/false), regex source the message must match
  run_block "broken-$1" <<JS
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { transportFor } = await import(B + '/org/memory/transport.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const before = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes').get().c;
  let err = null;
  let res = null;
  try { res = transportFor(ctx).pull(ctx); } catch (e) { err = e; }
  const after = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes').get().c;
  const expectRefusal = ${2};
  const pattern = ${3};
  if (expectRefusal) {
    t(err !== null, '$1: refused');
    t(err && pattern.test(String(err.message)),
      err && !pattern.test(String(err.message))
        ? '$1: the message did not match ' + pattern + ' — got: ' + String(err.message).slice(0, 120)
        : '$1: and the message names the problem');
  } else {
    t(err === null, '$1: survived without throwing');
    t(res !== null && res.warnings.length > 0, '$1: and warned about it');
    t(res !== null && res.warnings.some((w) => pattern.test(w)),
      res && !res.warnings.some((w) => pattern.test(w))
        ? '$1: no warning matched ' + pattern + ' — got: ' + JSON.stringify(res.warnings).slice(0, 140)
        : '$1: with a warning that names it');
  }
  t(before === after, '$1: nothing was written (' + before + ')');
} finally { ctx.close(); }
console.log(out.join('\\n'));
JS
}

printf 'not json at all {{{\n' > "$ORGDIR/manifest.json"
broken_pull bad-manifest true "/not valid JSON/"

printf '{"format":"something-else","formatVersion":1,"org":{"slug":"acme","name":"Acme"}}\n' > "$ORGDIR/manifest.json"
broken_pull wrong-format true "/says format/"

printf '{"format":"myjarbis-org-ndjson","formatVersion":99,"org":{"slug":"acme","name":"Acme"}}\n' > "$ORGDIR/manifest.json"
broken_pull newer-format true "/newer MyJarbis/"

cp "$WORK/org-good/manifest.json" "$ORGDIR/manifest.json"
rm -f "$ORGDIR/org_note_content.ndjson"
broken_pull missing-content false "/no matching row/"
cp "$WORK/org-good/org_note_content.ndjson" "$ORGDIR/"

# An unresolved merge conflict — the case the error message names and the one
# the whole one-line-per-record format exists to make survivable.
{ cat "$WORK/org-good/org_notes.ndjson"; printf '<<<<<<< HEAD\n'; } > "$ORGDIR/org_notes.ndjson"
broken_pull merge-conflict true "/corrupt or a merge conflict/"
cp "$WORK/org-good/org_notes.ndjson" "$ORGDIR/"

# A row with no identity at all.
printf '{"project":null,"author_handle":"x","status":"active"}\n' >> "$ORGDIR/org_notes.ndjson"
broken_pull no-hash false "/no content_hash/"
cp "$WORK/org-good/org_notes.ndjson" "$ORGDIR/"

rm -rf "$ORGDIR"
broken_pull no-org-dir true "/No org memory at/"
cp -r "$WORK/org-good" "$ORGDIR"

echo "→ [3] a project in no org"
cd "$WORK/loner"
run_block no-org <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession } = await import(B + '/tools/session.js');
const { saveObservation } = await import(B + '/tools/observations.js');
const { promoteObservation, listOrgNotes } = await import(B + '/tools/orgMemory.js');
const { transportFor } = await import(B + '/org/memory/transport.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });
  const o = saveObservation(ctx, { kind: 'gotcha', title: 'a local lesson', content: 'body' });

  // Counted BEFORE, not compared against zero: this is a shared brain and
  // another project's org legitimately holds notes. "Nothing was written" is a
  // statement about the delta, not about the table.
  const before = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes').get().c;

  let e1 = null;
  try { promoteObservation(ctx, { observation_id: o.observationId }); } catch (e) { e1 = e; }
  t(e1 !== null && String(e1.type) === 'NO_ORG', 'promoting is refused with NO_ORG');
  t(e1 && /belongs to no org/.test(String(e1.message)), 'and says why');

  let e2 = null;
  try { transportFor(ctx).push(ctx); } catch (e) { e2 = e; }
  t(e2 !== null && String(e2.type) === 'NO_ORG', 'pushing is refused with NO_ORG');

  const notes = listOrgNotes(ctx, {});
  t(notes.org === null && notes.count === 0, 'and listing reports no org rather than failing');

  // A promotion that cannot happen must not leave anything behind.
  const after = ctx.db.db.prepare('SELECT COUNT(*) AS c FROM org_notes').get().c;
  t(before === after, 'and the refused promotion wrote nothing (' + before + ')');
  t(ctx.db.scopedOrgId === null, 'while the project still belongs to no org');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [4] input nobody imagined"
cd "$WORK/acme"
run_block hostile-input <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { startSession } = await import(B + '/tools/session.js');
const { saveObservation } = await import(B + '/tools/observations.js');
const { promoteObservation } = await import(B + '/tools/orgMemory.js');
const { setWorkflowStep, getWorkflow } = await import(B + '/tools/workflows.js');
const { scrubOrgNote } = await import(B + '/org/scrub.js');
const { findSecretsInText } = await import(B + '/org/secrets.js');
const { scrubContextFor } = await import(B + '/tools/orgMemory.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });

  // A megabyte of content. The interesting part is not whether it is accepted
  // but whether the scrub, which scans every field once per rule, finishes.
  const big = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'a very large lesson',
    content: 'x'.repeat(1024 * 1024),
  });
  const t0 = process.hrtime.bigint();
  const r = promoteObservation(ctx, { observation_id: big.observationId });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t(r.status === 'inserted', 'a 1 MB note is promoted rather than rejected or hung');
  t(ms < 5000, 'in ' + ms.toFixed(0) + ' ms (budget 5000)');

  // Control characters and bidirectional text in every scrubbed field. NUL is
  // the one that matters: it is the hash separator.
  const weird = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'a lesson with   and ‮ and ́ in it',
    content: 'body with   NUL, ‮ RTL override, and combining ́ marks',
  });
  const w = promoteObservation(ctx, { observation_id: weird.observationId });
  t(w.status === 'inserted', 'control characters and RTL survive promotion');
  const stored = ctx.db.orgNotes.findById(w.orgNoteId);
  t(stored !== null && stored.question.includes('‮'), 'and are stored as written');

  // Two notes differing ONLY by where a NUL falls must not collide, because
  // NUL is what joins the fields in the hash.
  const a = { question: 'ab', answer: 'c', typeTags: 'gotcha' };
  const b = { question: 'a', answer: 'bc', typeTags: 'gotcha' };
  const ha = ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: null, draft: a });
  const hb = ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: null, draft: b });
  t(ha !== hb, 'moving text across a field boundary changes the hash');

  // SQL in the content. Parameter binding should make this unremarkable, and
  // "unremarkable" is exactly the assertion.
  const sqli = saveObservation(ctx, {
    kind: 'gotcha',
    title: "a lesson about '; DROP TABLE org_notes; --",
    content: "the string '; DROP TABLE org_notes; -- appears in a log line",
  });
  const s = promoteObservation(ctx, { observation_id: sqli.observationId });
  t(s.status === 'inserted', 'SQL in the text is just text');
  t(ctx.db.db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='org_notes'").get().c === 1,
    'and the table is still there');

  // A step name with a traversal in it. It is not a path, but it is the shape
  // somebody will try, and it must not become one.
  let e1 = null;
  try { setWorkflowStep(ctx, { slug: 'trav', name: '../../etc/passwd', scope: 'project', actor: 'agent' }); }
  catch (e) { e1 = e; }
  t(e1 !== null, 'a step name containing a slash is refused');

  // An absurd slug. Bounded by the schema rather than by hope.
  let e2 = null;
  try { setWorkflowStep(ctx, { slug: 'z'.repeat(10000), name: 'x', scope: 'project', actor: 'agent' }); }
  catch (e) { e2 = e; }
  t(e2 !== null, 'a 10,000-character slug is refused');

  // code_refs pointing outside the repository: git does not know the path, so
  // it contributes nothing rather than being recorded as missing.
  const outside = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'a lesson citing something outside the repo',
    content: 'body',
    files: '/etc/shadow,../../../../etc/passwd',
  });
  const o = promoteObservation(ctx, { observation_id: outside.observationId });
  const row = ctx.db.orgNotes.findById(o.orgNoteId);
  t(row.code_refs === null, 'paths outside the repository become no code_refs at all');

  // And the scrub still works on all of it.
  const sc = scrubContextFor(ctx);
  const clean = scrubOrgNote({ answer: 'x'.repeat(100000) }, sc);
  t(clean.findings.length === 0, 'a large clean field produces no findings');

  // The secret scan must be LINEAR in the length of the text, and this is the
  // assertion rather than a wall-clock budget because of how the bug behaved:
  // one pattern had an unbounded quantifier before a required literal, so the
  // engine matched a long run and backtracked it one character at a time from
  // every starting position. 2 ms at 2 KB, 413 ms at 32 KB — and about seven
  // MINUTES on a megabyte, scanned twice per field. `promote_observation`
  // simply never returned.
  //
  // A time budget would catch that only after waiting for it. A ratio catches
  // it in milliseconds: quadratic means 4x the work for 2x the input, so
  // anything near that fails here while the absolute numbers are still tiny.
  const scan = (n) => {
    const s = 'x'.repeat(n);
    const t0 = process.hrtime.bigint();
    findSecretsInText(s);
    return Math.max(Number(process.hrtime.bigint() - t0) / 1e6, 0.01);
  };
  scan(16000); // warm up, so the first JIT pass is not charged to the small one
  const small = scan(32000);
  const large = scan(128000);
  const ratio = large / small;
  // 4x the input. Linear is ~4, quadratic is ~16. Fail above 9, which leaves
  // room for noise on a loaded machine without leaving room for a quadratic.
  t(ratio < 9,
    'the secret scan is linear in the text length: 4x input cost ' +
      ratio.toFixed(1) + 'x time (' + small.toFixed(1) + ' -> ' + large.toFixed(1) + ' ms, fail above 9x)');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [5] a project named after one of the scrub's own placeholders"
#
# A project literally called `repo` used to make EVERY promotion fail: the
# first pass rewrites a path to `<repo>`, the second pass finds the project
# name inside that replacement, and the promotion is refused with "this needs
# wording by a person" about a note that was already clean. A gate that fails
# closed on correct input is a gate people switch off.
run_block placeholder-name <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { scrubOrgNote } = await import(B + '/org/scrub.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const sc = {
    homeDir: '/home/d',
    projectPath: '/home/d/work/app',
    selfProjectName: 'app',
    otherProjects: [
      { name: 'repo', modules: 4 },
      { name: 'machine', modules: 2 },
      { name: 'northwind-crm', modules: 18 },
    ],
  };
  const once = scrubOrgNote({ answer: 'it reads /home/d/work/app/x.ts on northwind-crm' }, sc);
  t(once.findings.length === 2, 'the path and the real client name are both caught');
  t(once.rewritten.answer === 'it reads <repo>/x.ts on the 18-module project',
    'and rewritten: ' + JSON.stringify(once.rewritten.answer));
  const twice = scrubOrgNote(once.rewritten, sc);
  t(twice.findings.length === 0,
    twice.findings.length === 0
      ? 'and a second pass finds nothing, so the promotion is not refused'
      : 'a second pass flagged the placeholder: ' + JSON.stringify(twice.findings.map((f) => f.excerpt)));
} finally { ctx.close(); }
console.log(out.join('\n'));
JS

echo "→ [6] the scrub with no registry at all"
#
# `scrubContextFor` swallows a registry failure, and the comment says "a
# missing registry weakens the gate; it must not disable it". Nothing proved
# either half of that: not that the other rules still fire, and not that the
# weakening is only the project-name rule.
cd "$WORK/acme"
mv "$MYJARBIS_REGISTRY" "$WORK/registry.moved"
run_block no-registry <<'JS'
const B = process.env.MJ_BUILD;
const { ServerContext } = await import(B + '/context.js');
const { scrubOrgNote } = await import(B + '/org/scrub.js');
const { scrubContextFor } = await import(B + '/tools/orgMemory.js');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const sc = scrubContextFor(ctx);
  t(true, 'building the scrub context does not throw without a registry');
  const r = scrubOrgNote({
    answer: 'token ghp_abcdefghijklmnopqrstuvwxyz0123 at /home/x/y.ts on jenkins.corp and 10.0.0.9',
  }, sc);
  const rules = new Set(r.findings.map((f) => f.rule));
  t(rules.has('secret'), 'secrets are still caught');
  t(rules.has('home_path'), 'local paths are still caught');
  t(rules.has('internal_host'), 'internal hosts are still caught');
  t(!/ghp_/.test(r.rewritten.answer), 'and the rewrite still redacts the token');
  // The brain still knows the project names even with no registry file, which
  // is why the degradation is smaller than the comment feared.
  t(sc.selfProjectName === 'acme', 'and the project still knows its own name');
} finally { ctx.close(); }
console.log(out.join('\n'));
JS
mv "$WORK/registry.moved" "$MYJARBIS_REGISTRY"

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-hostile E2E PASSED"
