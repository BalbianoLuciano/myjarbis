#!/usr/bin/env bash
#
# v0.5.1 — `myjarbis update` no longer needs Claude Code closed.
#
# What this asserts, and why each one is the assertion rather than a milder
# version of it:
#
#   · node_modules is NOT touched — by MTIME and by inode, and the order of
#     those matters. Reverting the fix proved it: `cp -r` overwrites a file IN
#     PLACE, so it keeps the inode and can produce byte-identical content —
#     and that is precisely the dangerous case, because the bytes of a mapped
#     page being rewritten under its reader is the SIGBUS. So comparing
#     content passes on the bug, comparing inodes passes on the bug, and only
#     the mtime catches it. The inode check is kept for the other shape, a
#     wholesale replacement of the directory.
#   · the live build is replaced by RENAME, with the previous one kept — so
#     there is no window in which build/ is half a build, and there is a way
#     back.
#   · a build that FAILS leaves the running build untouched. The staging
#     directory is worth nothing if a broken compile still clears the old one.
#   · the preflight tells the truth in both directions: it does NOT ask
#     someone to close Claude when the run is survivable, and it still does
#     when the dependencies changed, because that run genuinely cannot be
#     made safe — npm install has to rewrite the mapped module.
#
# The "is Claude running" check is `pgrep -x claude`, which matches the
# process NAME exactly. So the fixture gets a real process called `claude`:
# a copy of `sleep` under that name, backgrounded. Faking the check instead
# would leave the branch that actually runs on a developer's machine untested.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MJ="$REPO_ROOT/bin/myjarbis"

WORK="$(mktemp -d -t myjarbis-live-XXXXXX)"
FAKE_CLAUDE_PID=""
cleanup() {
  [ -n "$FAKE_CLAUDE_PID" ] && kill "$FAKE_CLAUDE_PID" 2>/dev/null
  cd /; rm -rf "$WORK"
}
trap cleanup EXIT
echo "→ work dir: $WORK"

export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# A fake install dir fed from this checkout, for the same reason the dry-run
# suite builds one: update writes INTO its install dir, and pointing it at the
# real one would have a test modify the developer's installation.
INSTALL="$WORK/install"
mkdir -p "$INSTALL/bin"
cp -r "$REPO_ROOT/global/." "$INSTALL/" 2>/dev/null || true
cp "$REPO_ROOT"/bin/* "$INSTALL/bin/" 2>/dev/null || true
printf '%s\n' "$REPO_ROOT" > "$INSTALL/.source"
export MYJARBIS_INSTALL_DIR="$INSTALL"

if [ ! -f "$INSTALL/mcp-server/build/index.js" ]; then
  echo "✗ build not found — run: cd $REPO_ROOT/global/mcp-server && npm run build"
  exit 1
fi
if [ ! -d "$INSTALL/mcp-server/node_modules" ]; then
  echo "✗ node_modules not found in the fixture — run npm install in the checkout"
  exit 1
fi

# The sentinel is the real native module when it exists, because that is the
# file whose replacement caused the outage. Falling back to any file under
# node_modules keeps the suite meaningful on a machine that installed
# better-sqlite3 from a prebuild with a different layout.
SENTINEL="$INSTALL/mcp-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
[ -f "$SENTINEL" ] || SENTINEL="$(find "$INSTALL/mcp-server/node_modules" -type f -name '*.json' | head -1)"
SENTINEL_INODE_BEFORE="$(stat -c '%i' "$SENTINEL")"
SENTINEL_MTIME_BEFORE="$(stat -c '%Y' "$SENTINEL")"
NM_INODE_BEFORE="$(stat -c '%i' "$INSTALL/mcp-server/node_modules")"
BUILD_INODE_BEFORE="$(stat -c '%i' "$INSTALL/mcp-server/build")"
INDEX_SUM_BEFORE="$(md5sum "$INSTALL/mcp-server/build/index.js" | cut -d' ' -f1)"

cd "$WORK"

# ── [1] a real process named `claude`, so the preflight branch runs ──
echo "→ [1] the preflight does not ask to close a session it cannot break"
mkdir -p "$WORK/fakebin"
cp "$(command -v sleep)" "$WORK/fakebin/claude"
"$WORK/fakebin/claude" 600 &
FAKE_CLAUDE_PID=$!
sleep 0.3

if pgrep -x claude >/dev/null 2>&1; then
  pass "a process named 'claude' is running, so the check is live"
else
  oops "could not fake a process named 'claude' — the rest of [1] proves nothing"
fi

OUT="$WORK/update.log"
# --no-projects keeps this to steps 2-4, which are the ones under test.
# </dev/null so a regression that reintroduces the prompt hangs nothing: with
# no terminal the script takes the non-interactive branch, and the assertion
# below is what catches the prompt coming back.
if timeout 600 "$MJ" update --no-projects --no-pull < /dev/null > "$OUT" 2>&1; then
  pass "update --no-projects exits 0 with a session open"
else
  oops "update failed (exit $?): $(tail -5 "$OUT" | tr '\n' ' ')"
fi
CLEAN="$WORK/update.clean"
sed 's/\x1b\[[0-9;]*m//g' "$OUT" > "$CLEAN"

grep -qi 'can keep running' "$CLEAN" \
  && pass "it says the running session can keep running" \
  || oops "the preflight did not say the session survives: $(grep -i claude "$CLEAN" | head -2 | tr '\n' ' ')"
grep -qi 'Update anyway?' "$CLEAN" \
  && oops "it still asked permission to break a session it cannot break" \
  || pass "and does not ask 'Update anyway?'"
grep -qi 'dependencies unchanged' "$CLEAN" \
  && pass "npm install was skipped, and said so" \
  || oops "no sign npm install was skipped"

# ── [2] the mapped module was never replaced ──
echo "→ [2] node_modules was not touched — mtime is the one that catches it"
[ "$(stat -c '%i' "$SENTINEL")" = "$SENTINEL_INODE_BEFORE" ] \
  && pass "the native module is the SAME inode ($SENTINEL_INODE_BEFORE)" \
  || oops "the native module was replaced: inode $SENTINEL_INODE_BEFORE -> $(stat -c '%i' "$SENTINEL")"
[ "$(stat -c '%Y' "$SENTINEL")" = "$SENTINEL_MTIME_BEFORE" ] \
  && pass "and was not rewritten in place (mtime unchanged)" \
  || oops "the native module's mtime moved — it was written in place"
[ "$(stat -c '%i' "$INSTALL/mcp-server/node_modules")" = "$NM_INODE_BEFORE" ] \
  && pass "node_modules/ itself is the same directory" \
  || oops "node_modules/ was replaced wholesale"

# ── [3] the build was replaced, by rename, with a way back ──
echo "→ [3] the build landed by rename"
[ "$(stat -c '%i' "$INSTALL/mcp-server/build")" != "$BUILD_INODE_BEFORE" ] \
  && pass "build/ is a NEW directory, so it arrived by rename" \
  || oops "build/ is the same inode — it was written in place, not swapped"
[ -d "$INSTALL/mcp-server/build.prev" ] \
  && pass "the previous build is kept as build.prev" \
  || oops "no build.prev — there is no rollback"
[ ! -d "$INSTALL/mcp-server/build.next" ] \
  && pass "no build.next left behind" \
  || oops "the staging directory was not cleaned up"
[ -f "$INSTALL/mcp-server/build/index.js" ] \
  && pass "and the new build has an index.js" \
  || oops "the swapped-in build has no index.js"
[ "$(md5sum "$INSTALL/mcp-server/build.prev/index.js" | cut -d' ' -f1)" = "$INDEX_SUM_BEFORE" ] \
  && pass "build.prev holds exactly what was running before" \
  || oops "build.prev is not the build that was there"

# ── [4] a failed build must not take the live one with it ──
echo "→ [4] a build that fails leaves the running build untouched"
BAD_SOURCE="$WORK/badsource"
mkdir -p "$BAD_SOURCE"
cp -r "$REPO_ROOT/global" "$BAD_SOURCE/" 2>/dev/null || true
cp -r "$REPO_ROOT/bin" "$BAD_SOURCE/" 2>/dev/null || true
cp "$REPO_ROOT/install.sh" "$BAD_SOURCE/" 2>/dev/null || true
printf 'this is not typescript at all(((\n' > "$BAD_SOURCE/global/mcp-server/src/zz-broken.ts"

LIVE_SUM_BEFORE="$(md5sum "$INSTALL/mcp-server/build/index.js" | cut -d' ' -f1)"
LIVE_INODE_BEFORE="$(stat -c '%i' "$INSTALL/mcp-server/build")"
# A fingerprint of every file's mtime, not just index.js. The first version of
# this section passed with the fix REVERTED, which is the one outcome that
# makes a test worthless: tsc emits output for the files it can compile even
# when the build fails overall, and index.js came out byte-identical because
# index.ts had not changed. Mtimes across the whole tree are what notice that
# a failed build wrote anything at all.
build_fingerprint() { find "$1" -type f -printf '%T@ %s %p\n' 2>/dev/null | sort | md5sum | cut -d' ' -f1; }
LIVE_FP_BEFORE="$(build_fingerprint "$INSTALL/mcp-server/build")"

BAD_OUT="$WORK/bad.log"
if timeout 600 "$MJ" update --no-projects --no-pull --from="$BAD_SOURCE" < /dev/null > "$BAD_OUT" 2>&1; then
  oops "update exited 0 on a source that cannot compile"
else
  pass "update fails on a source that cannot compile"
fi
sed -i 's/\x1b\[[0-9;]*m//g' "$BAD_OUT"
grep -qi 'left untouched' "$BAD_OUT" \
  && pass "and says the live build was left untouched" \
  || oops "the failure does not say what happened to the live build"
[ "$(md5sum "$INSTALL/mcp-server/build/index.js" | cut -d' ' -f1)" = "$LIVE_SUM_BEFORE" ] \
  && pass "the live index.js is byte-identical to before the failed run" \
  || oops "a failed build changed the live index.js"
[ "$(build_fingerprint "$INSTALL/mcp-server/build")" = "$LIVE_FP_BEFORE" ] \
  && pass "and NOT ONE file under build/ was written (mtime fingerprint)" \
  || oops "a failed build wrote into the live build directory"
[ "$(stat -c '%i' "$INSTALL/mcp-server/build")" = "$LIVE_INODE_BEFORE" ] \
  && pass "and the same inode, so nothing was swapped" \
  || oops "build/ was swapped despite the build failing"
[ ! -d "$INSTALL/mcp-server/build.next" ] \
  && pass "the failed staging directory was removed" \
  || oops "build.next survived a failed build"

# Point the install back at the good checkout before [5].
printf '%s\n' "$REPO_ROOT" > "$INSTALL/.source"

# ── [5] the warning still fires on the run that genuinely breaks a session ──
echo "→ [5] it DOES warn when the dependencies changed"
# A dependency the installed copy does not have. The comparison is on the
# `dependencies` block, so this is the real trigger, not a simulated one.
node -e "
  const fs = require('fs'), p = '$BAD_SOURCE/global/mcp-server/package.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.dependencies = Object.assign({}, j.dependencies, { 'left-pad': '^1.3.0' });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
rm -f "$BAD_SOURCE/global/mcp-server/src/zz-broken.ts"

DRY2="$WORK/dry2.log"
timeout 600 "$MJ" update --dry-run --no-pull --from="$BAD_SOURCE" < /dev/null > "$DRY2" 2>&1
sed -i 's/\x1b\[[0-9;]*m//g' "$DRY2"
grep -qi 'cannot survive' "$DRY2" \
  && pass "the dry run warns that this run kills a running session" \
  || oops "no warning on a run whose dependencies changed"
grep -qi 'dependencies changed' "$DRY2" \
  && pass "and names the dependency change as the reason" \
  || oops "the warning does not say why"
# The same fixture must NOT claim the session survives — the two messages are
# mutually exclusive, and a reporter that prints both is worse than one that
# prints neither.
grep -qi 'survives this run' "$DRY2" \
  && oops "it says both that the session survives and that it cannot" \
  || pass "and does not also claim the session survives"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "PASS  v051-update-live-session"
  exit 0
fi
echo "FAIL  v051-update-live-session ($FAILED assertion(s))" >&2
exit 1
