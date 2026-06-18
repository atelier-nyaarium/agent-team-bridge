#!/usr/bin/env bash
#
# Console setup - the SINGLE bootstrap for the Android Console.
#
#   ./provision-console.sh --setup    interactive menu: Provision (cutover + root the Domain
#                                      at the CONSOLE owner key + emit the transport blob) or
#                                      Purge (clean-break wipe). Non-TTY runs Provision direct.
#   ./provision-console.sh --gateway-transport  move the local Gateway off port-forward onto
#                                      the service-proxy WS (run AFTER validating WS-over-proxy).
#   ./provision-console.sh --qr        re-open the enrollment-QR menu for the current blob.
#   ./provision-console.sh --verify    health-probe the bridge + report what is/is not set up.
#   ./provision-console.sh --help
#
# Phone-anchored trust: the Domain ROOT private key is generated on the Console and never
# reaches the host. This script (on the trusted host with cluster access) roots evie's
# Domain at the owner PUBLIC keys the operator reads from the app, then emits a
# transport-ONLY blob (cluster creds; no identity, no Gateway keys). The Console generates
# its own identity, admits itself, and admits each Gateway (by scanning the Gateway's
# admit-gateway QR) afterward. After setup, a menu offers the blob as a scannable QR or paste.
#
# Mirrors the Gateway's start-gateway.sh --setup ergonomics.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

# Every file this script writes carries key material or cluster creds. umask 077 makes
# them 0600/0700 FROM BIRTH, closing the window between create-at-default-umask and the
# explicit chmod 600 (which stay as belt-and-suspenders).
umask 077

NS="evie-bot"
CONTAINER="switchboard"                       # the gateway container (its kubectl reaches evie)
KUBECONFIG_IN="/app/kubeconfig.yaml"
EVIE_DEPLOY="deploy/evie-bot-deployment"
FED_SECRET="evie-federation"
BRIDGE_YAML="../evie-bot/deploy/console-bridge.yaml"
SECRETS_DIR="${HOME}/android-dev/secrets"
BLOB_FILE="${SECRETS_DIR}/console-provisioning.json"      # the artifact the app imports
QR_GIF="${SECRETS_DIR}/console-enrollment-qr.gif"         # optional saved QR image (menu opt 2)
GATEWAY_BRIDGE_YAML="../evie-bot/deploy/gateway-bridge.yaml"
SERVICE="evie-console-bridge"
PORT=20004
FED_DIR_IN="/app/log/federation"                          # the gateway's federation dir (allowlist + keypair)
OWNER_ID_FILE="${SECRETS_DIR}/console-owner-identity.json" # legacy host-minted owner (the phone holds it now)

err() { echo "ERROR: $*" >&2; }
note() { echo ">> $*"; }

# kubectl inside the gateway container (it already holds the evie kubeconfig).
k() { docker exec "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" -n "$NS" "$@"; }
ki() { docker exec -i "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" -n "$NS" "$@"; }

# Extract one top-level field from a JSON object on STDIN (string fields verbatim, others
# re-stringified). bun-only - bun is already required, so this avoids a python dependency -
# and the JSON, which may carry key material, rides stdin, never argv.
jget() { SB_K="$1" bun -e 'const o=JSON.parse(await Bun.stdin.text()); const v=o[process.env.SB_K]; process.stdout.write(v===undefined?"":(typeof v==="string"?v:JSON.stringify(v)))'; }

# Ensure the gateway container is up - k()/ki() exec kubectl through it. If it is down (e.g.
# right after a Gateway purge), start it just for this run so the cluster stays reachable. The
# image already exists, so this is a fast `up`, not a rebuild; the container is left running.
ensure_container() {
	docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" && return 0
	note "gateway container is down - starting it so kubectl can reach the cluster"
	docker compose up -d >/dev/null 2>&1 || { err "could not start the '$CONTAINER' container (docker compose up failed)"; exit 1; }
	local i
	for i in $(seq 1 30); do
		docker exec "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" version >/dev/null 2>&1 && return 0
		sleep 1
	done
	err "the '$CONTAINER' container started but kubectl is not reachable through it"; exit 1
}

# Apply the console-bridge k8s objects + ensure CONSOLE_BRIDGE_TOKEN is set so evie's
# ConsoleBridgeServer starts on 20004. Idempotent: safe to re-run.
cutover() {
	note "cutover: applying console-bridge + gateway-bridge objects (Services + SAs + Roles + tokens)"
	cat "$BRIDGE_YAML" | ki apply -f - >/dev/null || { err "kubectl apply $BRIDGE_YAML failed"; return 1; }
	cat "$GATEWAY_BRIDGE_YAML" | ki apply -f - >/dev/null || { err "kubectl apply $GATEWAY_BRIDGE_YAML failed"; return 1; }

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

# Root the Domain at the CONSOLE's owner public keys (phone-anchored trust), writing
# evie's federation Secret directly. The owner private key is generated on the Console
# and never reaches the host: the operator reads the owner pubkeys from the app (the
# Owner setup screen shows them + a fingerprint). The Console admits itself and every
# Gateway afterward. The crypto is done by scripts/bootstrap-domain.ts (the real
# crypto.ts/admission.ts) so the rooted owner verifies byte-for-byte on the gateway + app.
bootstrap_domain() {
	note "bootstrap: rooting the Domain at the Console owner key"
	local evieFed ownerSign ownerBox out fedJson b64 ownerPub pin
	evieFed=$(k get secret "$FED_SECRET" -o jsonpath='{.data.federation\.json}' 2>/dev/null | base64 -d) ||
		{ err "could not read evie federation Secret (is evie federation up?)"; return 1; }

	# The Console owner pubkeys: from the environment for a scripted run, else prompted.
	# The operator reads both from the app's Owner setup screen and confirms the fingerprint.
	ownerSign="${SB_OWNER_SIGN_PUB:-}"
	ownerBox="${SB_OWNER_BOX_PUB:-}"
	if [ -z "$ownerSign" ] || [ -z "$ownerBox" ]; then
		[ -t 0 ] || { err "owner pubkeys required (set SB_OWNER_SIGN_PUB + SB_OWNER_BOX_PUB, or run interactively)"; return 1; }
		echo "Open the Console app -> Owner setup. Paste its two owner public keys:"
		[ -n "$ownerSign" ] || read -rp "  owner signing key (base64): " ownerSign
		[ -n "$ownerBox" ] || read -rp "  owner box key (base64): " ownerBox
	fi
	[ -n "$ownerSign" ] && [ -n "$ownerBox" ] || { err "owner pubkeys are required"; return 1; }

	# RAW pubkeys ride the ENVIRONMENT, never argv. The helper preserves evie's identity,
	# roots at these owner keys, and keeps the prior allowlist only when re-rooting at the
	# same owner (a Console restoring its backed-up owner key).
	out=$(SB_EVIE_FED="$evieFed" SB_OWNER_SIGN_PUB="$ownerSign" SB_OWNER_BOX_PUB="$ownerBox" \
		bun scripts/bootstrap-domain.ts) || { err "domain rooting (crypto) failed"; return 1; }

	ownerPub=$(printf '%s' "$out" | jget ownerSignPub)
	[ -n "$ownerPub" ] || { err "bootstrap output missing ownerSignPub (internal error)"; return 1; }

	# If the gateway PINS an owner key (FEDERATION_OWNER_SIGN_PUB, untrusted-evie mode) it
	# refuses any allowlist snapshot rooted at a different key - so a mismatched pin silently
	# drops this Domain and nothing could seal. Abort with the exact remediation.
	pin=$(docker exec "$CONTAINER" printenv FEDERATION_OWNER_SIGN_PUB 2>/dev/null)
	if [ -n "$pin" ] && [ "$pin" != "$ownerPub" ]; then
		err "the gateway pins a DIFFERENT Domain owner key than this root:"
		err "  gateway FEDERATION_OWNER_SIGN_PUB = $pin"
		err "  this Domain root                  = $ownerPub"
		err "  Set FEDERATION_OWNER_SIGN_PUB=$ownerPub on the gateway (or unset it), restart it, then re-run --setup."
		return 1
	fi

	# Write the rooted federation Secret (preserves evie's identity + any prior admits).
	fedJson=$(printf '%s' "$out" | jget federationJson)
	[ -n "$fedJson" ] || { err "could not extract federationJson from bootstrap output"; return 1; }
	b64=$(printf '%s' "$fedJson" | base64 -w0)
	printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: Opaque\ndata:\n  federation.json: %s\n' \
		"$FED_SECRET" "$NS" "$b64" | ki apply -f - >/dev/null || { err "writing federation Secret failed"; return 1; }
	note "bootstrap: Domain rooted at Console owner $ownerPub"

	# Restart evie so it reads the rooted state. The Console then submits its own admission
	# and admits this Gateway (by scanning the Gateway's admit-gateway QR) - no host-side admit.
	k rollout restart "$EVIE_DEPLOY" >/dev/null
	k rollout status "$EVIE_DEPLOY" --timeout=120s >/dev/null || { err "evie rollout stalled after bootstrap"; return 1; }
}

# Pull the console-bridge cluster creds into a TRANSPORT-ONLY provisioning blob. The
# Console generates its own owner + member identities and resolves Gateway keys from the
# synced keyring, so the blob carries credentials only - no identity, no Gateway keys.
emit_blob() {
	local saToken caPem appToken apiUrl
	saToken=$(k get secret console-bridge-proxy-token -o jsonpath='{.data.token}' | base64 -d)
	caPem=$(k get secret console-bridge-proxy-token -o jsonpath='{.data.ca\.crt}' | base64 -d)
	appToken=$(k get secret console-bridge-app-token -o jsonpath='{.data.CONSOLE_BRIDGE_TOKEN}' | base64 -d)
	apiUrl=$(docker exec "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" config view --minify \
		-o jsonpath='{.clusters[0].cluster.server}')

	# Also pack the gateway-bridge creds so the Console can seal a bootstrap bundle for a
	# creds-less Gateway it admits. Same SA-token-over-service-proxy shape; the forwarded
	# bridge token is the host BRIDGE_TOKEN (the value evie checks). Empty if not yet set up.
	local swSa swCa swApp swTransport
	swSa=$(k get secret gateway-bridge-proxy-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d)
	swCa=$(k get secret gateway-bridge-proxy-token -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d)
	swApp=$(sed -n 's/^BRIDGE_TOKEN=//p' .env 2>/dev/null | head -1)
	# The 4-field GatewayTransport shape (the gateway fills namespace/service/port defaults
	# when it installs the bundle), matching GatewayTransportSchema.
	swTransport=""
	if [ -n "$swSa" ] && [ -n "$swCa" ]; then
		swTransport=$(SB_API="$apiUrl" SB_CA="$swCa" SB_SA="$swSa" SB_APP="$swApp" \
			bun -e 'process.stdout.write(JSON.stringify({apiUrl:process.env.SB_API,saToken:process.env.SB_SA,caPem:process.env.SB_CA,appToken:process.env.SB_APP||""}))')
	fi

	# The writer VALIDATES against the shared ProvisioningSchema before writing (a field
	# drift fails loudly here, not silently on the device). Secrets ride the ENVIRONMENT,
	# not argv (world-readable in `ps`); caPem's newlines ride env cleanly too.
	SB_API="$apiUrl" SB_CA="$caPem" SB_SA="$saToken" SB_APP="$appToken" SB_SWTRANSPORT="$swTransport" \
	SB_NS="$NS" SB_SVC="$SERVICE" SB_PORT="$PORT" SB_BLOB="$BLOB_FILE" \
		bun scripts/write-provisioning-blob.ts || { err "writing blob failed (schema validation?)"; return 1; }
	chmod 600 "$BLOB_FILE"
	note "blob written: $BLOB_FILE  (console-bridge cluster creds; the Console owns its identity)"
}

# Write the local Gateway's service-proxy transport.json into its federation dir, so the
# gateway reaches evie through the apiserver (off kubectl port-forward) on its next
# restart. The SA token + cluster CA come from the gateway-bridge SA; the forwarded bridge
# token is the host's BRIDGE_TOKEN (the same value evie checks).
write_gateway_transport() {
	local saToken caPem appToken apiUrl
	saToken=$(k get secret gateway-bridge-proxy-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d)
	caPem=$(k get secret gateway-bridge-proxy-token -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d)
	[ -n "$saToken" ] && [ -n "$caPem" ] ||
		{ err "gateway-bridge SA token not populated yet - re-run --setup in a few seconds"; return 1; }
	appToken=$(sed -n 's/^BRIDGE_TOKEN=//p' .env 2>/dev/null | head -1)
	apiUrl=$(docker exec "$CONTAINER" kubectl --kubeconfig="$KUBECONFIG_IN" config view --minify \
		-o jsonpath='{.clusters[0].cluster.server}')
	SB_API="$apiUrl" SB_CA="$caPem" SB_SA="$saToken" SB_APP="$appToken" SB_NS="$NS" \
		bun -e 'process.stdout.write(JSON.stringify({apiUrl:process.env.SB_API,namespace:process.env.SB_NS,saToken:process.env.SB_SA,caPem:process.env.SB_CA,appToken:process.env.SB_APP||"",service:"evie-bridge",port:20001}))' \
		| docker exec -i "$CONTAINER" sh -c 'mkdir -p /app/log/federation && cat > /app/log/federation/transport.json && chmod 600 /app/log/federation/transport.json' \
		|| { err "writing gateway transport.json failed"; return 1; }
	note "gateway transport written: the gateway uses the service-proxy after its next restart"
}

# Health-probe the full service-proxy -> bridge path with the emitted creds. Uses an
# AUTHENTICATED POST /ingest, NOT a GET: the bridge answers GET 200 BEFORE the app-token
# gate, so a GET would pass even with a wrong token (the exact bug that stranded the app
# on 401 after import). POST /ingest exercises the real auth path, is served locally at
# evie (no gateway relay, so it isolates bridge+creds from gateway connectivity), and
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

# The full provision chain: cutover the cluster objects, root the Domain at the app's owner
# key, emit the transport blob, verify the bridge path.
provision() {
	cutover && bootstrap_domain && emit_blob && verify || return 1
	echo
	note "Setup complete. Blob: $BLOB_FILE"
}

# Clean break: wipe the Console federation across all three places it lives, so a re-Provision
# starts from zero. The gateway keypair (identity.json) stays so the Gateway id is stable; only
# the mirrored allowlist goes. Mirrors start-gateway.sh's "Purge configs".
purge() {
	echo "Purge is a CLEAN BREAK - it wipes the Console federation back to nothing:"
	echo "  - evie's Domain root + every admission (the $FED_SECRET Secret); evie restarts unrooted"
	echo "  - this Gateway's mirrored allowlist ($FED_DIR_IN/federation-allowlist.json; keypair kept)"
	echo "  - the host's owner identity + transport blob under $SECRETS_DIR"
	echo "Every Gateway and Console must re-enroll afterward."
	local ok; read -rp "Purge everything? [y/N]: " ok
	[ "$ok" = y ] || { note "purge cancelled"; return 0; }

	k delete secret "$FED_SECRET" --ignore-not-found >/dev/null 2>&1
	k rollout restart "$EVIE_DEPLOY" >/dev/null 2>&1 || true
	note "evie: federation Secret deleted, evie restarting unrooted"

	docker exec "$CONTAINER" rm -f "$FED_DIR_IN/federation-allowlist.json" 2>/dev/null || true
	note "Gateway: mirrored allowlist wiped (keypair kept; restart the gateway to re-sync clean)"

	rm -f "$OWNER_ID_FILE" "$BLOB_FILE" "$QR_GIF"
	note "host: owner identity + blob removed"

	echo
	note "Clean break done. Run Provision (option 1) with the app's owner keys to root fresh."
}

# Top-level dial menu (interactive --setup), mirroring start-gateway.sh's --setup.
menu() {
	while true; do
		echo
		echo "Switchboard - Evie authority setup"
		echo "  1) Provision - Root the Domain at the app owner key and emit the blob"
		echo "  2) Enroll QR - Show the enrollment QR for the current blob"
		echo "  0) Purge     - Erase identity, allowlist, blob, and k8s secret"
		echo "  q) Quit"
		local c; read -rp "> " c
		case "$c" in
			1) provision && qr_menu ;;
			2) [ -f "$BLOB_FILE" ] && qr_menu || err "no blob yet - run Provision (1) first" ;;
			0) purge ;;
			q | Q | "") break ;;
			*) echo "Enter 1, 2, 0, or q." ;;
		esac
	done
}

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
	--setup)
		ensure_container
		# write_gateway_transport is intentionally NOT in the Provision chain: it commits the
		# local Gateway to the service-proxy WS, and if WS-over-proxy does not work on this
		# cluster the Gateway could not connect (it only falls back to port-forward when
		# transport.json is absent). Validate the service-proxy path first, then --gateway-transport.
		if [ -t 0 ]; then
			menu
		else
			provision || exit 1
			note "Import $BLOB_FILE into the Console app (paste, or scan its QR via --qr). No enroll step."
		fi
		;;
	--qr)
		[ -f "$BLOB_FILE" ] || { err "no blob at $BLOB_FILE - run --setup first"; exit 1; }
		qr_menu
		;;
	--gateway-transport)
		# Opt-in: move the local Gateway off kubectl port-forward onto the service-proxy WS.
		# Run AFTER confirming WS-over-proxy works on this cluster; restart the gateway to pick
		# up the transport.json. Reversible: delete /app/log/federation/transport.json to revert.
		ensure_container; write_gateway_transport ;;
	--verify) ensure_container; verify ;;
	--help | "" ) usage ;;
	*) err "unknown option: $1"; usage; exit 1 ;;
esac
