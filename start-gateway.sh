#!/usr/bin/env bash
#
# No args:  pull and start this machine's gateway.
# --setup:  menu to configure or purge it.
# One gateway per machine, configured by .env.

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
	echo "Waiting for the gateway to be ready..."
	for _ in $(seq 1 30); do
		curl -sf http://localhost:20000/health >/dev/null 2>&1 && return 0
		sleep 2
	done
	return 1
}

# Print the admit-gateway QR if the gateway is showing one, else say why it isn't.
print_qr() {
	local qr
	qr="$(docker logs switchboard 2>&1 | sed -n '/open Enroll by QR/,/Confirm this fingerprint/p')"
	echo
	if [ -n "$qr" ]; then
		echo "Admit-host QR (scan with the owner console, confirm the fingerprint):"
		echo "$qr"
	else
		echo "No admit-gateway QR (Gateway already admitted, or no BRIDGE_TOKEN set)."
	fi
}

# Erase volumes/gateway. The gateway writes it as the in-container user, so a
# host-side rm is "Permission denied"; a root container with the same mount clears it.
wipe_state() {
	[ -d volumes/gateway ] || return 0
	docker run --rm -u 0 -v "$(pwd)/volumes/gateway:/w" busybox \
		sh -c 'cd /w && rm -rf -- ..?* .[!.]* * 2>/dev/null; true' \
		|| { err "could not erase volumes/gateway (is docker running?)"; return 1; }
}

configure() {
	local id token owner_key cur_id cur_token cur_owner raw host
	host="$(hostname)"
	cur_id="$(env_get GATEWAY_ID)"
	cur_token="$(env_get BRIDGE_TOKEN)"
	cur_owner="$(env_get FEDERATION_OWNER_SIGN_PUB)"

	# The Gateway is named by the device hostname; a pre-set GATEWAY_ID stays as the
	# escape hatch for duplicate hostnames, but there is no nickname prompt.
	id="${cur_id:-$host}"
	if [ -n "$cur_token" ]; then
		read -rp "BRIDGE_TOKEN [keep existing]: " raw; token="${raw:-$cur_token}"
	else
		read -rp "BRIDGE_TOKEN (shared evie token; blank = standalone): " token
	fi
	# FEDERATION_OWNER_SIGN_PUB is the owner's Ed25519 signing PUBLIC key: a long base64
	# string copied from the app's owner-key screen, not a numeric code. Pinning it makes
	# this Gateway refuse any allowlist not rooted at that owner, so a compromised evie
	# cannot re-root it at an attacker key. Blank = trust the first owner that enrolls.
	echo "Owner signing key (optional): paste the base64 key from the app to pin which"
	echo "owner this Gateway trusts. Blank = trust on first enrollment."
	read -rp "Owner signing key [${cur_owner:-none}]: " raw
	owner_key="${raw:-$cur_owner}"

	env_set GATEWAY_ID "$id" || return 1
	env_set BRIDGE_TOKEN "$token" || return 1
	env_set FEDERATION_OWNER_SIGN_PUB "$owner_key" || return 1
	chmod 600 "$ENV_FILE" 2>/dev/null || true
	[ -n "$token" ] || echo "Running standalone (no mesh, no QR)."

	echo "Building and starting the gateway..."
	docker compose up --build -d || { err "docker compose up failed"; return 1; }
	if wait_health; then
		echo "Gateway running on :20000 (Host: $id)."
		[ -n "$token" ] && { sleep 6; print_qr; }
	else
		err "did not come up in 60s - run: docker logs switchboard"
		return 1
	fi
}

purge() {
	echo "Purge wipes this machine's gateway setup back to nothing:"
	echo "  - .env (GATEWAY_ID, BRIDGE_TOKEN, owner signing key)"
	echo "  - volumes/gateway (keypair, admissions, mailboxes)"
	echo "Configure afterward mints a NEW keypair + admit-gateway QR, so the owner console"
	echo "must re-scan to re-admit this Gateway."
	local ok; read -rp "Purge everything? [y/N]: " ok
	[ "$ok" = y ] || return 0
	docker compose down --remove-orphans 2>/dev/null || true
	wipe_state
	rm -f "$ENV_FILE"
	echo "Purged. Run Configure (option 1) to set it up fresh."
}

# Creds-less LAN enrollment: arm a one-time nonce + advertise this host's LAN address, start
# the gateway so it prints the admit-gateway QR, and wait for the admin Console to deliver a
# sealed bundle to POST /enroll. After delivery, a plain restart connects via the installed
# service-proxy transport.
enroll() {
	local nonce host
	nonce="$(openssl rand -hex 16)"
	host="$(hostname -I 2>/dev/null | awk '{print $1}')"
	[ -n "$host" ] || host="0.0.0.0"
	echo "Arming one-time LAN enrollment on ${host}:20000 (nonce ${nonce:0:8}...)."
	docker compose down --remove-orphans 2>/dev/null || true
	ENROLL_NONCE="$nonce" ENROLL_LAN_HOST="$host" docker compose up --build -d ||
		{ err "docker compose up failed"; return 1; }
	if ! wait_health; then err "did not come up in 60s - run: docker logs switchboard"; return 1; fi
	sleep 4
	echo
	echo "Scan this with the admin Console (Add Gateway). It carries the LAN target + nonce:"
	docker logs switchboard 2>&1 | sed -n '/is not yet admitted/,/Waiting for the admin Console/p'
	echo
	echo "When the Console reports the Gateway delivered, run ./start-gateway.sh to connect."
}

menu() {
	while true; do
		echo
		echo "Switchboard - Gateway setup on $(hostname)"
		echo "  1) Configure     - Set up .env and restart the gateway"
		echo "  0) Purge configs - Erase .env, identity, and data"
		echo "  q) Quit"
		local c; read -rp "> " c
		case "$c" in
			1) configure ;;
			0) purge ;;
			q | Q | "") break ;;
			*) echo "Enter 1, 0, or q." ;;
		esac
	done
}

if [ "${1:-}" = "--setup" ]; then
	menu
	exit 0
fi

if [ "${1:-}" = "--enroll" ]; then
	enroll
	exit $?
fi

# Default: pull and start the gateway.
git fetch --prune || true
git pull || true

# Default GATEWAY_ID to this machine's hostname when .env sets none, so two machines
# never both silently fall back to "switchboard". docker compose reads .env on its
# own; this export only fills the gap when .env has no GATEWAY_ID.
grep -qE '^GATEWAY_ID=' "$ENV_FILE" 2>/dev/null || export GATEWAY_ID="$(hostname)"
EFF_ID="$(env_get GATEWAY_ID)"; EFF_ID="${EFF_ID:-${GATEWAY_ID:-$(hostname)}}"

docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

echo "Waiting for the gateway to be ready..."
for i in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Gateway ready (Host: $EFF_ID). Waiting 10s for evie-bot..."
		sleep 10
		exit 0
	fi
	sleep 2
done

err "Gateway did not become healthy within 60s - run: docker logs switchboard"
exit 1
