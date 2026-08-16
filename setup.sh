#!/usr/bin/env bash
#
# Thin launcher for the admin Domain setup. All logic lives in scripts/setup.ts (run with bun);
# this stays a .sh entry point for muscle memory and docs. No args opens the setup menu; see that
# file for the other flags: --qr, --verify, --help.

set -uo pipefail
cd "$(dirname "$0")" || exit 1
exec bun run scripts/setup.ts "$@"
