#!/bin/bash
#
# E2E test: the org memory mirror, and the boundary around it.
#
# The boundary is the point of this suite. graphiti ships tenant scope as a
# PARAMETER (`group_id`) and has six open issues where it leaks: UUID-addressed
# reads and deletes crossing groups (#2020), writes going to one database while
# reads answer from another (#1876), an unknown group silently reading the
# default one (#1932), a shared driver answering from whichever group was
# written last (#1795). Every one of those is the same mistake — a scope the
# caller supplies is a scope the caller can get wrong.
#
# So `org_notes` derives its tenant from the bound project and never accepts
# it, and this suite is what proves the derivation holds. Two orgs, two
# projects, ONE shared brain, which is the arrangement where a leak is possible
# at all.
#
# What it pins:
#
#   · a promoted note is found by plain `search`, with no new scope to opt in
#   · it arrives marked as org, with its author and the date it was promoted
#   · a SECOND org's note never appears, by search or by id
#   · the same lesson promoted twice is one row, by constraint and not by a
#     check the application performs before inserting
#   · superseded and deleted notes never surface; a stale or expired one does,
#     flagged, because expiry is a warning and not a removal
#   · a project in no org performs no org query at all
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

WORK="$(mktemp -d -t myjarbis-orgmem-XXXXXX)"
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

# ─── three projects in ONE shared brain ───
#
# `--isolation=shared` is what puts them in the same file, which is the only
# configuration where one project can reach another's rows — and therefore the
# only one in which the boundary this suite checks can be tested at all.
for p in alpha beta solo; do
  mkdir -p "$WORK/$p" && cd "$WORK/$p" && git init -q .
  git config user.email "dev@$p.test" && git config user.name "Dev Of $p"
  git remote add origin "git@github.com:example/$p.git"
  if ! "$MJ" init --isolation=shared --yes --skip-memory >"$WORK/init-$p.log" 2>&1; then
    echo "    ✗ init failed for $p: $(tail -3 "$WORK/init-$p.log")"
    exit 1
  fi
done
# All three must be in ONE file, or section [2] proves nothing.
if [ "$(ls -1 "$WORK"/*/.myjarbis/memory.db 2>/dev/null | wc -l)" -ne 0 ]; then
  echo "    ✗ a per-project silo was created; the suite needs the shared brain"
  exit 1
fi

echo "→ [1] a note reaches the mirror and is found by plain search"
cd "$WORK/alpha"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();

  // Join an org. This is what 'org add' does with a pack; here the row is
  // made directly, because the pack is not what is under test.
  const org = ctx.db.orgs.upsert({ slug: 'acme', name: 'Acme' });
  ctx.db.projects.setOrg(project.id, org.id);

  const draft = {
    question: 'why does a zebraword UPDATE corrupt the index',
    answer: 'The _au trigger issues a delete op for a row the index does not hold.',
    workingExample: \"INSERT INTO t_fts(t_fts) VALUES('rebuild') first\",
    caveats: 'Only with content= tables.',
    typeTags: 'gotcha',
  };
  const hash = ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: project.name, draft });
  const added = ctx.db.orgNotes.add({
    orgId: org.id,
    projectId: project.id,
    author: { handle: 'ana', email: 'ana@acme.test', source: 'git' },
    draft,
    contentHash: hash,
  });
  t(added.status === 'inserted', 'the note is inserted');
  t(added.row.seq === 1, 'and takes the first local sequence number');
  t(typeof added.row.expires_at === 'string', 'with an expiry set by default');

  // Promoting the SAME lesson again is one row. By constraint: add() does an
  // ON CONFLICT DO NOTHING and then reads, never a check followed by an
  // insert -- mem0 #6515 is a permanent-duplicate bug from exactly that gap.
  const again = ctx.db.orgNotes.add({
    orgId: org.id,
    projectId: project.id,
    author: { handle: 'carlos', email: null, source: 'config' },
    draft,
    contentHash: hash,
  });
  t(again.status === 'duplicate', 'the same lesson promoted again is a duplicate');
  t(again.row.id === added.row.id, 'and resolves to the same row');
  t(again.row.author_handle === 'ana', 'whose author is still the first person to record it');
  t(ctx.db.orgNotes.countByOrg(org.id) === 1, 'so the org holds exactly one note');

  // The retrieval requirement: found by the search the agent already calls,
  // with no new scope to remember.
  const hits = ctx.db.search('zebraword', { scope: 'module' });
  const orgHit = hits.find((h) => h.source === 'org_note');
  t(orgHit !== undefined, 'plain search(scope=module) returns the org note');
  if (orgHit) {
    t(orgHit.meta.source === 'org', 'marked as coming from the org');
    t(orgHit.meta.author === 'ana', 'with the author who recorded it');
    t(typeof orgHit.meta.promotedAt === 'string', 'and when');
    t(orgHit.meta.confidence === 'assumed', 'and assumed confidence, having no evidence');
    t(orgHit.meta.drift === null, 'with drift unknown rather than zero, never having been checked');
    t(orgHit.title === draft.question, 'and the question as its title');
  }

  // scope='org' narrows to the org memory alone.
  const only = ctx.db.search('zebraword', { scope: 'org' });
  t(only.length > 0 && only.every((h) => h.source === 'org_note'),
    \"scope='org' returns org notes and nothing else\");

  // An ORG-WIDE note: project_id IS NULL, so it applies to every project of
  // the org. This is the row that matters for the boundary in section [2].
  //
  // A project-scoped note from another org is excluded by the project filter
  // even if the org filter were broken, so testing only those would prove
  // nothing about the org filter at all. Found by deleting the org filter on
  // purpose and watching the suite stay green.
  const wide = {
    question: 'what does quokkaword mean across the whole org',
    answer: 'it is an org-wide convention, not a project one',
    typeTags: 'convention',
  };
  const wideAdded = ctx.db.orgNotes.add({
    orgId: org.id,
    projectId: null,
    author: { handle: 'ana', email: null, source: 'git' },
    draft: wide,
    contentHash: ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: null, draft: wide }),
  });
  t(wideAdded.row.project_id === null, 'an org-wide note is stored with no project');
  const wideHits = ctx.db.search('quokkaword', { scope: 'module' });
  t(wideHits.some((h) => h.source === 'org_note' && h.meta.orgWide === true),
    'and alpha, which is in that org, finds it and is told it is org-wide');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err1" || { echo "    ✗ node block crashed"; cat "$WORK/err1" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [2] a second org's notes are unreachable — the assertion this suite exists for"
cd "$WORK/beta"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  t(project.name === 'beta', 'this connection resolved to beta');

  const org = ctx.db.orgs.upsert({ slug: 'globex', name: 'Globex' });
  ctx.db.projects.setOrg(project.id, org.id);

  const draft = {
    question: 'why does zebraword time out in globex',
    answer: 'a different reason entirely',
    typeTags: 'gotcha',
  };
  const hash = ctx.db.orgNotes.hashOf({ orgSlug: 'globex', projectName: project.name, draft });
  ctx.db.orgNotes.add({
    orgId: org.id,
    projectId: project.id,
    author: { handle: 'bob', email: null, source: 'git' },
    draft,
    contentHash: hash,
  });

  const hits = ctx.db.search('zebraword', { scope: 'module' });
  const orgHits = hits.filter((h) => h.source === 'org_note');
  t(orgHits.length === 1, 'beta sees exactly one org note');
  t(orgHits[0].meta.author === 'bob', 'and it is its own, not acme\'s');
  t(!hits.some((h) => String(h.title).includes('corrupt the index')),
    \"acme's project-scoped note does not appear in beta's search\");

  // THE assertion. An org-wide note has project_id IS NULL, so the project
  // filter does not exclude it: the ONLY thing keeping it out of beta is the
  // org filter being derived from the bound project rather than passed in.
  const wideHits = ctx.db.search('quokkaword', { scope: 'org' });
  t(wideHits.length === 0,
    \"acme's ORG-WIDE note is invisible to beta — the only thing stopping it is the org filter\");
  const everything = ctx.db.search('quokkaword', { scope: 'project' });
  t(!everything.some((h) => h.source === 'org_note'),
    'and widening the scope to the whole project does not reach it either');

  // The leak graphiti #2020 is: addressed by id, the scope check is skipped.
  // Here the id is known and the read still refuses.
  const acmeNote = ctx.db.db
    .prepare(\"SELECT n.id FROM org_notes n JOIN orgs o ON o.id = n.org_id WHERE o.slug = 'acme'\")
    .get();
  t(acmeNote !== undefined, \"acme's note is in the same file (so a leak was possible)\");
  let threw = null;
  try { ctx.db.orgNotes.findById(acmeNote.id); } catch (e) { threw = e; }
  t(threw !== null && String(threw.type) === 'OUT_OF_SCOPE',
    'reading it BY ID from beta is refused, not merely absent from search');

  let threw2 = null;
  try { ctx.db.orgNotes.listByOrg(1); } catch (e) { threw2 = e; }
  const beta = ctx.db.orgs.findBySlug('globex');
  t(beta !== null, 'globex resolves');
  if (beta && beta.id !== 1) {
    t(threw2 !== null, 'and asking for another org by id is refused');
  } else {
    t(true, 'globex happens to be org 1; the id-based refusal is covered above');
  }
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err2" || { echo "    ✗ node block crashed"; cat "$WORK/err2" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [3] lifecycle: superseded and deleted go quiet, expired speaks up"
cd "$WORK/alpha"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  const org = ctx.db.orgs.findBySlug('acme');

  const mk = (q, over = {}) => {
    const draft = { question: q, answer: 'body of ' + q, typeTags: 'gotcha' };
    return ctx.db.orgNotes.add({
      orgId: org.id,
      projectId: project.id,
      author: { handle: 'ana', email: null, source: 'git' },
      draft,
      contentHash: ctx.db.orgNotes.hashOf({ orgSlug: 'acme', projectName: project.name, draft }),
      ...over,
    }).row;
  };

  const old = mk('quaxolotl the old way');
  const neu = mk('quaxolotl the new way');
  ctx.db.orgNotes.setStatus(old.id, 'superseded', neu.id);
  const gone = mk('quaxolotl a wrong lesson');
  ctx.db.orgNotes.setStatus(gone.id, 'deleted');
  const expired = mk('quaxolotl something aged', { expiresAt: '2020-01-01 00:00:00' });
  const stale = mk('quaxolotl something rotting');
  ctx.db.orgNotes.setStatus(stale.id, 'stale');

  const hits = ctx.db.search('quaxolotl', { scope: 'org' });
  const titles = hits.map((h) => h.title);
  t(!titles.some((x) => x.includes('the old way')), 'a superseded note does not surface');
  t(!titles.some((x) => x.includes('a wrong lesson')), 'nor a deleted one');
  t(titles.some((x) => x.includes('the new way')), 'the replacement does');
  t(titles.some((x) => x.includes('something aged')), 'an expired note still surfaces');
  t(titles.some((x) => x.includes('something rotting')), 'and so does a stale one');

  const exp = hits.find((h) => String(h.title).includes('something aged'));
  t(exp && exp.meta.expired === true, 'the expired one says so');
  const st = hits.find((h) => String(h.title).includes('something rotting'));
  t(st && st.meta.status === 'stale', 'and the stale one reports its status');

  // Nothing is ever removed: the row and its provenance stay readable, which
  // is the whole reason the next person does not learn it again.
  const deletedRow = ctx.db.orgNotes.findById(gone.id);
  t(deletedRow !== null && deletedRow.status === 'deleted',
    'a deleted note is still a row, with its author and its text');
  const successor = ctx.db.orgNotes.findById(neu.id);
  t(successor.supersedes_id === old.id,
    'and the successor points back at what it replaced');

  // A degraded note is ranked below a healthy one of equal textual match.
  const healthy = hits.find((h) => String(h.title).includes('the new way'));
  t(healthy && st && healthy.rank < st.rank,
    'a healthy note outranks a stale one (rank is negative; lower is better)');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err3" || { echo "    ✗ node block crashed"; cat "$WORK/err3" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [4] a project in no org runs no org query"
cd "$WORK/solo"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const project = ctx.requireProject();
  t(project.org_id === null, 'solo belongs to no org');
  t(ctx.db.scopedOrgId === null, 'so there is no org scope to read');

  // Every project on this machine is in this state. If the org path were
  // reachable with a sentinel id, or run and discarded, this is where it
  // would start returning other people's rows.
  const hits = ctx.db.search('zebraword', { scope: 'module' });
  t(!hits.some((h) => h.source === 'org_note'), 'and no org note can reach its search');
  const asOrg = ctx.db.search('zebraword', { scope: 'org' });
  t(asOrg.length === 0, \"not even with scope='org' asked for explicitly\");
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err4" || { echo "    ✗ node block crashed"; cat "$WORK/err4" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [5] what gets proposed, and what never does"
cd "$WORK/alpha"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
import { proposePromotions } from '$B/tools/orgMemory.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const s = startSession(ctx, { module: '_general' });

  const g = saveObservation(ctx, { kind: 'gotcha', title: 'A wombatword breaks the build', content: 'because of the thing' });
  const e = saveObservation(ctx, { kind: 'error', title: 'The wombatword deploy is red', content: 'missing env var' });
  const p = saveObservation(ctx, { kind: 'progress', title: 'wombatword story done', content: 'shipped' });
  const dLocal = saveObservation(ctx, { kind: 'decision', title: 'Use a local cache here', content: 'for this module only' });
  const dTeam = saveObservation(ctx, { kind: 'decision', title: 'Commits carry Why and What for', content: 'everywhere', topic_key: 'conventions/commit-format' });

  t(g.promotable === true, 'saving a gotcha reports it as promotable');
  t(e.promotable === true, 'and so does an error');
  t(p.promotable === undefined, 'a progress note is not flagged');

  const prop = proposePromotions(ctx, { sessionId: s.sessionId });
  const ids = prop.proposals.map((x) => x.observationId);
  t(prop.org && prop.org.slug === 'acme', 'the proposal names the org');
  t(ids.includes(g.observationId), 'a gotcha is proposed');
  t(ids.includes(e.observationId), 'an error is proposed');
  t(!ids.includes(p.observationId), 'a progress note is NEVER proposed');
  t(!ids.includes(dLocal.observationId), 'a local decision is not proposed');
  t(ids.includes(dTeam.observationId), 'but a decision under a conventions/ topic key is');
  t(prop.proposals.find((x) => x.observationId === dTeam.observationId).reason === 'decision-convention',
    'and it says why');

  // The display is rendered server-side and bounded, like the module menu.
  t(prop.display.includes('acme'), 'the display names the org');
  t(prop.display.includes('never promoted'), 'and states what can never travel');
  t(prop.display.length < 1200, 'and stays small enough to print at a close');

  // An explicitly named id overrides the kind rules -- a default that cannot
  // be overridden is wrong about something sooner or later.
  const forced = proposePromotions(ctx, { observationIds: [p.observationId] });
  t(forced.proposals.length === 1 && forced.proposals[0].reason === 'asked-for',
    'a progress note named explicitly IS offered, marked as asked-for');

  // And the close carries the offer, which is the only moment it is cheap.
  const closed = endSession(ctx, { summary: 'did some things', next_session: 'do the next things' });
  t(closed.promotionProposals !== undefined, 'end_session carries the proposals');
  t(closed.promotionProposals.count >= 3, 'with a count of what is still open');
  t(closed.promotionProposals.org === 'acme', 'and the org they would go to');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err5" || { echo "    ✗ node block crashed"; cat "$WORK/err5" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [6] the gate blocks, and nothing is written when it does"
cd "$WORK/alpha"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
import { promoteObservation } from '$B/tools/orgMemory.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });
  const org = ctx.db.orgs.findBySlug('acme');
  const before = ctx.db.orgNotes.countByOrg(org.id);

  const leaky = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'The numbatword path matters',
    content: 'It reads $WORK/alpha/src/a.ts and the token is ghp_abcdefghijklmnopqrstuvwxyz0123',
  });

  let err = null;
  try { promoteObservation(ctx, { observation_id: leaky.observationId }); } catch (e) { err = e; }
  t(err !== null && String(err.type) === 'ORG_NOTE_UNSAFE', 'a leaky note is refused');
  t(ctx.db.orgNotes.countByOrg(org.id) === before,
    'and NOTHING was written -- the assertion that matters most in this file');
  t(err && String(err.message).includes('→'), 'the refusal shows the proposed rewrite');
  t(err && err.details && err.details.findings.length >= 2, 'and lists every finding at once');

  // Accepting the rewrites promotes the SCRUBBED text, not the original.
  const ok = promoteObservation(ctx, { observation_id: leaky.observationId, apply_rewrites: true });
  t(ok.status === 'inserted', 'with apply_rewrites it is promoted');
  t(ok.rewritten === true, 'and reported as rewritten');
  const stored = ctx.db.orgNotes.findById(ok.orgNoteId);
  t(!stored.answer.includes('ghp_'), 'the stored text has no token');
  t(!stored.answer.includes('$WORK/alpha'), 'and no local path');
  t(stored.author_handle === 'Dev Of alpha', 'the author is the git identity of this repo');
  t(stored.author_source === 'git', 'recorded as coming from git');

  // verified requires evidence: it means somebody OBSERVED this.
  const clean = saveObservation(ctx, { kind: 'gotcha', title: 'A tenrecword is fine', content: 'no secrets here' });
  let err2 = null;
  try {
    promoteObservation(ctx, { observation_id: clean.observationId, confidence: 'verified' });
  } catch (e) { err2 = e; }
  t(err2 !== null && String(err2.type) === 'INVALID_INPUT',
    'verified without evidence is refused');
  const withEv = promoteObservation(ctx, {
    observation_id: clean.observationId,
    confidence: 'verified',
    evidence: 'commit 0a90c8a',
  });
  t(withEv.confidence === 'verified', 'and accepted with it');

  // A project-scoped promotion and an org-wide one are different notes.
  const wide = promoteObservation(ctx, {
    observation_id: clean.observationId,
    scope: 'org',
    confidence: 'verified',
    evidence: 'commit 0a90c8a',
  });
  t(wide.scope === 'org' && wide.orgNoteId !== withEv.orgNoteId,
    'the same lesson at org scope is a separate note, not a duplicate');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err6" || { echo "    ✗ node block crashed"; cat "$WORK/err6" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [7] drift: has the ground moved under this lesson"
#
# Staleness with no expiry policy, no vote and no model: a note records the
# blob sha of every file it cited, and comparing those against the current ones
# answers the only question that matters about an old lesson — whether the code
# it describes is still the code.
cd "$WORK/alpha"
mkdir -p src && printf 'the original\n' > src/drifty.ts && printf 'untouched\n' > src/stable.ts
git add src/drifty.ts src/stable.ts >/dev/null 2>&1
git -c commit.gpgsign=false commit -q -m "add two files" >/dev/null 2>&1

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
import { promoteObservation, refreshDrift } from '$B/tools/orgMemory.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  startSession(ctx, { module: '_general' });
  const o = saveObservation(ctx, {
    kind: 'gotcha',
    title: 'A dunnartword depends on both files',
    content: 'it reads one and writes the other',
    files: 'src/drifty.ts,src/stable.ts,src/never-existed.ts',
  });
  const p = promoteObservation(ctx, { observation_id: o.observationId });
  const row = ctx.db.orgNotes.findById(p.orgNoteId);
  const refs = JSON.parse(row.code_refs);
  t(refs.length === 2, 'only the files git knows become code_refs');
  t(refs.every((r) => typeof r.blob_sha === 'string' && r.blob_sha.length === 40),
    'each pinned to the blob it had at promotion');
  t(!refs.some((r) => r.path.includes('never-existed')),
    'a path git never had is dropped rather than recorded as missing');

  const clean = refreshDrift(ctx);
  t(clean.drifted === 0, 'nothing has drifted yet');
  const beforeHits = ctx.db.search('dunnartword', { scope: 'org' });
  t(beforeHits[0].meta.drift.changed === 0, 'and the hit says so, as zero rather than null');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err7a" || { echo "    ✗ node block crashed"; cat "$WORK/err7a" >&2; FAILED=$((FAILED + 1)); }
read_asserts

printf 'the original, edited\n' > src/drifty.ts
git add src/drifty.ts >/dev/null 2>&1
git -c commit.gpgsign=false commit -q -m "edit one of them" >/dev/null 2>&1

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { refreshDrift } from '$B/tools/orgMemory.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
const ctx = ServerContext.initialize();
try {
  const res = refreshDrift(ctx);
  t(res.drifted === 1, 'editing one cited file makes exactly one note drift');
  const hits = ctx.db.search('dunnartword', { scope: 'org' });
  const h = hits.find((x) => String(x.title).includes('dunnartword'));
  t(h.meta.drift.changed === 1, 'the hit reports one changed file, not two');
  t(typeof h.meta.drift.checkedAt === 'string', 'and when that was checked');

  // Drifted notes are downranked, not hidden. The reader decides, with the
  // reason in front of them.
  t(h !== undefined, 'a drifted note still answers');
} finally { ctx.close(); }
console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err7b" || { echo "    ✗ node block crashed"; cat "$WORK/err7b" >&2; FAILED=$((FAILED + 1)); }
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-org-memory E2E PASSED"
