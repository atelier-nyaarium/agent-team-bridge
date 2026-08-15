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
tar -czf "$archive" -C ./volumes federation-data
echo "Created $archive"
echo "Restore: stop Router, restore, verify fingerprint matches pinned clients, start Router, verify gateway registration."
