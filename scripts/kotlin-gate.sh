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

cd android || exit 1
exec ./gradlew :app:testDebugUnitTest --console=plain "$@"
