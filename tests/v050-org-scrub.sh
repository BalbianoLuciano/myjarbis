#!/bin/bash
#
# E2E test: the deterministic gate between a personal note and a repository
# other people clone.
#
# A personal observation is written for one reader on one machine, so it says
# /home/<someone>/dev/<client>/src/x.ts and it names the client. An org note is
# committed. Promotion is the only moment that change of audience happens, so
# it is the only moment the check can be made.
#
# The project-name rule has real history: commit d342442 scrubbed three client
# names out of this repository's tracked files and deliberately left them in
# the commit messages, because rewriting history was out of scope. The history
# was rewritten anyway two releases later, partly for that.
#
# What this pins:
#
#   · a credential, a local path, an internal host and a private IP are found
#   · a REAL project name from the registry is found, and the rewrite keeps a
#     usable sentence ("the 18-module project") rather than just anonymising
#   · a project whose name is an ordinary English word is NOT matched, because
#     a gate that fires on every sentence is a gate people route around
#   · the longest path wins: the project path is rewritten before the home
#     directory, so nothing is left anonymous-about-the-dev and still naming
#     the client
#   · a clean note produces zero findings and comes back byte-identical
#   · the reported line numbers are the ones in what the user wrote
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"

if [ ! -f "$B/org/scrub.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-scrub-XXXXXX)"
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

echo "→ [1] every rule, on one note"
node --input-type=module -e "
import { scrubOrgNote, renderScrubFindings } from '$B/org/scrub.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

const ctx = {
  homeDir: '/home/dev',
  projectPath: '/home/dev/work/portal-ui',
  selfProjectName: 'portal-ui',
  otherProjects: [
    { name: 'northwind-crm', modules: 18 },
    { name: 'acme', modules: 3 },
    { name: 'api', modules: 7 },        // ordinary word: must NOT match
    { name: 'zed', modules: 2 },        // too short: must NOT match
    { name: 'legacy-thing', modules: 0 }, // no modules: generic replacement
  ],
};

const draft = {
  question: 'why does the suite fail on portal-ui',
  answer: 'line one has ghp_abcdefghijklmnopqrstuvwxyz0123\nline two reads /home/dev/work/portal-ui/src/x.ts\nline three posts to jenkins.corp at 10.0.3.14',
  caveats: 'northwind-crm only. The api project is fine, zed is fine, acme is not, legacy-thing untested.',
  evidence: 'commit 0a90c8a',
};

const r = scrubOrgNote(draft, ctx);
const has = (rule, excerpt) => r.findings.some((f) => f.rule === rule && f.excerpt === excerpt);
// Returns a stand-in rather than undefined when nothing matched. A missing
// finding has to fail the assertion that NAMES it, not crash the block and
// report 'node block crashed' — the suite is also the diagnosis.
const find = (rule, excerpt) =>
  r.findings.find((f) => f.rule === rule && f.excerpt === excerpt) ??
  { rule, excerpt, line: -1, rewrite: '(no such finding)' };

t(has('secret', 'ghp_abcdefghijklmnopqrstuvwxyz0123'), 'a GitHub token is found');
t(has('home_path', '/home/dev/work/portal-ui'), 'the project path is found');
t(has('internal_host', 'jenkins.corp'), 'an internal hostname is found');
t(has('internal_host', '10.0.3.14'), 'a private IP is found');
t(has('project_name', 'northwind-crm'), 'a real project name is found');
t(has('project_name', 'portal-ui'), 'and so is the name of the project being promoted from');

t(!r.findings.some((f) => f.excerpt === 'api'), 'a project called \"api\" is NOT matched');
t(!r.findings.some((f) => f.excerpt === 'zed'), 'a three-letter project name is NOT matched');

t(find('project_name', 'northwind-crm').rewrite === 'the 18-module project',
  'the rewrite keeps a sentence somebody can reason about');
t(find('project_name', 'legacy-thing').rewrite === '<another project>',
  'a project with no modules falls back to a generic placeholder');
t(find('secret', 'ghp_abcdefghijklmnopqrstuvwxyz0123').rewrite.startsWith('<redacted:'),
  'a credential is redacted, not described');

// Line numbers must be the ones in what the user wrote.
t(find('secret', 'ghp_abcdefghijklmnopqrstuvwxyz0123').line === 1, 'the token is reported on line 1');
t(find('home_path', '/home/dev/work/portal-ui').line === 2, 'the path on line 2');
t(find('internal_host', 'jenkins.corp').line === 3, 'the host on line 3');

// The ordering that matters: longest path first.
t(r.rewritten.answer.includes('<repo>/src/x.ts'),
  'the project path becomes <repo>/src/x.ts, not <home>/work/portal-ui/src/x.ts');
t(!/\/home\/dev/.test(r.rewritten.answer), 'no home directory survives the rewrite');
t(!/portal-ui/.test(JSON.stringify(r.rewritten)), 'and no occurrence of the project name survives');
t(!/ghp_/.test(r.rewritten.answer), 'nor the token');
t(r.rewritten.caveats.includes('The api project is fine'),
  'while the ordinary-word project name is left alone in the text');
t(r.rewritten.caveats.includes('zed is fine'), 'and so is the too-short one');

t(renderScrubFindings(r.findings).includes('→'),
  'the findings render with the proposed rewrite beside each one');
t(renderScrubFindings([]) === '', 'and render to nothing when there is nothing to say');

console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err1" || { echo "    ✗ node block crashed"; cat "$WORK/err1" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [2] a clean note is left exactly as it is"
node --input-type=module -e "
import { scrubOrgNote } from '$B/org/scrub.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

const ctx = {
  homeDir: '/home/dev',
  projectPath: '/home/dev/work/portal-ui',
  selfProjectName: 'portal-ui',
  otherProjects: [{ name: 'northwind-crm', modules: 18 }],
};
const draft = {
  question: 'why does an UPDATE corrupt a contentless FTS5 index',
  answer: 'The _au trigger issues a delete op for a row the index does not hold, which returns SQLITE_CORRUPT_VTAB.',
  working_example: \"INSERT INTO t_fts(t_fts) VALUES('rebuild') before the backfill\",
  caveats: 'Only with content= tables. A normal FTS5 table is unaffected.',
  evidence: 'db/schema.ts',
};
const r = scrubOrgNote(draft, ctx);
t(r.findings.length === 0, 'a clean note produces zero findings');
for (const k of Object.keys(draft))
  t(r.rewritten[k] === draft[k], 'field ' + k + ' came back byte-identical');

// The gate is idempotent: scrubbing an already-scrubbed note finds nothing
// new, which is what lets 'apply the rewrites and promote' be one step.
const dirty = { answer: 'at /home/dev/work/portal-ui/a.ts on northwind-crm' };
const once = scrubOrgNote(dirty, ctx);
const twice = scrubOrgNote(once.rewritten, ctx);
t(once.findings.length > 0, 'a dirty note has findings on the first pass');
t(twice.findings.length === 0, 'and none on a second pass over the rewrite');
t(twice.rewritten.answer === once.rewritten.answer, 'which leaves the text alone');

console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err2" || { echo "    ✗ node block crashed"; cat "$WORK/err2" >&2; FAILED=$((FAILED + 1)); }
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-org-scrub E2E PASSED"
