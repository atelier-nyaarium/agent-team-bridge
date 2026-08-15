#!/usr/bin/env bash

set -uo pipefail
cd "$(dirname "$0")" || exit 1

grep -qE '^CONSOLE_BRIDGE_TOKEN=' .env 2>/dev/null || echo "CONSOLE_BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
grep -qE '^FEDERATION_WS_TOKEN=' .env 2>/dev/null || echo "FEDERATION_WS_TOKEN=$(openssl rand -hex 32)" >> .env

if ! docker network inspect switchboard-federation >/dev/null 2>&1; then
	docker network create switchboard-federation >/dev/null
fi

if ! docker compose -f docker-compose.federation.yml -p switchboard-federation up --build -d; then
	echo "ERROR: docker compose up failed - the Router was never started" >&2
	exit 1
fi

echo "Waiting for the federation Router to be ready..."
for _ in $(seq 1 30); do
	if curl -skf https://localhost:20001/health >/dev/null 2>&1; then
		echo "Federation Router ready. TLS fingerprint:"
		docker logs switchboard-federation 2>&1 | grep -m1 'TLS fingerprint' || true
		exit 0
	fi
	sleep 2
done

echo "ERROR: Federation Router did not become healthy within 60s - run: docker logs switchboard-federation" >&2
exit 1
