#!/bin/bash
#
# E2E test: init registers itself in ~/.claude.json without unregistering
# anyone else.
#
#   1. `myjarbis` is ADDED to the project's mcpServers. The step used to
#      assign the whole object, which silently unregistered every other MCP
#      server the project had — found on a real machine where it would have
#      dropped a tracker server and a project's own server
#   2. the file is backed up first, and the rest of it is left as it was
#   3. a ~/.claude.json that does not parse is left byte for byte untouched,
#      and init still finishes
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/cli.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-mcp-merge-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Hermetic HOME: this suite is about what init writes into $HOME, so the real
# one must never be in reach.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/home"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"
export MYJARBIS_LANGUAGE=EN MYJARBIS_PERSONA=1

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Through a file, not a pipe: a `| while read` loop runs in a subshell and
# every FAILED increment inside it would be lost.
ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}

mkdir -p "$WORK/tracked" && git -C "$WORK/tracked" init -q .
# -P: init keys the entry by the resolved cwd, and on macOS the temp dir sits
# behind a symlink (/var → /private/var).
TRACKED="$(cd "$WORK/tracked" && pwd -P)"
cat > "$HOME/.claude.json" <<EOF
{
  "numStartups": 42,
  "projects": {
    "$TRACKED": {
      "allowedTools": ["Bash(git status)"],
      "mcpServers": {
        "youtrack": { "type": "stdio", "command": "youtrack-mcp", "args": [] }
      }
    },
    "/somewhere/else": {
      "mcpServers": { "dmeter": { "type": "stdio", "command": "dmeter", "args": [] } }
    }
  }
}
EOF

echo "→ [1] init adds myjarbis next to the servers already registered"
(cd "$TRACKED" && "$MJ" init --yes --skip-memory </dev/null >/dev/null 2>&1)

node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.env.HOME + '/.claude.json', 'utf8'));
const p = d.projects['$TRACKED'] || {};
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(p.mcpServers && p.mcpServers.youtrack, 'the project keeps its youtrack server');
t(p.mcpServers && p.mcpServers.myjarbis, 'myjarbis is registered next to it');
t(JSON.stringify(p.allowedTools) === '[\"Bash(git status)\"]', 'the rest of the project entry is untouched');
t(d.projects['/somewhere/else'].mcpServers.dmeter, 'another project keeps its server');
t(d.numStartups === 42, 'top-level keys survive');
console.log(out.join('\n'));
" > "$ASSERTS"
read_asserts

echo "→ [2] the file was backed up before being rewritten"
BACKUPS=$( (ls "$HOME"/.claude.json.bak-* 2>/dev/null || true) | wc -l | tr -d ' ')
if [ "$BACKUPS" -eq 1 ] && grep -q youtrack "$(ls "$HOME"/.claude.json.bak-* | head -1)"; then
  pass "one backup, holding the original"
else
  oops "expected one backup of the original, found $BACKUPS"
fi

echo "→ [3] a ~/.claude.json that does not parse is left alone"
printf '{ "projects": { broken' > "$HOME/.claude.json"
BEFORE="$(shasum "$HOME/.claude.json")"
mkdir -p "$WORK/broken" && git -C "$WORK/broken" init -q .
if (cd "$WORK/broken" && "$MJ" init --yes --skip-memory </dev/null >/dev/null 2>&1); then
  pass "init still finishes"
else
  oops "init failed outright on an unparseable ~/.claude.json"
fi
[ "$(shasum "$HOME/.claude.json")" = "$BEFORE" ] \
  && pass "the file is byte for byte what it was" \
  || oops "the unparseable file was rewritten"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
