#!/usr/bin/env bash
#
# No args:           pull and start this machine's gateway.
# --setup / --enroll: configure or LAN-enroll it (run in bun via scripts/gateway-setup.ts).
# One gateway per machine, configured by .env.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

case "${1:-}" in
	--setup | --enroll)
		exec bun run scripts/gateway-setup.ts "$@"
		;;
	--*)
		echo "ERROR: unknown option: $1 (expected --setup or --enroll, or no args to start)" >&2
		exit 1
		;;
esac

# Default: pull and start the gateway.
git fetch --prune || true
git pull || true

# Default GATEWAY_ID to this machine's hostname when .env sets none, so two machines never both
# silently fall back to "switchboard". docker compose reads .env on its own; this export only fills
# the gap when .env has no GATEWAY_ID.
grep -qE '^GATEWAY_ID=' .env 2>/dev/null || export GATEWAY_ID="$(hostname)"
EFF_ID="$(sed -n 's/^GATEWAY_ID=//p' .env 2>/dev/null | head -1)"; EFF_ID="${EFF_ID:-${GATEWAY_ID:-$(hostname)}}"

# Auto-provision the host-daemon WS token into .env so the reserved "host" slot (which the
# console drives agent terminals through) is authenticated by default. The host daemon reads
# the same value from .env; compose reads .env on its own for the gateway side.
grep -qE '^HOST_WS_TOKEN=' .env 2>/dev/null || echo "HOST_WS_TOKEN=$(openssl rand -hex 32)" >> .env

docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

echo "Waiting for the gateway to be ready..."
for _ in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Gateway ready (Host: $EFF_ID). Waiting 10s for evie-bot..."
		sleep 10
		exit 0
	fi
	sleep 2
done

echo "ERROR: Gateway did not become healthy within 60s - run: docker logs switchboard" >&2
exit 1
