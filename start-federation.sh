#!/usr/bin/env bash
#
# Start the federation Router without touching the gateway. Thin launcher for
# scripts/start-federation.ts, which owns every .env key the Router reads.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

. scripts/resolve-bun.sh
if ! BUN="$(resolve_bun)"; then
	echo "bun not found. Searched: $BUN_SEARCHED." >&2
	echo "Install bun (https://bun.sh) or export BUN_INSTALL, then: ./start-federation.sh" >&2
	exit 1
fi
exec "$BUN" run scripts/start-federation.ts "$@"
