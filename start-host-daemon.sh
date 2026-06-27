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

# Read the host-daemon WS token start-gateway.sh provisioned into .env so the daemon authenticates
# to the gateway's reserved "host" slot (passed explicitly into the tmux env, since a pre-existing
# tmux server would not inherit this shell's environment).
HOST_WS_TOKEN="$(sed -n 's/^HOST_WS_TOKEN=//p' "${SCRIPT_DIR}/.env" 2>/dev/null | head -1)"

echo "Starting host daemon..."
# run-host-daemon.sh is the supervisor: it restarts the daemon with bounded backoff and drops to an
# inspectable shell after repeated fast crashes (rather than the old bare run that left an idle
# shell). HOST_WS_TOKEN is exported so the daemon inherits it; bun is on PATH via ~/.bashrc.
tmux new-session -d -s "$TMUX_SESSION" "bash -c 'cd ${SCRIPT_DIR} && source ~/.bashrc && export HOST_WS_TOKEN=${HOST_WS_TOKEN} && exec ./run-host-daemon.sh'"

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Host daemon running in background."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
else
	echo "ERROR: tmux session failed to start."
fi
