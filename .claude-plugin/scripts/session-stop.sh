#!/bin/bash
#
# MyJarbis Stop hook.
#
# Fires after EVERY agent turn — not when Claude Code closes. That was
# documented wrongly here for a while, which is part of why the "remind the
# agent to close the session" approach never worked: by the time it mattered
# the reminder had already scrolled past dozens of times.
#
# The actual close now happens in the SessionEnd hook (session-end.sh). This
# one only:
#   1. Nudges the agent to write a REAL summary, since otherwise the session
#      gets closed with a generated one.
#   2. Optionally clean up module-level skill folders if
#      settings.skills.cleanup_module_skills_on_session_end is true.

set -uo pipefail

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"
CLI="$INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  exit 0
fi

exec node "$CLI" hook session-stop
