#!/bin/bash
#
# Dogfood script: bring up MyJarbis on an existing project.
#
# Idempotent — re-running yields all-unchanged for content that hasn't moved,
# so it is safe to re-run after pulling new docs.
#
# Inputs:
#   $1                     Path to the target project checkout (required).
#   $MYJARBIS_DOCS_DIR     Directory holding the project's markdown docs,
#                          relative to the project root. Default: "docs".
#   $MYJARBIS_MODULES      Space-separated module names to create.
#                          Default: "backend frontend".
#   $MYJARBIS_INSTALL_DIR  Override the MyJarbis install location
#                          (defaults to $HOME/.myjarbis-global).
#
# What it does:
#   1. `myjarbis init` in the target repo (memory.db + baseline skills).
#   2. Creates the requested modules.
#   3. Imports every *.md under $MYJARBIS_DOCS_DIR into project_context,
#      guessing `kind` from the filename and falling back to 'other'.
#   4. Prints stats.
#
# It deliberately knows nothing about any particular project: file names,
# module names and doc layout all come from the arguments. Anything specific
# to how an organization works belongs in an org pack, not in this repo.

set -euo pipefail

PROJECT_DIR="${1:-}"
if [ -z "$PROJECT_DIR" ]; then
  echo "Usage: scripts/dogfood.sh <path-to-project>" >&2
  echo >&2
  echo "  MYJARBIS_DOCS_DIR  docs dir inside the project (default: docs)" >&2
  echo "  MYJARBIS_MODULES   modules to create (default: \"backend frontend\")" >&2
  exit 1
fi
if [ ! -d "$PROJECT_DIR" ]; then
  echo "✗ project not found at $PROJECT_DIR" >&2
  exit 1
fi

DOCS_DIR="${MYJARBIS_DOCS_DIR:-docs}"
MODULES="${MYJARBIS_MODULES:-backend frontend}"

MJ="$(command -v myjarbis || true)"
if [ -z "$MJ" ]; then
  # Fall back to the repo binary when myjarbis isn't on PATH.
  HERE="$(cd "$(dirname "$0")/.." && pwd)"
  MJ="$HERE/bin/myjarbis"
  export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HERE/global}"
fi

cd "$PROJECT_DIR"

echo "→ [1/4] init"
"$MJ" init --yes >/dev/null
echo "  ✓ memory.db + baseline skills"

echo "→ [2/4] modules"
for m in $MODULES; do
  "$MJ" module add "$m" --description="$m vertical" >/dev/null 2>&1 || true
done
echo "  ✓ modules: $MODULES"

echo "→ [3/4] project docs from $DOCS_DIR/"
# Map a filename to a context kind. Unknown names land in 'other' rather than
# inventing a label: free-form kinds are exactly what the taxonomy exists to
# stop (see `myjarbis kinds`).
guess_kind() {
  local base
  base="$(basename "$1" .md | tr '[:upper:]' '[:lower:]')"
  case "$base" in
    workflow|process)              echo workflow ;;
    tracking|tracker|issues)       echo tracker_rules ;;
    plan|roadmap)                  echo plan ;;
    errors|error_log|troubleshoot*) echo error_log ;;
    architecture|conventions)      echo convention ;;
    *spec*|*functional*)           echo functional_spec ;;
    *design*|*ui*|*ux*)            echo design_guideline ;;
    *)                             echo other ;;
  esac
}

imported=0
if [ -d "$DOCS_DIR" ]; then
  while IFS= read -r doc; do
    kind="$(guess_kind "$doc")"
    "$MJ" import "$doc" --target=project --kind="$kind" >/dev/null
    echo "    ✓ $doc → project ($kind)"
    imported=$((imported + 1))
  done < <(find "$DOCS_DIR" -maxdepth 2 -name '*.md' | sort)
else
  echo "    (no $DOCS_DIR/ directory — skipping imports)"
fi
echo "  ✓ $imported document(s) imported"

echo "→ [4/4] stats"
"$MJ" stats | head -50

echo
echo "✓ dogfood complete. Open Claude in $PROJECT_DIR and run /jarbis."
