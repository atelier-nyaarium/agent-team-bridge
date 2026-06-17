#!/usr/bin/env bash
#
# No args:   quick-start this machine's arbiter (git pull + compose up).
# --setup:   interactive .env configure / teardown / clean re-setup for this
#            machine's single arbiter. One arbiter per machine.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

ENV_FILE=".env"

err() { echo "ERROR: $*" >&2; }

# Value of KEY in .env (everything after the first '='), or empty.
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }

# Set KEY=VALUE in .env, replacing an existing line or appending, keeping the rest.
env_set() {
	local key="$1" val="$2" tmp
	touch "$ENV_FILE"
	tmp="$(mktemp)"
	grep -vE "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
	printf '%s=%s\n' "$key" "$val" >> "$tmp"
	mv "$tmp" "$ENV_FILE"
}

wait_health() {
	echo "Waiting for the arbiter on :20000 ..."
	for _ in $(seq 1 30); do
		if curl -sf http://localhost:20000/health >/dev/null 2>&1; then return 0; fi
		sleep 2
	done
	return 1
}

show_qr() {
	echo
	echo "=== Admit-host QR (scan with the owner phone, then confirm the SAS) ==="
	docker logs switchboard 2>&1 | sed -n '/open Enroll by QR/,/Confirm this fingerprint/p' || true
	echo "(empty above = no QR; it prints only when BRIDGE_TOKEN is set and the Host is un-admitted)"
}

# Empty volumes/arbiter. The arbiter writes these files as the in-container user,
# so the host-side rm is "Permission denied"; wipe them with a throwaway root
# container that has the same bind mount.
wipe_state() {
	[ -d volumes/arbiter ] || return 0
	docker run --rm -u 0 -v "$(pwd)/volumes/arbiter:/w" busybox \
		sh -c 'cd /w && rm -rf -- ..?* .[!.]* * 2>/dev/null; true' \
		|| { err "could not wipe volumes/arbiter (is docker up?)"; return 1; }
}

configure() {
	local cur_id cur_token cur_pin def_id raw
	cur_id="$(env_get HOST_ID)"
	cur_token="$(env_get BRIDGE_TOKEN)"
	cur_pin="$(env_get FEDERATION_OWNER_SIGN_PUB)"
	def_id="${cur_id:-$(hostname)}"

	echo "Current .env:"
	echo "  HOST_ID                   : ${cur_id:-(unset -> switchboard)}"
	echo "  BRIDGE_TOKEN              : ${cur_token:+set}${cur_token:-(unset)}"
	echo "  FEDERATION_OWNER_SIGN_PUB : ${cur_pin:-(none)}"
	echo

	local id token pin
	read -rp "HOST_ID (unique per machine) [$def_id]: " raw; id="${raw:-$def_id}"
	if [ -n "$cur_token" ]; then
		read -rp "BRIDGE_TOKEN [keep current]: " raw; token="${raw:-$cur_token}"
	else
		read -rp "BRIDGE_TOKEN (required for evie/federation + the admit-host QR): " token
	fi
	read -rp "FEDERATION_OWNER_SIGN_PUB pin (optional) [${cur_pin:-none}]: " raw; pin="${raw:-$cur_pin}"

	env_set HOST_ID "$id"
	env_set BRIDGE_TOKEN "$token"
	env_set FEDERATION_OWNER_SIGN_PUB "$pin"
	chmod 600 "$ENV_FILE" 2>/dev/null || true
	echo "Wrote $ENV_FILE (HOST_ID=$id, token ${token:+set}${token:-EMPTY})."
	[ -n "$token" ] || echo "WARNING: empty token -> the evie bridge will not start (no QR)."

	echo "Building + starting the arbiter ..."
	docker compose up --build -d || { err "compose up failed"; return 1; }
	if wait_health; then
		echo "Arbiter healthy on :20000 (HOST_ID=$id)."
		[ -n "$token" ] && { sleep 6; show_qr; }
	else
		err "arbiter did not become healthy in 60s; check: docker logs switchboard"
	fi
}

teardown() {
	docker compose down --remove-orphans 2>/dev/null || true
	echo "Arbiter stopped."
	local w; read -rp "Wipe its state volume volumes/arbiter (identity + allowlist)? [y/N]: " w
	[ "$w" = y ] && wipe_state && echo "wiped volumes/arbiter"
}

re_setup() {
	echo "This stops the arbiter, WIPES volumes/arbiter (keypair + allowlist), and restarts it."
	echo "It re-mints its identity and prints a fresh admit-host QR for re-enrollment."
	local ok; read -rp "Proceed? [y/N]: " ok; [ "$ok" = y ] || return 0
	docker compose down --remove-orphans 2>/dev/null || true
	wipe_state || return 1
	docker compose up --build -d || { err "compose up failed"; return 1; }
	if wait_health; then
		echo "Arbiter healthy."
		sleep 6; show_qr
	else
		err "arbiter did not become healthy; check: docker logs switchboard"
	fi
}

setup_menu() {
	while true; do
		echo
		echo "switchboard arbiter setup (this machine)"
		echo "  1) Configure .env + (re)start the arbiter"
		echo "  2) Tear down (stop; optional state wipe)"
		echo "  3) Clean re-setup (wipe identity + restart, fresh enrollment)"
		echo "  q) quit"
		local c; read -rp "> " c
		case "$c" in
			1) configure ;;
			2) teardown ;;
			3) re_setup ;;
			q | Q | "") break ;;
			*) echo "?" ;;
		esac
	done
}

if [ "${1:-}" = "--setup" ]; then
	setup_menu
	exit 0
fi

# Default: quick-start the arbiter (unchanged behavior).
git fetch --prune || true
git pull || true

docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

echo "Waiting for arbiter to be ready..."
for i in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Arbiter is ready. Waiting 10s for evie-bot connection..."
		sleep 10
		exit 0
	fi
	sleep 2
done

echo "WARNING: Arbiter did not become healthy within 60s"
exit 1
