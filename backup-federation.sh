#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")" || exit 1

# The archive carries the Router private key and both bearer tokens.
umask 077

IMAGE="switchboard-federation-federation:latest"

if [ "$(docker inspect -f '{{.State.Running}}' switchboard-federation 2>/dev/null || true)" = "true" ]; then
	echo "Federation Router is running. Stop it before backing up." >&2
	exit 1
fi

mkdir -p ./volumes/federation-backups
timestamp="$(date +%Y%m%d-%H%M%S)"
archive="./volumes/federation-backups/federation-${timestamp}.tar.gz"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

# The cert and key are written by the container as root at 0600, so the host cannot read them.
# Copy through a container and hand ownership back, or the two unrecoverable files are the exact
# two the backup would silently omit.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "ERROR: image $IMAGE not found - run ./start-federation.sh once first" >&2
	exit 1
fi
docker run --rm \
	-v "$(pwd)/volumes/federation-data:/data:ro" \
	-v "$staging:/out" \
	--entrypoint sh "$IMAGE" \
	-c "cp -a /data /out/federation-data && chown -R $(id -u):$(id -g) /out/federation-data"

for required in federation.json router-cert.pem router-key.pem; do
	if [ ! -s "$staging/federation-data/$required" ]; then
		echo "ERROR: $required missing from the staged copy - refusing to write a partial backup" >&2
		exit 1
	fi
done

# The tokens live in .env, not the data volume, so a data-only archive restores an identity the
# gateway and console can no longer authenticate to.
if ! grep -E '^(CONSOLE_BRIDGE_TOKEN|FEDERATION_WS_TOKEN)=' .env > "$staging/federation-tokens.env" 2>/dev/null; then
	echo "ERROR: .env carries neither Router token - the restore would authenticate nobody" >&2
	exit 1
fi
if [ "$(wc -l < "$staging/federation-tokens.env")" -ne 2 ]; then
	echo "ERROR: expected both Router tokens in .env, found $(wc -l < "$staging/federation-tokens.env")" >&2
	exit 1
fi

tar -czf "$archive" -C "$staging" federation-data federation-tokens.env
chmod 600 "$archive"
echo "Created $archive (data volume + both Router tokens)"
echo "Restore: stop Router, restore, verify fingerprint matches pinned clients, start Router, verify gateway registration."
echo "An OLD snapshot can resurrect revoked members and spent nonces. Reconcile the allowlist after restoring one."
