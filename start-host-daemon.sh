#!/bin/bash

set -e

# Launches the headless host daemon (src/main-host-daemon.ts) in a detached tmux session. The daemon
# owns the gateway's reserved "host" WS slot: the devcontainer catalog + on-demand wake and the
# console terminal-view host_op (peek + tmux_send). It runs no Claude session - conversational
# agents on this machine are spawned on demand through the console's host spawn-point (the daemon's
# create_session) as ordinary loose peers.

TMUX_SESSION="host-daemon"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Host daemon '${TMUX_SESSION}' already running."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
	exit 0
fi

# Daemon settings from .env, passed explicitly into the tmux env because a pre-existing tmux server
# would not inherit this shell's environment.
HOST_WS_TOKEN="$(sed -n 's/^HOST_WS_TOKEN=//p' "${SCRIPT_DIR}/.env" 2>/dev/null | head -1)"
CODEX_AGENT_ENABLED="$(sed -n 's/^CODEX_AGENT_ENABLED=//p' "${SCRIPT_DIR}/.env" 2>/dev/null | head -1)"
COPILOT_AGENT_ENABLED="$(sed -n 's/^COPILOT_AGENT_ENABLED=//p' "${SCRIPT_DIR}/.env" 2>/dev/null | head -1)"

echo "Starting host daemon..."
# run-host-daemon.sh is the supervisor: bounded-backoff restarts, then an inspectable shell after
# repeated fast crashes. bun is on PATH via ~/.bashrc.
tmux new-session -d -s "$TMUX_SESSION" "bash -c 'cd ${SCRIPT_DIR} && source ~/.bashrc && export HOST_WS_TOKEN=${HOST_WS_TOKEN} && export CODEX_AGENT_ENABLED=${CODEX_AGENT_ENABLED} && export COPILOT_AGENT_ENABLED=${COPILOT_AGENT_ENABLED} && exec ./run-host-daemon.sh'"

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Host daemon running in background."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
else
	echo "ERROR: tmux session failed to start."
fi
