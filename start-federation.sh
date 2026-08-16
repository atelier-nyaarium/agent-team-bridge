#!/usr/bin/env bash
#
# Start the federation Router without touching the gateway. Thin launcher for
# scripts/start-federation.ts, which owns every .env key the Router reads.

set -uo pipefail
cd "$(dirname "$0")" || exit 1
exec bun run scripts/start-federation.ts "$@"
