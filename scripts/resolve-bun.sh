#!/usr/bin/env bash
#
# Finds bun for the launchers. Source it, don't run it.
#
# Don't trust PATH. The stock .bashrc quits early for non-interactive shells, and bun's installer
# adds its PATH line below that, so bun is there when you type it but missing from cron.
#
# Callers decide what to do when it's missing.

resolve_bun() {
	command -v bun 2>/dev/null && return 0
	for candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun"; do
		if [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

BUN_SEARCHED='PATH, $BUN_INSTALL/bin, ~/.bun/bin'
