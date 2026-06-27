#!/bin/bash

# Supervisor for the host daemon: run it, and on exit restart with exponential backoff. The daemon
# keeps itself alive on a stray rejection (its unhandledRejection guard) and only exits on an
# uncaughtException, so an exit means "restart from a clean process". A daemon that exits fast and
# repeatedly is hard-down (a deterministic startup crash), not transient: after a few rapid failures
# stop and drop to an interactive shell so the tmux session stays inspectable instead of hot-looping
# forever. A healthy run (>= HEALTHY_SECS uptime) resets the backoff. HOST_WS_TOKEN is inherited
# from the environment start-host-daemon.sh exports before launching this.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

HEALTHY_SECS=10
MAX_FAST_FAILS=5
delay=2
fails=0

while true; do
	start=$SECONDS
	bun run src/main-host-daemon.ts
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
