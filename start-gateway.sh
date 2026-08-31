#!/usr/bin/env bash
#
# Pull and start this machine's gateway. One gateway per machine, configured by .env.
# Setup lives in ./setup.sh.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

# Default: pull and start the gateway.
if ! git fetch --prune; then
	echo "ERROR: git fetch failed; gateway startup aborted" >&2
	exit 1
fi
if ! git pull; then
	echo "ERROR: git pull failed; gateway startup aborted" >&2
	exit 1
fi
echo "Deploying commit $(git rev-parse HEAD)"

# Default GATEWAY_ID to this machine's hostname when .env sets none, so two machines never both
# silently fall back to "switchboard". docker compose reads .env on its own; this export only fills
# the gap when .env has no GATEWAY_ID.
grep -qE '^GATEWAY_ID=' .env 2>/dev/null || export GATEWAY_ID="$(hostname)"
EFF_ID="$(sed -n 's/^GATEWAY_ID=//p' .env 2>/dev/null | head -1)"; EFF_ID="${EFF_ID:-${GATEWAY_ID:-$(hostname)}}"

# Auto-provision the host-daemon WS token into .env so the reserved "host" slot (which the
# console drives agent terminals through) is authenticated by default. The host daemon reads
# the same value from .env; compose reads .env on its own for the gateway side.
grep -qE '^HOST_WS_TOKEN=' .env 2>/dev/null || echo "HOST_WS_TOKEN=$(openssl rand -hex 32)" >> .env

# The gateway attaches to this network to reach the federation Router, and compose declares it
# external, so it must exist before `up`. down.sh removes it, so recreate it here rather than
# depending on start-federation.sh having run first.
docker network inspect switchboard-federation >/dev/null 2>&1 || docker network create switchboard-federation >/dev/null

docker compose down --remove-orphans 2>/dev/null || true
# --pull so a rebuild takes the base image the Dockerfile's floating tag currently names. Without it
# docker reuses whatever was cached, so two machines rebuilding the same commit can land on different
# bun majors - and the gateway's TLS pinning needs bun 1.4+. A pull failure is not fatal on its own;
# compose falls back to the cached base, and check-pinning-runtime.ts is what names an unusable one.
docker compose build --pull || echo "WARNING: could not pull a fresh base image, building on the cached one" >&2
if ! docker compose up --build -d; then
	echo "ERROR: docker compose up failed - the gateway was never started" >&2
	exit 1
fi

echo "Waiting for the gateway to be ready..."
for _ in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Gateway ready (Host: $EFF_ID)."
		exit 0
	fi
	sleep 2
done

echo "ERROR: Gateway did not become healthy within 60s - run: docker logs switchboard" >&2
exit 1
