#!/bin/bash

# Supervisor for the host daemon: run it, and on exit restart with exponential backoff. The daemon
# keeps itself alive on a stray rejection (its unhandledRejection guard) and only exits on an
# uncaughtException, so an exit means "restart from a clean process". A daemon that exits fast and
# repeatedly is hard-down (a deterministic startup crash), not transient: after a few rapid failures
# stop and drop to an interactive shell so the tmux session stays inspectable instead of hot-looping
# forever. A healthy run (>= HEALTHY_SECS uptime) resets the backoff. HOST_WS_TOKEN is inherited
# from the environment start-host-daemon.sh exports before launching this; bun is resolved below
# rather than inherited, for the reason given there.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# bun is resolved HERE, never trusted from the login shell.
#
# start-host-daemon.sh used to `source ~/.bashrc` and rely on that for PATH, which is a convention and
# not a guarantee: the stock Debian/Ubuntu .bashrc returns early for a NON-interactive shell, and
# bun's own installer appends its PATH export to the END of that file - below the guard. Observed on
# a WSL machine whose .bashrc had the guard at line 35, ~/.local/bin exported above it and bun below:
# `claude` resolved non-interactively and `bun` did not. The daemon fast-failed five times, stayed
# down as designed, and nobody read the pane for 13 hours, while its gateway stayed up and REGISTERED.
# That is the failure mode with no immediate symptom, so the launcher must not depend on a login
# file's shape.
resolve_bun() {
	command -v bun 2>/dev/null && return 0
	for candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun"; do
		if [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

# Not the retry loop: five identical "command not found" failures teach nothing and bury the cause.
# An absent runtime is hard-down on the first try, so say which places were searched and hold the
# session open for inspection, the same way MAX_FAST_FAILS does.
if ! BUN="$(resolve_bun)"; then
	echo "[host-daemon] bun not found. Searched: PATH, \$BUN_INSTALL/bin, ~/.bun/bin."
	echo "[host-daemon] Install bun (https://bun.sh) or export BUN_INSTALL, then: ./start-host-daemon.sh"
	exec bash
fi
echo "[host-daemon] bun: $BUN"

HEALTHY_SECS=10
MAX_FAST_FAILS=5
delay=2
fails=0

while true; do
	start=$SECONDS
	"$BUN" run src/main-host-daemon.ts
	ran=$((SECONDS - start))

	if [ "$ran" -ge "$HEALTHY_SECS" ]; then
		delay=2
		fails=0
	else
		fails=$((fails + 1))
	fi

	if [ "$fails" -ge "$MAX_FAST_FAILS" ]; then
		echo "[host-daemon] exited fast ${fails}x (< ${HEALTHY_SECS}s each); staying down for inspection."
		echo "[host-daemon] fix the cause, then re-run: bun run src/main-host-daemon.ts"
		exec bash
	fi

	echo "[host-daemon] exited after ${ran}s; restarting in ${delay}s (fast-fail ${fails}/${MAX_FAST_FAILS})."
	sleep "$delay"
	delay=$((delay * 2))
	[ "$delay" -gt 60 ] && delay=60
done
