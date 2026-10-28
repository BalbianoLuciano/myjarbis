#!/bin/bash
#
# E2E test: `myjarbis start <name>` resolves by name on the bash that
# actually runs it.
#
#   1. an exact name resolves to its project
#   2. a substring resolves case-insensitively
#   3. a substring matching several projects is refused as ambiguous
#   4. a name matching nothing is refused by name
#   5. a name typed at the picker resolves the same way as the argument
#   6. no script the user's shell runs uses bash 4-only syntax
#
# resolve_token lowercased with ${x,,}, which is bash 4. The #!/bin/bash
# the script runs under is still 3.2 on macOS, where it is "bad
# substitution": every pick by name failed there while picks by number
# worked. [1-5] run the script through its own shebang, so on macOS they
# exercise 3.2; [6] guards every platform, including a Linux CI whose bash
# would never have shown the failure.
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
START="$REPO_ROOT/bin/myjarbis-start"

WORK="$(mktemp -d -t myjarbis-start-name-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
# start reads the registry from the install dir; a throwaway one keeps the
# developer's real projects out of the list.
export MYJARBIS_INSTALL_DIR="$WORK/install"; mkdir -p "$MYJARBIS_INSTALL_DIR"
# --print resolves the spawn strategy too; outside tmux and WSL it is
# "here", which prints a single cd line.
unset TMUX WSL_DISTRO_NAME

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

mkdir -p "$WORK/p/gridwright" "$WORK/p/GridBench" "$WORK/p/pet-bus"
cat > "$MYJARBIS_INSTALL_DIR/projects-registry.json" <<EOF
{
  "projects": {
    "gridwright": { "name": "gridwright", "path": "$WORK/p/gridwright", "framework": "generic" },
    "GridBench":  { "name": "GridBench",  "path": "$WORK/p/GridBench",  "framework": "generic" },
    "pet-bus":    { "name": "pet-bus",    "path": "$WORK/p/pet-bus",    "framework": "react" }
  }
}
EOF

# Runs start, never failing the suite itself; the status lands in $STATUS.
run_start() {
  set +e
  OUT="$("$START" "$@" --print </dev/null 2>&1)"
  STATUS=$?
  set -e
}

echo "→ [1] an exact name"
run_start pet-bus
if [ "$STATUS" -eq 0 ] && grep -q "$WORK/p/pet-bus" <<<"$OUT"; then
  pass "pet-bus resolves to its path"
else
  oops "pet-bus did not resolve (exit $STATUS): $(grep -m1 -i 'substitution\|fail' <<<"$OUT" || true)"
fi

echo "→ [2] a substring, in another case"
run_start PET
[ "$STATUS" -eq 0 ] && grep -q "$WORK/p/pet-bus" <<<"$OUT" \
  && pass "PET resolves to pet-bus" \
  || oops "PET did not resolve case-insensitively (exit $STATUS)"

echo "→ [3] a substring that matches several"
run_start grid
[ "$STATUS" -ne 0 ] && grep -q "AMBIGUOUS" <<<"$OUT" && grep -q "GridBench" <<<"$OUT" \
  && pass "grid is refused as ambiguous, naming both" \
  || oops "grid was not reported as ambiguous (exit $STATUS)"

echo "→ [4] a name that matches nothing"
run_start nope
[ "$STATUS" -ne 0 ] && grep -q "no project matches 'nope'" <<<"$OUT" \
  && pass "nope is refused by name" \
  || oops "nope was not refused by name (exit $STATUS)"

echo "→ [5] a name typed at the picker"
set +e
OUT="$(echo "wright" | "$START" --print 2>&1)"
STATUS=$?
set -e
[ "$STATUS" -eq 0 ] && grep -q "cd $WORK/p/gridwright" <<<"$OUT" \
  && pass "wright, typed at the picker, resolves to gridwright" \
  || oops "the picker did not resolve a typed name (exit $STATUS)"

echo "→ [6] no bash 4-only syntax in the scripts the user's shell runs"
# ${x,,} ${x^^} ${x,} ${x^}, mapfile/readarray, associative arrays, namerefs.
# Comment lines are skipped: explaining why the syntax is avoided is fine.
HITS="$(grep -nE '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?(,,?|\^\^?)\}|\bmapfile\b|\breadarray\b|declare -[aA]*A|local -[A-Za-z]*[An]' \
  "$REPO_ROOT"/bin/* "$REPO_ROOT/install.sh" \
  "$REPO_ROOT"/global/templates/.claude-plugin/scripts/*.sh 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
if [ -z "$HITS" ]; then
  pass "none found"
else
  oops "bash 4-only syntax, which fails under macOS /bin/bash 3.2:"
  echo "$HITS" | sed 's/^/        /' >&2
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
