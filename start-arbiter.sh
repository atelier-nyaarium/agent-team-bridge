#!/usr/bin/env bash
#
# No args:  pull and start this machine's arbiter.
# --setup:  menu to start, stop, or purge it.
# One arbiter per machine, configured by .env.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

ENV_FILE=".env"

err() { echo "ERROR: $*" >&2; }

# Value of KEY in .env (text after the first '='), or empty. KEYs here are fixed
# [A-Z_] constants, so they need no pattern escaping.
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }

# Write KEY=VALUE to .env, replacing any existing line and keeping the rest.
env_set() {
	local key="$1" val="$2" tmp
	touch "$ENV_FILE"
	tmp="$(mktemp)"
	grep -vE "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
	printf '%s=%s\n' "$key" "$val" >> "$tmp"
	mv "$tmp" "$ENV_FILE" || { rm -f "$tmp"; err "could not write $ENV_FILE"; return 1; }
}

wait_health() {
	echo "Waiting for the arbiter to be ready..."
	for _ in $(seq 1 30); do
		curl -sf http://localhost:20000/health >/dev/null 2>&1 && return 0
		sleep 2
	done
	return 1
}

# Print the admit-host QR if the arbiter is showing one, else say why it isn't.
print_qr() {
	local qr
	qr="$(docker logs switchboard 2>&1 | sed -n '/open Enroll by QR/,/Confirm this fingerprint/p')"
	echo
	if [ -n "$qr" ]; then
		echo "Admit-host QR (scan with the owner phone, confirm the fingerprint):"
		echo "$qr"
	else
		echo "No admit-host QR (Host already admitted, or no BRIDGE_TOKEN set)."
	fi
}

# Erase volumes/arbiter. The arbiter writes it as the in-container user, so a
# host-side rm is "Permission denied"; a root container with the same mount clears it.
wipe_state() {
	[ -d volumes/arbiter ] || return 0
	docker run --rm -u 0 -v "$(pwd)/volumes/arbiter:/w" busybox \
		sh -c 'cd /w && rm -rf -- ..?* .[!.]* * 2>/dev/null; true' \
		|| { err "could not erase volumes/arbiter (is docker running?)"; return 1; }
}

start() {
	local id token pin cur_id cur_token cur_pin raw host
	host="$(hostname)"
	cur_id="$(env_get HOST_ID)"
	cur_token="$(env_get BRIDGE_TOKEN)"
	cur_pin="$(env_get FEDERATION_OWNER_SIGN_PUB)"

	read -rp "HOST_ID (this arbiter's name) [${cur_id:-$host}]: " raw
	id="${raw:-${cur_id:-$host}}"
	if [ -n "$cur_token" ]; then
		read -rp "BRIDGE_TOKEN [keep existing]: " raw; token="${raw:-$cur_token}"
	else
		read -rp "BRIDGE_TOKEN (shared evie token; blank = standalone): " token
	fi
	read -rp "Owner key pin (optional) [${cur_pin:-none}]: " raw
	pin="${raw:-$cur_pin}"

	env_set HOST_ID "$id" || return 1
	env_set BRIDGE_TOKEN "$token" || return 1
	env_set FEDERATION_OWNER_SIGN_PUB "$pin" || return 1
	chmod 600 "$ENV_FILE" 2>/dev/null || true
	[ -n "$token" ] || echo "Running standalone (no mesh, no QR)."

	echo "Building and starting the arbiter..."
	docker compose up --build -d || { err "docker compose up failed"; return 1; }
	if wait_health; then
		echo "Arbiter running on :20000 (Host: $id)."
		[ -n "$token" ] && { sleep 6; print_qr; }
	else
		err "did not come up in 60s - run: docker logs switchboard"
		return 1
	fi
}

stop() {
	docker compose down --remove-orphans 2>/dev/null || true
	echo "Stopped (identity + data kept). Resume: ./start-arbiter.sh"
}

purge() {
	echo "Erase this arbiter's identity + data (keypair, admissions, mailboxes)?"
	echo "On its next start it mints a NEW keypair + admit-host QR, so the owner"
	echo "phone must re-scan it to re-admit this Host."
	local ok; read -rp "Erase and stop? [y/N]: " ok
	[ "$ok" = y ] || return 0
	docker compose down --remove-orphans 2>/dev/null || true
	wipe_state && echo "Erased. Run Start (option 1) to bring it up fresh."
}

menu() {
	while true; do
		echo
		echo "switchboard arbiter on $(hostname)"
		echo "  1) Start  - configure .env and run"
		echo "  2) Stop   - stop, keep identity"
		echo "  3) Purge  - stop, erase identity"
		echo "  q) Quit"
		local c; read -rp "> " c
		case "$c" in
			1) start ;;
			2) stop ;;
			3) purge ;;
			q | Q | "") break ;;
			*) echo "Enter 1, 2, 3, or q." ;;
		esac
	done
}

if [ "${1:-}" = "--setup" ]; then
	menu
	exit 0
fi

# Default: pull and start the arbiter.
git fetch --prune || true
git pull || true

# Default HOST_ID to this machine's hostname when .env sets none, so two machines
# never both silently fall back to "switchboard". docker compose reads .env on its
# own; this export only fills the gap when .env has no HOST_ID.
grep -qE '^HOST_ID=' "$ENV_FILE" 2>/dev/null || export HOST_ID="$(hostname)"
EFF_ID="$(env_get HOST_ID)"; EFF_ID="${EFF_ID:-${HOST_ID:-switchboard}}"

docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

echo "Waiting for the arbiter to be ready..."
for i in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Arbiter ready (Host: $EFF_ID). Waiting 10s for evie-bot..."
		sleep 10
		exit 0
	fi
	sleep 2
done

err "Arbiter did not become healthy within 60s - run: docker logs switchboard"
exit 1
