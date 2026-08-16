#!/usr/bin/env bash

set -uo pipefail
cd "$(dirname "$0")" || exit 1

grep -qE '^CONSOLE_BRIDGE_TOKEN=' .env 2>/dev/null || echo "CONSOLE_BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
grep -qE '^FEDERATION_WS_TOKEN=' .env 2>/dev/null || echo "FEDERATION_WS_TOKEN=$(openssl rand -hex 32)" >> .env

# The two reach settings are the owner's to fill, not ours to mint. Say so rather than start a
# Router no phone can find: a loopback bind is unreachable from any device, and a missing public
# host means a phone that leaves the LAN cannot get home even with the port forwarded.
BIND="$(grep -oE '^FEDERATION_BIND=.*' .env 2>/dev/null | head -1 | cut -d= -f2-)"
PUBLIC_HOST="$(grep -oE '^FEDERATION_PUBLIC_HOST=.*' .env 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "$BIND" ] || [ "$BIND" = "127.0.0.1" ]; then
	echo "NOTE: FEDERATION_BIND is unset or loopback in .env - the Router will not be reachable from a phone." >&2
	echo "      Set FEDERATION_BIND=<this machine's LAN address> and rerun." >&2
fi
if [ -z "$PUBLIC_HOST" ]; then
	echo "NOTE: FEDERATION_PUBLIC_HOST is unset in .env - a phone off this LAN cannot reach the Router." >&2
	echo "      Set FEDERATION_PUBLIC_HOST=<your domain or public IP> once port 20001 is forwarded here." >&2
fi

if ! docker network inspect switchboard-federation >/dev/null 2>&1; then
	docker network create switchboard-federation >/dev/null
fi

if ! docker compose -f docker-compose.federation.yml -p switchboard-federation up --build -d; then
	echo "ERROR: docker compose up failed - the Router was never started" >&2
	exit 1
fi

# Probe whatever the compose file actually bound. A LAN FEDERATION_BIND unbinds loopback, so a
# hardcoded localhost probe reports a healthy Router as a 60s timeout.
PROBE_HOST="${BIND:-127.0.0.1}"
[ "$PROBE_HOST" = "0.0.0.0" ] && PROBE_HOST="127.0.0.1"

echo "Waiting for the federation Router to be ready..."
for _ in $(seq 1 30); do
	if curl -skf "https://${PROBE_HOST}:20001/health" >/dev/null 2>&1; then
		echo "Federation Router ready. TLS fingerprint:"
		docker logs switchboard-federation 2>&1 | grep -m1 'TLS fingerprint' || true
		exit 0
	fi
	sleep 2
done

echo "ERROR: Federation Router did not become healthy within 60s - run: docker logs switchboard-federation" >&2
exit 1
