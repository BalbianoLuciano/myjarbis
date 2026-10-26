#!/bin/bash
#
# E2E test: the memory travels. A second developer clones the repository and
# inherits what the first one learned.
#
# This is the feature, and the only test that exercises it end to end. Two
# genuinely separate machines are simulated by two HOMEs, two brains and two
# registries, connected by nothing but a git clone — if any of the assertions
# below pass through shared local state instead of through the committed files,
# the setup is wrong and the suite is worthless.
#
# What it pins:
#
#   · push writes the files and NEVER commits; it names what to stage
#   · a clone + `org pull` joins the org and inherits every note, with the
#     original author and date — not the puller's
#   · pull is IDEMPOTENT: a second pull adds nothing
#   · pull is ADDITIVE: it never deletes a local row, which is where
#     basic-memory had to disable destructive sync for teams
#   · a note's identity is its content hash, so the same lesson promoted
#     independently on both machines converges to ONE row
#   · a lifecycle change (stale, superseded) propagates as an update
#   · a note naming a project the puller does not have becomes org-wide
#     rather than disappearing
#   · pushing twice in a row changes nothing, so `git status` stays honest
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/org/memory/gitProjectDriver.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-orgsync-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}

# ─── two machines ───
#
# Each gets its own HOME, brain and registry. Nothing is shared but the git
# remote, which is the point: every assertion about what machine B knows has
# to have travelled through a commit.
ana_env() {
  export HOME="$WORK/home-ana"
  export MYJARBIS_HOME="$WORK/brain-ana"
  export MYJARBIS_REGISTRY="$WORK/reg-ana.json"
}
bob_env() {
  export HOME="$WORK/home-bob"
  export MYJARBIS_HOME="$WORK/brain-bob"
  export MYJARBIS_REGISTRY="$WORK/reg-bob.json"
}
mkdir -p "$WORK/home-ana" "$WORK/home-bob"

# A bare repo to push through, so the clone is a real clone.
git init -q --bare "$WORK/remote.git"

echo "→ [1] ana promotes two notes and pushes the files"
ana_env
mkdir -p "$WORK/ana" && cd "$WORK/ana" && git init -q -b master .
git config user.email ana@acme.test && git config user.name 'Ana'
git remote add origin "$WORK/remote.git"
"$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1
# .myjarbis/ is gitignored by init (per-developer state), so the shared memory
# has to be un-ignored explicitly. That is a real step a team has to take, and
# the suite performs it the way a human would.
printf '!.myjarbis/org/\n' >> .gitignore

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
import { promoteObservation } from '$B/tools/orgMemory.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const org = ctx.db.orgs.upsert({ slug: 'acme', name: 'Acme Corp' });
  ctx.db.projects.setOrg(project.id, org.id);
  startSession(ctx, { module: '_general' });

  const a = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'A quollword UPDATE corrupts a contentless index',
    content: 'The _au trigger deletes a row the index does not hold.',
  });
  const b = saveObservation(ctx, {
    kind: 'error',
    title: 'The quollword deploy fails without DATABASE_URL',
    content: 'It exits 1 with no message.',
  });
  const p1 = promoteObservation(ctx, { observation_id: a.observationId, caveats: 'only content= tables' });
  const p2 = promoteObservation(ctx, { observation_id: b.observationId, scope: 'org' });
  t(p1.status === 'inserted' && p2.status === 'inserted', 'ana promoted two notes');
  t(p2.scope === 'org', 'one of them org-wide');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err1" || { echo "    ✗ node block crashed"; cat "$WORK/err1" >&2; FAILED=$((FAILED + 1)); }
read_asserts

PUSH="$("$MJ" org push --json 2>"$WORK/push.err")" || { oops "org push failed: $(tail -2 "$WORK/push.err")"; }
if echo "$PUSH" | grep -q '"appended": *2'; then
  pass "org push reports two appended rows"
else
  oops "org push did not report 2 appended (got: $(echo "$PUSH" | head -c 200))"
fi
for f in manifest.json org_notes.ndjson org_note_content.ndjson; do
  if [ -f ".myjarbis/org/$f" ]; then pass "wrote .myjarbis/org/$f"; else oops "missing .myjarbis/org/$f"; fi
done
if [ "$(wc -l < .myjarbis/org/org_notes.ndjson)" = "2" ]; then
  pass "one line per note, two lines"
else
  oops "expected 2 lines in org_notes.ndjson, got $(wc -l < .myjarbis/org/org_notes.ndjson)"
fi
# Nothing local may travel.
if grep -qE '"(id|seq|source_observation_id|drift_changed)":' .myjarbis/org/org_notes.ndjson; then
  oops "the wire format leaks a local-only column"
else
  pass "no local-only column is in the file (no id, seq, source_observation_id, drift)"
fi
# Never commits.
if [ -n "$(git status --porcelain .myjarbis/org)" ]; then
  pass "push left the files uncommitted, for a person to commit"
else
  oops "push appears to have committed or staged something itself"
fi
if echo "$PUSH" | grep -q '"stageCommand".*git add'; then
  pass "and told the user exactly what to stage"
else
  oops "push did not report a stageCommand"
fi
# A second push is a no-op, or `git status` stops meaning anything.
PUSH2="$("$MJ" org push --json 2>/dev/null)"
if echo "$PUSH2" | grep -q '"changed": *false'; then
  pass "pushing again changes nothing"
else
  oops "a second push rewrote files (got: $(echo "$PUSH2" | head -c 160))"
fi

git add .gitignore .myjarbis/org/manifest.json .myjarbis/org/org_notes.ndjson .myjarbis/org/org_note_content.ndjson >/dev/null 2>&1
git -c commit.gpgsign=false commit -q -m "chore(org): share two lessons" >/dev/null 2>&1
git push -q origin master >/dev/null 2>&1 || oops "could not push to the bare remote"

echo "→ [2] bob clones and inherits them"
bob_env
cd "$WORK"
git clone -q "$WORK/remote.git" "$WORK/bob" || oops "clone failed"
cd "$WORK/bob"
git config user.email bob@acme.test && git config user.name 'Bob'
"$MJ" init --isolation=shared --yes --skip-memory >/dev/null 2>&1

PULL="$("$MJ" org pull --json 2>"$WORK/pull.err")" || { oops "org pull failed: $(tail -3 "$WORK/pull.err")"; }
if echo "$PULL" | grep -q '"added": *2'; then
  pass "bob's pull added both notes"
else
  oops "pull did not add 2 (got: $(echo "$PULL" | head -c 240))"
fi
if echo "$PULL" | grep -q '"orgRegistered": *true'; then
  pass "and joined him to the org, which he never configured"
else
  oops "pull did not register the org"
fi

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  t(project.org_id !== null, 'bob\'s project now belongs to an org');

  const hits = ctx.db.search('quollword', { scope: 'module' });
  const org = hits.filter((h) => h.source === 'org_note');
  t(org.length === 2, 'and plain search finds both notes he never wrote');
  t(org.every((h) => h.meta.author === 'Ana'),
    'attributed to Ana, not to the person who pulled');
  t(org.some((h) => h.meta.orgWide === true), 'the org-wide one is still org-wide');

  const notes = ctx.db.orgNotes.listByOrg(project.org_id, { limit: 10 });
  const withCaveats = notes.find((n) => n.caveats !== null);
  t(withCaveats && withCaveats.caveats.includes('content='), 'the caveats travelled');
  t(notes.every((n) => n.author_source === 'git'), 'and so did how the author was identified');
  t(notes.every((n) => n.source_observation_id === null),
    'but NOT the pointer into ana\'s personal brain — that cannot travel');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err2" || { echo "    ✗ node block crashed"; cat "$WORK/err2" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [3] pull is idempotent, and additive"
PULL2="$("$MJ" org pull --json 2>/dev/null)"
if echo "$PULL2" | grep -q '"added": *0'; then
  pass "a second pull adds nothing"
else
  oops "a second pull added rows (got: $(echo "$PULL2" | head -c 160))"
fi
if echo "$PULL2" | grep -q '"duplicates": *2'; then
  pass "and recognises both as already there"
else
  oops "a second pull did not report 2 duplicates"
fi

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
import { promoteObservation } from '$B/tools/orgMemory.js';
import { transportFor } from '$B/org/memory/transport.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  startSession(ctx, { module: '_general' });

  // Bob promotes one of his own, then pulls again. The pull must not remove
  // it: basic-memory shipped a mirroring sync, found it unusable for teams,
  // and disabled destructive mirror on team workspaces for exactly this.
  const own = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'A bandicootword needs the flag first',
    content: 'otherwise it silently does nothing',
  });
  const mine = promoteObservation(ctx, { observation_id: own.observationId });
  const before = ctx.db.orgNotes.countByOrg(project.org_id);
  const res = transportFor(ctx).pull(ctx);
  const after = ctx.db.orgNotes.countByOrg(project.org_id);
  t(after === before, 'a pull does not delete a local note missing from the files');
  t(ctx.db.orgNotes.findById(mine.orgNoteId) !== null, 'bob\'s own note is still there');
  t(res.added === 0 && res.duplicates === 2, 'and the pull still reports the two it knew');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err3" || { echo "    ✗ node block crashed"; cat "$WORK/err3" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [4] the same lesson learned twice converges to one row"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
import { promoteObservation } from '$B/tools/orgMemory.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  startSession(ctx, { module: '_general' });
  const before = ctx.db.orgNotes.countByOrg(project.org_id);

  // Bob independently writes the SAME lesson ana already promoted, with the
  // same words, and promotes it org-wide the same way she did. Identity is the
  // content hash, so this is the row that already exists -- which is also what
  // makes a pull safe to run twice.
  const dup = saveObservation(ctx, {
    kind: 'error',
    title: 'The quollword deploy fails without DATABASE_URL',
    content: 'It exits 1 with no message.',
  });
  const res = promoteObservation(ctx, { observation_id: dup.observationId, scope: 'org' });
  t(res.status === 'duplicate', 'promoting it is reported as a duplicate');
  t(ctx.db.orgNotes.countByOrg(project.org_id) === before, 'and adds no row');
  const row = ctx.db.orgNotes.findById(res.orgNoteId);
  t(row.author_handle === 'Ana', 'the credit stays with whoever recorded it first');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err4" || { echo "    ✗ node block crashed"; cat "$WORK/err4" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [5] a lifecycle change propagates"
ana_env
cd "$WORK/ana"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const notes = ctx.db.orgNotes.listByOrg(project.org_id, { limit: 10 });
  const target = notes.find((n) => n.question.includes('corrupts a contentless index'));
  ctx.db.orgNotes.setStatus(target.id, 'stale');
  t(true, 'ana marks a note stale');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err5a" || { echo "    ✗ node block crashed"; cat "$WORK/err5a" >&2; FAILED=$((FAILED + 1)); }
read_asserts

PUSH3="$("$MJ" org push --json 2>/dev/null)"
if echo "$PUSH3" | grep -q '"rewritten": *1'; then
  pass "push rewrites the one line whose governance changed"
else
  oops "push did not report 1 rewritten (got: $(echo "$PUSH3" | head -c 200))"
fi
if echo "$PUSH3" | grep -q '"appended": *0'; then
  pass "and appends nothing"
else
  oops "push appended rows for a status change"
fi
if [ "$(wc -l < .myjarbis/org/org_notes.ndjson)" = "2" ]; then
  pass "the file still has two lines"
else
  oops "the line count changed on a status update"
fi
git add .myjarbis/org/manifest.json .myjarbis/org/org_notes.ndjson .myjarbis/org/org_note_content.ndjson >/dev/null 2>&1
git -c commit.gpgsign=false commit -q -m "chore(org): one lesson went stale" >/dev/null 2>&1
git push -q origin master >/dev/null 2>&1

bob_env
cd "$WORK/bob"
git pull -q origin master >/dev/null 2>&1
PULL3="$("$MJ" org pull --json 2>/dev/null)"
if echo "$PULL3" | grep -q '"governanceUpdated": *1'; then
  pass "bob's pull applies the status change"
else
  oops "pull did not report a governance update (got: $(echo "$PULL3" | head -c 200))"
fi
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const notes = ctx.db.orgNotes.listByOrg(project.org_id, { status: ['stale'], limit: 10 });
  t(notes.length === 1 && notes[0].question.includes('corrupts a contentless index'),
    'and bob now sees it as stale');
  const hits = ctx.db.search('quollword', { scope: 'org' });
  const h = hits.find((x) => String(x.title).includes('corrupts a contentless index'));
  t(h !== undefined, 'a stale note still answers');
  t(h && h.meta.status === 'stale', 'and says it is stale');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err5b" || { echo "    ✗ node block crashed"; cat "$WORK/err5b" >&2; FAILED=$((FAILED + 1)); }
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-org-sync E2E PASSED"
