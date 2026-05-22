#!/bin/bash

set -e


TMUX_SESSION="claude"
HOST_NAME="$(hostname)"

MARKETPLACE_SOURCE="atelier-nyaarium/claude-marketplace"
MARKETPLACE_KEY="atelier-nyaarium"
PLUGINS=(
	"switchboard@atelier-nyaarium"
	"nyaaskills@atelier-nyaarium"
)
SETTINGS_FILE="${HOME}/.claude/settings.json"
INSTALLED_PLUGINS_FILE="${HOME}/.claude/plugins/installed_plugins.json"


# Check if tmux session already exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Session '${TMUX_SESSION}' already running."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
	exit 0
fi


# Ensure marketplace + plugins are installed before launching claude.
marketplace_installed() {
	[ -f "$SETTINGS_FILE" ] && jq -e ".extraKnownMarketplaces[\"${MARKETPLACE_KEY}\"]" "$SETTINGS_FILE" >/dev/null 2>&1
}

plugin_installed() {
	local key="$1"
	[ -f "$INSTALLED_PLUGINS_FILE" ] && jq -e ".plugins[\"${key}\"]" "$INSTALLED_PLUGINS_FILE" >/dev/null 2>&1
}

if ! marketplace_installed; then
	echo "Adding marketplace ${MARKETPLACE_SOURCE}..."
	claude plugin marketplace add "${MARKETPLACE_SOURCE}"
fi

# jq-merge autoUpdate:true into the marketplace entry (preserves any other keys).
mkdir -p "$(dirname "$SETTINGS_FILE")"
TMP_SETTINGS="$(mktemp)"
(cat "$SETTINGS_FILE" 2>/dev/null || echo '{}') \
	| jq --arg key "$MARKETPLACE_KEY" \
		'(if . == null then {} else . end) * { extraKnownMarketplaces: { ($key): { autoUpdate: true } } }' \
	> "$TMP_SETTINGS"
mv "$TMP_SETTINGS" "$SETTINGS_FILE"

for plugin in "${PLUGINS[@]}"; do
	if ! plugin_installed "$plugin"; then
		echo "Installing plugin ${plugin}..."
		claude plugin install "$plugin"
	fi
done


echo "Starting claude on ${HOST_NAME}..."
tmux new-session -d -s "$TMUX_SESSION" "bash -c 'source ~/.bashrc; claude --name ${HOST_NAME} --model default --effort low --dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium; exec bash'"

# Wait for Claude to start, auto-accept dev channels prompt if it appears
for i in $(seq 1 10); do
	sleep 1
	SCREEN=$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)
	if echo "$SCREEN" | grep -q "Claude Code"; then
		break
	fi
	if echo "$SCREEN" | grep -q "Loading development channels"; then
		tmux send-keys -t "$TMUX_SESSION" Enter
	fi
done


if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Claude running in background."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
else
	echo "ERROR: tmux session failed to start."
fi
