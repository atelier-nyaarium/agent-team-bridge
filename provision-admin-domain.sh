#!/usr/bin/env bash
#
# Thin launcher for the admin home Domain setup. All logic lives in scripts/provision.ts (run with bun);
# this stays a .sh entry point for muscle memory and docs. See that file for the flags:
# --setup, --qr, --gateway-transport, --verify, --help.

set -uo pipefail
cd "$(dirname "$0")" || exit 1
exec bun run scripts/provision.ts "$@"
