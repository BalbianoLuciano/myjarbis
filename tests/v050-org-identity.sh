#!/bin/bash
#
# E2E test: the developer identity behind a write.
#
# Nothing in MyJarbis recorded an author before this, and the one
# attribution-shaped column that existed is the reason to be careful:
# `project_state.updated_by` is a free-text tool argument, and the live brain
# holds three different conventions in three rows — `session-484-cli`,
# `s485-close-21oct`, `session-adhoc`. A field anybody fills with anything is
# not an identity, so this one is a fixed ladder and the source travels with
# the handle.
#
# What this pins:
#
#   · git user.name is used when there is no override
#   · `myjarbis config dev` beats git, because someone who set it meant it
#   · an email is kept from git even when only a handle was given
#   · with neither, the handle is a fallback AND says so
#   · setting the handle MERGES into settings.json instead of replacing it,
#     which is where the project's language and search defaults live
#   · an unparseable settings.json is refused, not overwritten
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/org/identity.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-identity-XXXXXX)"
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

# Two projects: one with a git identity, one with none. HOME is pinned to an
# empty fake home, so there is no global git config to leak in — which is the
# whole reason the "no identity at all" case is testable here.
mkdir -p "$WORK/withgit" && cd "$WORK/withgit" && git init -q .
git config user.name 'Ana Tester'
git config user.email 'ana@example.com'
"$MJ" init --yes --skip-memory >/dev/null 2>&1

mkdir -p "$WORK/nogit" && cd "$WORK/nogit" && git init -q .
"$MJ" init --yes --skip-memory >/dev/null 2>&1

echo "→ [1] the resolution ladder"
node --input-type=module -e "
import { resolveIdentity, setIdentity, identityWarning } from '$B/org/identity.js';
import * as fs from 'fs';
import * as path from 'path';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

// 1. git, with no override
let id = resolveIdentity('$WORK/withgit');
t(id.source === 'git' && id.handle === 'Ana Tester', 'git user.name is the handle when nothing overrides it');
t(id.email === 'ana@example.com', 'and git user.email comes with it');

// 2. the override wins
setIdentity('$WORK/withgit', 'ana');
id = resolveIdentity('$WORK/withgit');
t(id.source === 'config' && id.handle === 'ana', 'an explicit handle beats git');
t(id.email === 'ana@example.com', 'and keeps the git email, which was never in question');

// 3. an explicit email too
setIdentity('$WORK/withgit', 'ana', 'ana@acme.test');
id = resolveIdentity('$WORK/withgit');
t(id.email === 'ana@acme.test', 'an explicit email overrides the git one');

// 4. the merge. This file also holds language and search defaults; a feature
//    that rewrites it wholesale takes somebody else's configuration with it.
const sp = path.join('$WORK/withgit', '.myjarbis', 'config', 'settings.json');
const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
t(settings.dev && settings.dev.handle === 'ana', 'the handle is persisted under dev');
t(typeof settings.language === 'string', 'and language survived the write');
t(settings.search_default_scope === 'module', 'and so did search_default_scope');

// 5. nothing configured anywhere
id = resolveIdentity('$WORK/nogit');
t(id.source === 'fallback', 'with no git identity and no override the source is fallback');
t(id.handle.includes('@'), 'and the handle is user@host');
t(identityWarning(id) !== null, 'a fallback identity produces a warning');
t(identityWarning({ handle: 'ana', email: null, source: 'config' }) === null,
  'a configured one produces none');

// 6. an empty handle is refused rather than stored
let threw = null;
try { setIdentity('$WORK/nogit', '   '); } catch (e) { threw = e; }
t(threw !== null, 'an empty handle is refused');

// 7. a settings.json nobody can parse is refused, not overwritten
const bad = path.join('$WORK/nogit', '.myjarbis', 'config', 'settings.json');
fs.writeFileSync(bad, '{ \"language\": \"es\", ', 'utf-8');
threw = null;
try { setIdentity('$WORK/nogit', 'bob'); } catch (e) { threw = e; }
t(threw !== null, 'writing into an unparseable settings.json is refused');
t(fs.readFileSync(bad, 'utf-8').includes('language'),
  'and the broken file is left exactly as it was, not replaced');
// Reading, by contrast, degrades to no override rather than failing: a stray
// comma must not block a promotion for a reason nobody can connect to it.
t(resolveIdentity('$WORK/nogit').source === 'fallback',
  'but READING an unparseable file falls through instead of throwing');

console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err1" || { echo "    ✗ node block crashed"; cat "$WORK/err1" >&2; FAILED=$((FAILED + 1)); }
read_asserts

echo "→ [2] the CLI surface"
cd "$WORK/withgit"
DEVJSON="$("$MJ" config dev --json 2>/dev/null)"
if echo "$DEVJSON" | grep -q '"handle": *"ana"'; then
  pass "myjarbis config dev --json reports the resolved handle"
else
  oops "myjarbis config dev --json did not report the handle (got: $DEVJSON)"
fi
if echo "$DEVJSON" | grep -q '"source": *"config"'; then
  pass "and the source it came from"
else
  oops "config dev --json did not report the source"
fi

"$MJ" config dev carlos >/dev/null 2>&1
if "$MJ" config dev --json 2>/dev/null | grep -q '"handle": *"carlos"'; then
  pass "myjarbis config dev <handle> writes it"
else
  oops "myjarbis config dev <handle> did not persist"
fi

# `config list` is where someone looks before promoting, so the identity has
# to be visible there and not only under its own subcommand.
if "$MJ" config list --json 2>/dev/null | grep -q '"handle": *"carlos"'; then
  pass "and config list shows it too"
else
  oops "config list does not report the dev identity"
fi

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-org-identity E2E PASSED"
