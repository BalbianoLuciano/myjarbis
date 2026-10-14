#!/bin/bash
#
# MyJarbis SessionEnd hook.
#
# Fires when the Claude Code session actually ENDS. This is deliberately
# SessionEnd and not Stop: Stop fires after every single agent turn, so
# closing a session there would end it after the first reply.
#
# It closes any session left open, writing a generated summary and resume
# point. MyJarbis sits on top of Claude Code precisely so this does not
# depend on the agent having remembered to call end_session — a session
# with no summary leaves `resume` empty and strips the ordering signal from
# every module listing, silently.
#
# Opt out with settings.session.auto_close_on_exit = false.

set -uo pipefail

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"
CLI="$INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  exit 0
fi

exec node "$CLI" hook session-end
