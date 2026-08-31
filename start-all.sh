#!/usr/bin/env bash
#
# Start every component down.sh stops, in dependency order. The counterpart to ./down.sh.
#
# Each component script stays independently usable: a gateway-only machine runs ./start-gateway.sh
# and never starts a host daemon. This exists because down.sh stops all three while start-gateway.sh
# owns only the gateway, so the daemon stayed dead until wake, peek or spawn failed much later.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

for STEP in start-federation start-gateway start-host-daemon; do
	echo "==> ./${STEP}.sh"
	if ! "./${STEP}.sh"; then
		echo "ERROR: ./${STEP}.sh failed; remaining components were not started" >&2
		exit 1
	fi
done

echo "All components started."
