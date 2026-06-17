#!/usr/bin/env bash
#
# Console setup - the SINGLE bootstrap for the Android Console.
#
#   ./provision-console.sh --setup    full bootstrap: cluster cutover + Domain root +
#                                      admit this Switch + a Console identity, then emit
#                                      the provisioning blob the app imports.
#   ./provision-console.sh --qr        re-open the enrollment-QR menu for the current blob
#                                      (display in terminal, or save as an image).
#   ./provision-console.sh --verify    health-probe the bridge + report what is/is not set up.
#   ./provision-console.sh --help
#
# There is no "ask evie in Discord" step and no SAS dance: this script (running on the
# trusted host with cluster access) IS the bootstrap authority. The Domain ROOT key stays
# here (reused on later --setup runs to admit more devices); only an admitted Console
# identity + the cluster creds ride the emitted blob, a 0600 host-local file. After setup, a
# menu offers that blob as a scannable QR (in-terminal or a saved image), or you paste it.
#
# Mirrors the Switch's start-arbiter.sh --setup ergonomics.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

# Every file this script writes carries key material or cluster creds. umask 077 makes
# them 0600/0700 FROM BIRTH, closing the window between create-at-default-umask and the
# explicit chmod 600 (which stay as belt-and-suspenders).
umask 077

NS="evie-bot"
CONTAINER="switchboard"                       # the arbiter container (its kubectl reaches evie)
KUBECONFIG_IN="/app/kubeconfig.yaml"
EVIE_DEPLOY="deploy/evie-bot-deployment"
FED_SECRET="evie-federation"
BRIDGE_YAML="../evie-bot/deploy/console-bridge.yaml"
SECRETS_DIR="${HOME}/android-dev/secrets"
OWNER_FILE="${SECRETS_DIR}/console-owner-identity.json"   # the Domain root, host-only, reused
BLOB_FILE="${SECRETS_DIR}/console-provisioning.json"      # the artifact the app imports
QR_GIF="${SECRETS_DIR}/console-enrollment-qr.gif"         # optional saved QR image (menu opt 2)
SERVICE="evie-console-bridge"
PORT=20004

# Carried from bootstrap_domain to emit_blob within the one --setup shell (assigned there
# without `local` so they survive the function boundary; these defaults keep set -u happy).
SETUP_CONSOLE_ID=""
SETUP_SWITCH_ID=""
SETUP_SWITCH_SIGN=""
SETUP_SWITCH_BOX=""

err() { echo "ERROR: $*" >&2; }
note() { echo ">> $*"; }

# kubectl inside the arbiter container (it already holds the evie kubeconfig).
k() { docker exec "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" -n "$NS" "$@"; }
ki() { docker exec -i "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" -n "$NS" "$@"; }

# Extract one top-level field from a JSON object on STDIN (string fields verbatim, others
# re-stringified). bun-only - bun is already required, so this avoids a python dependency -
# and the JSON, which may carry key material, rides stdin, never argv.
jget() { SB_K="$1" bun -e 'const o=JSON.parse(await Bun.stdin.text()); const v=o[process.env.SB_K]; process.stdout.write(v===undefined?"":(typeof v==="string"?v:JSON.stringify(v)))'; }

require_container() {
	docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" ||
		{ err "the '$CONTAINER' arbiter container is not running (start it with ./start-arbiter.sh)"; exit 1; }
}

# Apply the console-bridge k8s objects + ensure CONSOLE_BRIDGE_TOKEN is set so evie's
# ConsoleBridgeServer starts on 20004. Idempotent: safe to re-run.
cutover() {
	note "cutover: applying console-bridge objects (Service + SA + Role + token)"
	cat "$BRIDGE_YAML" | ki apply -f - >/dev/null || { err "kubectl apply $BRIDGE_YAML failed"; return 1; }

	if ! k get secret console-bridge-app-token >/dev/null 2>&1; then
		# Reuse the old ANDROID_BRIDGE_TOKEN value if present so an already-paste app token
		# stays valid; otherwise mint a fresh one.
		local tok
		tok=$(k get secret phone-bridge-app-token -o jsonpath='{.data.ANDROID_BRIDGE_TOKEN}' 2>/dev/null | base64 -d)
		[ -n "$tok" ] || tok=$(openssl rand -hex 32)
		k create secret generic console-bridge-app-token --from-literal=CONSOLE_BRIDGE_TOKEN="$tok" >/dev/null
		note "cutover: minted console-bridge-app-token"
	fi
	k set env "$EVIE_DEPLOY" --from=secret/console-bridge-app-token >/dev/null
	note "cutover: CONSOLE_BRIDGE_TOKEN wired into evie; waiting for rollout"
	k rollout status "$EVIE_DEPLOY" --timeout=120s >/dev/null || { err "evie rollout stalled"; return 1; }
}

# Root the Domain + admit this Switch and a Console identity, writing evie's federation
# Secret directly. The crypto is done by scripts/bootstrap-domain.ts (the real
# crypto.ts/admission.ts), so every signature verifies on the arbiter + the app.
bootstrap_domain() {
	note "bootstrap: reading evie + Switch identities"
	local evieFed swKeys switchEnv switchHost ownerArg out fedJson b64 ownerPub pin ownerTmp
	evieFed=$(k get secret "$FED_SECRET" -o jsonpath='{.data.federation\.json}' 2>/dev/null | base64 -d) ||
		{ err "could not read evie federation Secret (is evie federation up?)"; return 1; }
	swKeys=$(docker exec "$CONTAINER" cat /app/log/federation/federation-identity.json 2>/dev/null) ||
		{ err "could not read this Switch's identity"; return 1; }
	# Resolve the Switch id from the AUTHORITATIVE source - the container's SWITCH_ID env
	# (else its hostname), exactly as the arbiter's resolveLocalSwitchId does - NOT from
	# rotatable `docker logs` (the id is logged once at boot and scrolls off). bootstrap-
	# domain.ts runs both through the real sanitizeSwitchId, so the admitted id can never
	# drift from the id the arbiter registers under (a drift would store the Switch keys
	# under the wrong id and brick the Console after its first register).
	switchEnv=$(docker exec "$CONTAINER" printenv SWITCH_ID 2>/dev/null)
	switchHost=$(docker exec "$CONTAINER" hostname 2>/dev/null)

	# Reuse the Domain root if a prior --setup kept one, so re-running does not orphan
	# devices already admitted under the old owner key. If the file exists but is empty,
	# ABORT: silently minting a fresh root here would orphan every admitted device.
	ownerArg="null"
	if [ -f "$OWNER_FILE" ]; then
		[ -s "$OWNER_FILE" ] ||
			{ err "owner root $OWNER_FILE exists but is empty - refusing to re-root (delete it deliberately to start a new Domain)"; return 1; }
		ownerArg=$(cat "$OWNER_FILE")
	fi

	# All crypto + JSON happens in ONE bun call (bun is already required by this script; no
	# python dependency). RAW key material rides the ENVIRONMENT, never argv (argv is
	# world-readable in `ps`/proc/<pid>/cmdline): SB_EVIE_FED + SB_OWNER carry private keys.
	# The helper extracts evie's identity, resolves+sanitizes the Switch id, mints/reuses the
	# owner, owner-signs the switch + console admissions (MERGED into evie's existing
	# enrollment, not clobbering it), and returns them as one JSON object.
	out=$(SB_EVIE_FED="$evieFed" SB_SW_IDENT="$swKeys" SB_SWITCH_ENV="$switchEnv" SB_SWITCH_HOST="$switchHost" SB_OWNER="$ownerArg" \
		bun scripts/bootstrap-domain.ts) || { err "domain bootstrap (crypto) failed"; return 1; }

	# Carry the resolved id + the owner pubkey out for the blob, the note, and the pin check.
	SETUP_SWITCH_ID=$(printf '%s' "$out" | jget switchId)
	ownerPub=$(printf '%s' "$out" | jget ownerSignPub)
	[ -n "$SETUP_SWITCH_ID" ] && [ -n "$ownerPub" ] ||
		{ err "bootstrap output missing switchId/ownerSignPub (internal error)"; return 1; }

	# If the arbiter PINS an owner key (FEDERATION_OWNER_SIGN_PUB, untrusted-evie mode) it
	# refuses any allowlist snapshot rooted at a different key - so a stale/mismatched pin
	# silently drops this whole Domain and the Console could never seal. Abort with the exact
	# remediation rather than emitting a blob the arbiter will reject.
	pin=$(docker exec "$CONTAINER" printenv FEDERATION_OWNER_SIGN_PUB 2>/dev/null)
	if [ -n "$pin" ] && [ "$pin" != "$ownerPub" ]; then
		err "the arbiter pins a DIFFERENT Domain owner key than this root:"
		err "  arbiter FEDERATION_OWNER_SIGN_PUB = $pin"
		err "  this Domain root                  = $ownerPub"
		err "  Set FEDERATION_OWNER_SIGN_PUB=$ownerPub on the arbiter (or unset it for trust-on-first-use), restart it, then re-run --setup."
		return 1
	fi

	# Persist the Domain root host-side for future --setup runs. Write to a temp file and mv
	# into place ONLY after jget succeeds: a `> "$OWNER_FILE"` redirect truncates the live
	# root the instant it opens, so a failed extract would DESTROY the root and the next
	# --setup would silently mint a fresh one, orphaning every admitted device.
	mkdir -p "$SECRETS_DIR"
	ownerTmp=$(mktemp "${SECRETS_DIR}/.owner.XXXXXX") || { err "mktemp failed"; return 1; }
	printf '%s' "$out" | jget ownerIdentity > "$ownerTmp"
	[ -s "$ownerTmp" ] || { rm -f "$ownerTmp"; err "could not extract owner identity from bootstrap output"; return 1; }
	mv -f "$ownerTmp" "$OWNER_FILE"
	chmod 600 "$OWNER_FILE"

	# Write the rooted+admitted federation Secret (preserves evie's identity + prior admits).
	fedJson=$(printf '%s' "$out" | jget federationJson)
	[ -n "$fedJson" ] || { err "could not extract federationJson from bootstrap output"; return 1; }
	b64=$(printf '%s' "$fedJson" | base64 -w0)
	printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: Opaque\ndata:\n  federation.json: %s\n' \
		"$FED_SECRET" "$NS" "$b64" | ki apply -f - >/dev/null || { err "writing federation Secret failed"; return 1; }
	note "bootstrap: Domain rooted (owner $ownerPub); Switch '$SETUP_SWITCH_ID' + a Console admitted"

	# Restart evie so it reads the rooted state, then carry the Console identity + the home
	# Switch's PUBLIC keys to emit_blob via shell globals. The console private key never
	# touches disk outside the final 0600 blob (no /tmp hop to leak it).
	k rollout restart "$EVIE_DEPLOY" >/dev/null
	k rollout status "$EVIE_DEPLOY" --timeout=120s >/dev/null || { err "evie rollout stalled after bootstrap"; return 1; }
	SETUP_CONSOLE_ID=$(printf '%s' "$out" | jget consoleIdentity)
	SETUP_SWITCH_SIGN=$(printf '%s' "$out" | jget switchSignPub)
	SETUP_SWITCH_BOX=$(printf '%s' "$out" | jget switchBoxPub)
	[ -n "$SETUP_CONSOLE_ID" ] && [ -n "$SETUP_SWITCH_SIGN" ] && [ -n "$SETUP_SWITCH_BOX" ] ||
		{ err "bootstrap output missing console/switch keys (internal error)"; return 1; }
}

# Pull cluster creds + the freshly-admitted Console identity into the provisioning blob.
emit_blob() {
	local saToken caPem appToken apiUrl
	saToken=$(k get secret console-bridge-proxy-token -o jsonpath='{.data.token}' | base64 -d)
	caPem=$(k get secret console-bridge-proxy-token -o jsonpath='{.data.ca\.crt}' | base64 -d)
	appToken=$(k get secret console-bridge-app-token -o jsonpath='{.data.CONSOLE_BRIDGE_TOKEN}' | base64 -d)
	apiUrl=$(docker exec "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" config view --minify \
		-o jsonpath='{.clusters[0].cluster.server}')
	[ -n "$SETUP_CONSOLE_ID" ] || { err "no Console identity carried from bootstrap (internal error)"; return 1; }

	# identity   = the admitted Console keypair (the app seals its ops with this key).
	# switch*Pub = the home Switch's PUBLIC keys, so the app can seal its FIRST op TO the
	#              Switch's box key. admit-switch ran server-side here, so the app never
	#              learns these from a live enroll - they must ride the blob.
	# The writer VALIDATES against the shared ProvisioningSchema before writing (a field
	# drift fails loudly here, not silently on the device). Via the ENVIRONMENT, not argv:
	# saToken/appToken/identity are secrets and argv is world-readable in `ps`; caPem's
	# newlines ride env cleanly too.
	SB_API="$apiUrl" SB_CA="$caPem" SB_SA="$saToken" SB_APP="$appToken" \
	SB_CONSOLE_ID="$SETUP_CONSOLE_ID" SB_SWID="$SETUP_SWITCH_ID" SB_SSIGN="$SETUP_SWITCH_SIGN" SB_SBOX="$SETUP_SWITCH_BOX" \
	SB_NS="$NS" SB_SVC="$SERVICE" SB_PORT="$PORT" SB_BLOB="$BLOB_FILE" \
		bun scripts/write-provisioning-blob.ts || { err "writing blob failed (schema validation?)"; return 1; }
	chmod 600 "$BLOB_FILE"
	note "blob written: $BLOB_FILE  (cluster creds + Console identity + home Switch '$SETUP_SWITCH_ID' keys)"
}

# Health-probe the full service-proxy -> bridge path with the emitted creds. Uses an
# AUTHENTICATED POST /ingest, NOT a GET: the bridge answers GET 200 BEFORE the app-token
# gate, so a GET would pass even with a wrong token (the exact bug that stranded the app
# on 401 after import). POST /ingest exercises the real auth path, is served locally at
# evie (no arbiter relay, so it isolates bridge+creds from arbiter connectivity), and
# leaves a greppable [console-ingest] line in evie's stdout.
verify() {
	[ -f "$BLOB_FILE" ] || { err "no blob at $BLOB_FILE - run --setup first"; return 1; }
	local apiUrl saToken appToken ca cfg code blobvals
	ca=$(mktemp); cfg=$(mktemp)
	# One bun read: write caPem (multiline) to the temp CA file, print the 3 scalar fields.
	blobvals=$(SB_BLOB="$BLOB_FILE" SB_CA="$ca" bun -e '
		const b = JSON.parse(await Bun.file(process.env.SB_BLOB).text());
		await Bun.write(process.env.SB_CA, b.caPem ?? "");
		process.stdout.write([b.apiUrl ?? "", b.saToken ?? "", b.appToken ?? ""].join("\n"));
	') || { rm -f "$ca" "$cfg"; err "could not read blob $BLOB_FILE"; return 1; }
	{ read -r apiUrl; read -r saToken; read -r appToken; } <<< "$blobvals"
	# Both bearer tokens go in a 0600 curl config (-K), NOT on argv - argv is world-readable
	# in `ps`, the same leak the env-not-argv plumbing closes everywhere else.
	printf 'header = "Authorization: Bearer %s"\nheader = "X-Console-Bridge-Token: Bearer %s"\n' "$saToken" "$appToken" > "$cfg"
	# Poll: ConsoleBridge binds 20004 a few seconds AFTER the evie pod reports ready,
	# so the service-proxy returns 503 (no endpoints) briefly after a (re)start. 401/404
	# are terminal (wrong token / objects not applied) - fail fast, don't burn the retries.
	code=000
	for _ in $(seq 1 15); do
		code=$(curl -s --cacert "$ca" -K "$cfg" -X POST \
			-H "Content-Type: application/json" \
			--data '{"conversationId":"provision-verify","lines":["provision-console.sh --verify auth probe"]}' \
			-o /dev/null -w '%{http_code}' \
			"$apiUrl/api/v1/namespaces/$NS/services/$SERVICE:$PORT/proxy/ingest" 2>&1)
		case "$code" in
			200) break ;;
			401) rm -f "$ca" "$cfg"; err "VERIFY: app token REJECTED (HTTP 401) - the CONSOLE_BRIDGE_TOKEN in the blob does not match evie's. Re-run --setup"; return 1 ;;
			404) rm -f "$ca" "$cfg"; err "VERIFY: bridge not found (HTTP 404) - console-bridge Service/objects not applied. Re-run --setup"; return 1 ;;
		esac
		sleep 3
	done
	rm -f "$ca" "$cfg"
	if [ "$code" = "200" ]; then note "VERIFY: console bridge reachable + app token accepted (authenticated POST 200) - ready to import the blob"; else
		err "VERIFY: bridge probe returned HTTP $code after retries (bridge still starting / creds) - re-run --verify shortly, or --setup"; return 1; fi
}

# Render the blob as a QR in this terminal (wide - the blob is ~2.7KB, ~177 modules).
render_qr_terminal() {
	SB_BLOB="$BLOB_FILE" SB_QR_MODE=terminal bun scripts/render-provisioning-qr.ts ||
		{ err "could not render the QR (is the blob present?)"; return 1; }
}

# Save the blob's QR as a 0600 GIF and echo the path. Camera-friendly at any size.
save_qr_image() {
	SB_BLOB="$BLOB_FILE" SB_QR_MODE=image SB_QR_OUT="$QR_GIF" bun scripts/render-provisioning-qr.ts >/dev/null 2>&1 || return 1
	chmod 600 "$QR_GIF" 2>/dev/null
	printf '%s' "$QR_GIF"
}

# Post-setup dial menu: show the enrollment QR in the terminal, or save it as an image.
# Quitting deletes a saved QR (the only enrollment-process file this leaves behind); the
# 0600 blob stays at its path. Only runs interactively (skipped when stdin is not a TTY).
qr_menu() {
	local choice saved=""
	while true; do
		echo
		echo "  Enrollment QR  (encodes $BLOB_FILE)"
		echo "    1) Display the QR in this terminal (wide)"
		echo "    2) Save the QR as an image -> $QR_GIF"
		if [ -n "$saved" ]; then
			echo "    q) Delete the saved QR and quit"
		else
			echo "    q) Quit"
		fi
		read -rp "  > " choice || break
		case "$choice" in
			1) echo; render_qr_terminal; echo ;;
			2)
				if saved=$(save_qr_image); then
					note "saved: $saved  (open it and scan, or send it to the phone)"
				else
					err "could not save the QR image"; saved=""
				fi
				;;
			q | Q)
				[ -n "$saved" ] && { rm -f "$saved" && note "deleted saved QR: $saved"; }
				note "Done. The blob remains at $BLOB_FILE (0600) for re-display via --qr."
				break
				;;
			*) err "unknown option: '$choice' (use 1, 2, or q)" ;;
		esac
	done
}

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
	--setup)
		require_container
		cutover && bootstrap_domain && emit_blob && verify || exit 1
		echo
		note "Setup complete. Blob: $BLOB_FILE"
		if [ -t 0 ]; then
			qr_menu
		else
			note "Import $BLOB_FILE into the Console app (paste, or scan its QR via --qr). No enroll step."
		fi
		;;
	--qr)
		[ -f "$BLOB_FILE" ] || { err "no blob at $BLOB_FILE - run --setup first"; exit 1; }
		qr_menu
		;;
	--verify) require_container; verify ;;
	--help | "" ) usage ;;
	*) err "unknown option: $1"; usage; exit 1 ;;
esac
