#!/usr/bin/env bash
#
# Thin launcher for the admin Domain setup. All logic lives in scripts/setup.ts (run with bun);
# this stays a .sh entry point for muscle memory and docs. No args opens the setup menu; see that
# file for the other flags: --qr, --verify, --help.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

. scripts/resolve-bun.sh
if ! BUN="$(resolve_bun)"; then
	echo "bun not found. Searched: $BUN_SEARCHED." >&2
	echo "Install bun (https://bun.sh) or export BUN_INSTALL, then: ./setup.sh" >&2
	exit 1
fi
exec "$BUN" run scripts/setup.ts "$@"
