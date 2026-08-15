#!/usr/bin/env bash

pushd "$(dirname "$0")" > /dev/null || exit 1

# Stop all components.

TMUX_SESSION="host-daemon"

# Kill the host daemon tmux session
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Killing tmux session '${TMUX_SESSION}'..."
	tmux kill-session -t "$TMUX_SESSION"
else
	echo "No tmux session '${TMUX_SESSION}' running."
fi

# Take down the gateway container
echo "Taking down gateway..."
docker compose down --remove-orphans 2>/dev/null || true

echo "Taking down federation Router..."
docker compose -f docker-compose.federation.yml -p switchboard-federation down --remove-orphans 2>/dev/null || true

# Remove the switchboard network (may fail if devcontainers are still attached)
for NETWORK_NAME in switchboard switchboard-federation; do
	if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
		echo "Removing '${NETWORK_NAME}' network..."
		if ! docker network rm "$NETWORK_NAME" >/dev/null 2>&1; then
			echo "WARNING: could not remove '${NETWORK_NAME}' network (containers still attached?)."
		fi
	fi
done

echo "Done."
popd > /dev/null
