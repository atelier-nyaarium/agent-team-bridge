#!/usr/bin/env bash
#
# The Kotlin half of the gate, from anywhere. Resolves the repo root itself, so a shell left in a
# subdirectory cannot turn the run into "cd: android: No such file or directory".

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=/dev/null
[ -f ~/android-dev/env.sh ] && . ~/android-dev/env.sh

# CI runs the same guard.
bun scripts/check-kotlin-imports.ts || exit 1

# Fresh regeneration must match.
fixtures=tests/fixtures/wire/kotlin
fresh=$(mktemp -d)
trap 'rm -rf "$fresh"' EXIT
(cd android && ./gradlew :app:generateWireFixtures -PwireFixturesOut="$fresh" --console=plain) || exit 1
if ! diff -r "$fixtures" "$fresh" >&2; then
	echo "kotlin-gate: $fixtures drifted; run ./gradlew :app:generateWireFixtures from android/ and commit" >&2
	exit 1
fi

cd android || exit 1
exec ./gradlew :app:testDebugUnitTest --console=plain "$@"
