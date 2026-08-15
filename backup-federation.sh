#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")" || exit 1

if [ "$(docker inspect -f '{{.State.Running}}' switchboard-federation 2>/dev/null || true)" = "true" ]; then
	echo "Federation Router is running. Stop it before backing up." >&2
	exit 1
fi

mkdir -p ./volumes/federation-backups
timestamp="$(date +%Y%m%d-%H%M%S)"
archive="./volumes/federation-backups/federation-${timestamp}.tar.gz"

# The tokens live in .env, not the data volume, so a data-only archive restores an identity
# the gateway and console can no longer authenticate to. Stage them beside the data.
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -r ./volumes/federation-data "$staging/federation-data"
grep -E '^(CONSOLE_BRIDGE_TOKEN|FEDERATION_WS_TOKEN)=' .env > "$staging/federation-tokens.env" 2>/dev/null || true

tar -czf "$archive" -C "$staging" federation-data federation-tokens.env
echo "Created $archive (data volume + the two Router tokens from .env)"
echo "Restore: stop Router, restore, verify fingerprint matches pinned clients, start Router, verify gateway registration."
echo "An OLD snapshot can resurrect revoked members and spent nonces. Reconcile the allowlist after restoring one."
