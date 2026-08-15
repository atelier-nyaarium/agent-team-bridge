# Questionaire

Goal: replace the LKE-hosted evie relay with a self-hosted federation Router in Docker at home.

Vision from the owner (2026-08-14):
- Self-hosted federation server process, in Docker for security.
- One new sh script to kick off / restart the federation docker server.
- App settings gain a Domain/IP + port field (port defaults to the current one); also shown
  on the main screen when no federation is set up.
- Migration path: replicate settings + secrets into the .env the federation docker reads and
  start it; point Gateway/Daemon at it and restart; app update points at home internal IP.
  (Resolved during refinement: only the GATEWAY's federation transport repoints; the host
  daemon's connection to the gateway on 20000 is untouched.)

## Question 1 - Language and code provenance?

Q: Bun or Rust, and where does the Router code come from?
A: Bun, fourth entry point in switchboard (`main-federation.ts`), porting evie's bridge
coordinators over; file-backed CAS store replaces the k8s Secret. Docker from `oven/bun:1`,
new `start-federation.sh` beside the existing scripts.

> Recommendation A chosen: one repo already owns every wire shape and the Kotlin codegen;
> evie's coordinators come with their bun tests, which port with the code; the synced
> federation leaves exist only because evie is a separate repo, and the Router living in
> switchboard dissolves that boundary for the Router's half. Rust ruled out: full rewrite of
> crypto with byte-exact signing encodings + all schemas + coordinators, no perf need.

## Question 2 - Evie-bot's remaining federation role?

Q: What happens to cloud evie / Discord DM forwarding once the Router moves home?
A: Retire evie from federation entirely. DM forwarding dies; the console is the sole owner
surface. Device approval moves to the home Router. Evie-bot keeps its Discord/server-manager
life untouched. The LKE cluster staying up until deliberately torn down IS the rollback path
(repoint back), so no dual-stack transition window.

## Question 3 - Remote access story for the phone?

Q: Away from home, how does the console reach the Router?
A: LAN-only now. Port forwarding is the owner's own later path to outside access, so the
endpoint setting must accept either an IP or a domain name (with port).

> "I can port forward to access from outside. so it should work with either IP or Domain name"

## Question 4 - TLS and door-level auth for the direct connection?

Q: What secures the socket itself, given payloads are already E2E sealed?
A: Router-minted self-signed cert on first boot; clients pin the leaf fingerprint, delivered
out-of-band in the provisioning blob/QR (the `EnrollPinning.kt` / 20003 pattern). Console
keeps an app-token header; the gateway's new transport.json carries a bearer. Pinning ignores
the cert subject, which is what makes IP and domain interchangeable.

## Question 5 - Port layout?

Q: One port for everything, or mirror today's 20001/20004/20005 split?
A: Single TLS port serving gateway WS + console relay + device-approval routes. The Router
takes 20001 (the number the evie bridge held, keeping federation next to the gateway):
- 20000: Gateway (HTTP + WS, loopback)
- 20001: Federation Router (single TLS port, docker)
- 20002: MCP connector - untouched
- 20003: Enrollment TLS - unchanged

> "keep federation next to gateway"

The app's port field defaults to 20001.

## Question 6 - Cleanup strategy?

Q: Clean break (remove k8s transport code paths at the end) or keep legacy support?
A: Clean break by last phase. Switchboard deletes the service-proxy transport and kubectl
setup plumbing; evie-bot deletes its gateway/console/device-approval bridges and the synced
federation leaves; the console deletes the k8s proxy transport once the update is taken.
Deletion sequenced LAST, after living on the home Router; the untouched LKE path is the
rollback until then.

> "A the only tenant on 1 machine."

# Plan

Refined over two audit laps (lap 1: coordinator port, gateway client, console client,
migration/cutover, schemas/CI/build; lap 2: fidelity re-check, runtime/operations,
phase sequencing). Corrections are folded in below.

Standing defaults (raise objections any time):
- The console poll/op protocol, every sealed relay frame, and the crypto envelopes stay
  byte-identical. What DOES gain fields (optional-first) is named in Phase 3: the
  provisioning blob, the sealed bootstrap bundle, the approval-delivered ConsoleTransport,
  and invite blobs.
- MCP plugin and host daemon stay pointed at the Gateway on 20000. Only the GATEWAY's
  federation transport repoints to the Router. Nothing dials 20001 except the gateway's
  federation WS and the console.
- TWO Router URLs exist by construction and the schemas must distinguish them: the
  gateway-in-docker dials the Router by docker-network DNS name; the phone dials the host
  LAN IP/domain. Same fingerprint, different endpoint. The internal DNS name never ships to
  the phone.
- Two fingerprints exist and are never conflated: the ephemeral 20003 enroll cert
  (`enrollQr.ts` `lan.certFp`, in-memory, day-lived) and the persistent Router 20001 cert.
- Rollback discipline: LKE rollback is only clean BEFORE federation mutations (admissions,
  revocations, tenant ops) happen on the home Router. Never run both as writable authorities
  for the same Domain. Gateway-owned state (boards, mailboxes, jobs) survives either way; it
  never lived on the Router.
- Backup reality: `federation.json` + Router cert/key + tokens are the un-reconstructible
  set. The phone's owner root can NOT re-root a lost Router file (first_root needs a pending
  Domain + invite nonce that re-provisioning of a rooted Domain does not mint). Phase 2 ships
  a backup step; restoring an old snapshot is a security event (it can resurrect revoked
  members), noted in the runbook.

## Phase 1 - Router core in switchboard

`main-federation.ts` fourth entry point: one Bun TLS listener on 20001. Uses the wire
schemas that ALREADY exist in `src/shared` (evie-protocol, console ops, federation-lifecycle,
proofs) - no dependency on Phase 3, which only ADDS optional transport fields.

Route surface (the console surface is the whole op family, not just `/relay`):
- Gateway WS upgrade: `gateway_register` + relay frames. Must answer WS pings and set
  `maxPayloadLength` >= the client's `EVIE_WS_MAX_PAYLOAD_BYTES` (64 MiB) or the unchanged
  `EvieClient` reconnect-loops / rejects sealed attachment frames.
- Console POST surface, same dispatch order as `ConsoleBridgeServer`: enrollOp, firstRoot,
  enrollHandshake, consoleApproval arm/poll/approve/cancel, roster, trustHandshake,
  trustPending, transport, then relay fallthrough. Plus `/health` (the app's required
  preflight) and an authenticated `/ingest` for debug-build logs (or explicitly drop remote
  debug ingest - decide at implementation).
- Public device-approval join/fetch: token-exempt, nonce-gated, preserving
  `DeviceApprovalPublicServer` semantics on the shared port: 8 KiB handler body cap, per-window
  + global rate limits (429), 413 on oversize, opaque-200 on valid-shaped nonce misses, 404 on
  malformed/unknown routes.
- Liveness/readiness: the Router answers ready only after state load; the gateway's `/health`
  gains a router-connected field so a dead federation link is visible.

Coordinators ported WITH their behavioral contracts (the .bun.test.ts suites are the spec):
- `gateway_register` is an authorization gate: protocol floor, pending-tenant refusal,
  owner-signed admission + possession proof (`registrationVerification`), proof-nonce replay
  ledger, admin-domain identity-less bootstrap carve-out.
- Relay semantics: 70s relay + handshake timeouts, handshake commit rate limit, held-relay
  maps failed on disconnect, replies accepted only from the exact destination connection,
  same-domain-first routing, cross-domain only through owner-attested link edges.
- Console relay: 55s hold, duplicate-pending-opId rejection, 64 MiB body ceiling, shutdown
  resolves all held requests.
- Interactive coordinators keep their in-memory windows (TTLs, attempt caps, first-X-wins,
  constant-time nonce checks). Router restart loses them by design; flows re-arm.
- Lifecycle wiring mirrors `BridgeService`: store+identity first, gateway bridge, TenantAdmin,
  console callbacks, relay settler, public approval last; coordinator refresh/broadcast/evict
  on first-root, rename, admission, removal, deletion.

Store - replace the `KubeSecretStore` facade, not just `SecretIO`:
- `FileSecretStore` with the facade the coordinators actually consume: `init`, `domainStore`,
  `loadDomain`, `listDomains`, `saveDomain`, `mutateDomain`, `mutateSecret`, `flushDomain`,
  `adminDomainId`, `loadSeenAdminNonces`, persisted identity. (`readGatewayBridgeTransport`
  is k8s-specific and dies.) Whole-file atomic mutations (mutex + atomic rename),
  persist-before-publish, bounded CAS re-run semantics kept, `isAdminDomain` fail-closed on
  ambiguity.
- The file holds the FULL v2 secret: evie identity keypair, every domain slice (owner roots,
  admissions, revocations, link edges + tombstones, display names, pendingTenant, admin
  marker), and the `seenAdminNonces` replay ledger. "Roots and admissions" alone is NOT
  enough.
- Single-writer rule: nothing else may write the file while the Router runs (the migration
  import runs only with the Router stopped).

TLS + auth:
- Cert lifecycle follows the `identity.ts` pattern: mint ONLY when the file is absent; a
  present-but-corrupt cert fails closed rather than re-minting. Long validity, NEVER
  auto-rotated - deliberate rotation is a re-provision of every client, documented as such.
  Fingerprint printed at boot and embedded into provisioning payloads.
- Console app token (`X-Console-Bridge-Token` preserved verbatim) + gateway WS bearer
  REQUIRED (the old bridge made it optional because the k8s proxy was the gate; that gate is
  gone).

Tests: convert evie's `bun:test` suites to vitest as they port (they are not runnable under
`vitest run` as-is). Add coverage for the public/authed boundary on the shared port (none
exists today for `DeviceApprovalPublicServer`).

### Bug Classes

**Mechanism:** the node:https + ws listener, which replaced `Bun.serve` so the behavioral
suites could execute under vitest.

**Defect class:** async work launched from a handler nobody awaits. `Bun.serve` returns a
Response the runtime owns; the node conversion launches `handleHttp` and lets it float, so
every rejection inside it becomes an unhandled rejection with no owner. Patched three times
in three rounds:
1. `readBody` rejected on a client abort. One unauthenticated packet (Content-Length larger
   than the body, then RST) killed the process. Reproduced live.
2. `/ingest`'s `appendFileSync` threw on an IO failure into the identical path.
3. The bind's one-shot `once("error")` left post-listen server errors uncaught.

The Router was also the only entry point missing `installRejectionGuard`, which is what let
these reach the process rather than a log line.

Patched minimally and left as-is for now. The real repair is structural and belongs to
`architecture-fan-out`: one guarded launch seam that every request enters through, so a new
handler cannot reintroduce this by being written the obvious way. Do not add a fourth
one-off catch; fix the seam.

## Phase 2 - Docker + scripts

- Reuse the existing gateway `Dockerfile` (it copies all of `src/`); compose command override
  runs `bun run src/main-federation.ts`. No `scripts/build.ts` change - the Router runs from
  source like the gateway; it is NOT part of the plugin bundle.
- Separate compose project. Networking is explicit: a NEW narrow external docker network
  shared by exactly gateway + Router (NOT the existing `switchboard` network, which
  devcontainers join via install.sh). Router gets a stable alias; the gateway's transport url
  uses it. Ownership of the shared network is declared external in both compose files so
  neither project's down tears it from under the other; `down.sh` documented as the
  all-components stop and updated for the network.
- Host publish of 20001 binds an EXPLICIT address (a bare `20001:20001` binds every
  interface); LAN reachability is a deliberate choice, not a default.
- Own data volume (cert + key + `federation.json` + tokens), auto-provisioned .env on first
  run. `start-federation.sh` never touches the gateway; `start-gateway.sh` never touches the
  Router (separate-triggers rule).
- Backup step: `backup-federation.sh` (or a setup.ts entry) tars the data volume; runbook
  note on restore ordering (stop Router, restore, verify fingerprint, start, verify gateway
  registration) and on the revocation-resurrection risk of old snapshots.
- `scripts/federation-smoketest.ts` (Bun-based; curl cannot mint sealed frames): /health,
  authed vs unauthed, gateway register + relay round trip, console register/send/poll +
  idempotent replay, public approval join/fetch + size/rate limits, fingerprint + token
  rejection cases. Introduced here, extended in Phase 5.
- Ops one-liners recorded in the runbook: host clock (NTP) matters for signed proofs and
  invite expiry; log rotation for the container; pin the image/source version at start time.
- PowerShell variants kept in parity.

## Phase 3 - Wire schemas + codegen

All additive fields OPTIONAL first, per the deploy rule; gateway/Router deploy before the
version-bump push; console updates last. Any touched synced leaf is re-synced to evie-bot
until Phase 7 (CI enforces the mirrors).

- `ProvisioningSchema` (codegen root): a legacy/direct DISCRIMINATED UNION, not a bolted-on
  optional block - the k8s fields are required today, so an optional block cannot represent a
  direct-only blob. Legacy branch unchanged; direct branch carries `url`, `certFingerprint`,
  `token`. An old record's `port: 20004` (proxy meaning) is never reinterpreted.
- `GatewayTransportSchema` (codegen root, nested in the sealed `GatewayBootstrapBundle`):
  legacy/direct union or versioned envelope. The PHONE builds this shape in
  `GatewayEnrollment.kt`, so the Kotlin side changes in the same push. The direct branch must
  carry the docker-network url for a gateway-in-docker AND/OR the LAN url - the installer
  decides which lands in transport.json.
- `TransportRequest/TransportResult` (federation-proofs): the transport an admitted owner
  pulls must be able to answer the DIRECT shape (Router url + bearer + fingerprint).
- Device-approval sealed `ConsoleTransport`: HAND-WRITTEN Kotlin (not codegen) - carries the
  direct fields, or a newly approved phone regresses to the k8s shape. The approval QR
  (`reach`) additionally carries the Router fingerprint - REQUIRED, because the fresh-device
  client is system-trust with no pin today, which cannot reach a self-signed Router.
- `DomainAdminOps` hosted-tenant invite blobs: same direct fields. (These two producers
  belong to THIS phase's coherent change-set, not Phase 5.)
- The `authorize-console`/enroll QR payloads are hand-parsed JSON on Android (not codegen):
  update the `JSONObject` parsing + QR tests in the same change.
- Fixtures: golden rows for legacy provisioning, direct provisioning, and absent-optional
  forms in `tests/fixtures/` (both runtimes iterate the manifest). Signing vectors only if
  canonical signed bytes change (transport-request vectors are the ones to watch).
- Kotlin codegen rerun + committed in the same push; run the LOCAL Kotlin gate
  (`testDebugUnitTest` + release compile) before merge - CI does not compile Kotlin.

## Phase 4 - Gateway direct transport (parallelizable with Phase 3)

- `transport.json` dual reader: legacy service-proxy shape AND v2
  `{url, bearer, certFingerprint}`. v2 is a local gateway file - keep it a gateway-side
  schema with unit tests (legacy, v2, malformed, stale-env cases); do not conflate it with
  the codegen'd `GatewayTransportSchema` (the sealed-bundle wire shape). Only end-to-end
  bootstrap testing depends on Phase 3.
- `loadEvieTransport`'s env-var branch (`EVIE_API_URL` et al) takes precedence over the file
  today - the direct path must not be shadowed by stale env; retire or re-order that branch
  deliberately.
- `evieWsConnection` direct branch: `wss://<alias-or-host>:20001/`, bearer header, and a
  fail-closed LEAF-FINGERPRINT verifier (not a CA field; hostname verification is irrelevant
  under a pin).
- Same `EvieClient` above the socket: action names, frame types, protocol version, register
  reply shape, 20s heartbeat, 64 MiB cap all unchanged.
- `setup-gateway.ts` success check tightened: validate the file parses as legacy-or-v2, not
  "file exists". Start script verifies REGISTRATION on the Router, not just a listening port.

## Phase 5 - Console direct transport + settings

Goal: pre-stage a backward-compatible APK while the phone still runs against LKE, so Phase 6
is a configuration change, not a first-of-its-kind build.

- Direct mode in `ConsoleRelayTransport`: direct base URL, leaf-fingerprint pinned client,
  app-token header preserved verbatim, NO SA token. `/health` preflight against the Router.
  The transport must construct without `caPem` (today it eagerly builds the CA-pinned
  client). The direct client gets its own timeout profile: the current 40s hold / 58s read /
  60s `PROXY_CEILING_MS` chain and the 504-as-empty poll branch are k8s-proxy artifacts;
  define direct long-poll semantics explicitly. Under a leaf pin, hostname verification is
  redundant; relax it for the direct client only (`EnrollPinning`'s client keeps the OkHttp
  default + short timeouts and is NOT reusable as-is).
- Fresh-device approval: the public join/fetch client gains fingerprint pinning fed from the
  QR (Phase 3's field). End-to-end test on the emulator or a second device.
- `postEvieDirect` family routes to the Router direct surface; `DebugLog` ingest follows (or
  is disabled outside k8s mode).
- On-device migration contract:
  - A settings edit of host/port NEVER calls `provision()` (which resets admission/enroll
    latches); it updates transport config only, invalidates the cached `ConsoleClient`, and
    reconnects.
  - New endpoint/fingerprint/token fields live inside the provisioning blob by default
    (KEY_BLOB is already in the provisioning partition, so `PROVISIONING_KEYS` changes only
    if separate keys are chosen - then update `ClearProvisioningPartitionTest` too).
  - Legacy k8s records keep parsing until Phase 7 (rollback window).
- Settings UI: Domain/IP + port field (default 20001) in Settings; entry point on the
  pre-provision screen AND the no-gateway empty state (`SessionsEmptyState`) - "main screen"
  is two different surfaces; cover both.
- `ConnError` remediation text gains direct-mode failures (endpoint, token, fingerprint)
  beside the k8s ones; the "cert changed" terminal error stays terminal (a stale pin is a
  re-provision, not a retry).
- Emulator build: sandbox fixtures for the endpoint field, empty-state entry, and bad
  endpoint/fingerprint/token states.
- Release: this phase ships via the normal `bun run build patch` ritual (console release);
  local Kotlin gate before merge.

## Phase 6 - Migration tooling + cutover

- Export script (`setup.ts` menu entry): with the Router STOPPED, pull the live
  `evie-federation` Secret verbatim (identity included) + `CONSOLE_BRIDGE_TOKEN`, write
  `federation.json` + .env. Consistency check: re-read the Secret's `resourceVersion` after
  export and abort on movement. Evie identity is IMPORTED, never fresh-minted (it is the
  enrollment/SAS identity; owner roots stay the authority either way, but continuity and
  rollback coherence want the same keypair).
- Cutover order: backup -> start Router -> smoke test -> repoint gateway transport.json +
  restart gateway (daemon untouched) -> verify gateway registered on the Router -> app
  settings point at home IP -> verify register/send/poll/board/peek/wake/device-approval.
- From the first federation MUTATION on the home Router, LKE is no longer a clean rollback
  (stale allowlist can resurrect revoked members). Before that point, rollback = repoint
  back. The k8s console-bridge stays reachable until Phase 7 for exactly that window.
- Purge story: `setup-purge` currently mutates the CLUSTER; mark it rollback-only until the
  Router-side purge (drop one gateway's admission / one Domain slice from `federation.json`)
  replaces it in Phase 7.
- No plugin bump; this phase is operations.

## Phase 7 - Clean break (two stages)

Stage 7a - post-cutover cleanup (after living on the Router):
- Switchboard: delete the service-proxy transport branch + the six `EVIE_*` transport env
  vars, kubectl plumbing in `setup-provision.ts` / `setup-purge.ts` / `bootstrap-domain.ts` /
  `scripts/lib/host.ts`, the `kubectl` install in the Dockerfile, k8s rows in
  `setup-constants.ts`. Router-side purge lands here. README + CLAUDE.md (port table, deploy
  sections, env tables, restart ritual) rewritten; stale "service-proxy"/"evie-bot" log lines
  updated.
- evie-bot: delete the gateway/console/device-approval bridges and the ELEVEN synced copies
  (7 federation leaves + the `federation-lifecycle` barrel + `evie-protocol.ts`, `crypto.ts`,
  `admission.ts`), their rows in evie's `_lint.yml` and `_test.yml`, and the bridge k8s
  objects (Services, SAs, Roles, token Secrets). `notice.ts` stays - its twin is nyaaskills.
  `BridgeService` keeps only the server-manager bridge.
- Switchboard CI: `check-sync-hash` list trimmed to match; sync-leaf table in CLAUDE.md
  rewritten.

Stage 7b - final retirement (only after the owner has CONFIRMED taking the new app update):
- Console: delete the k8s proxy transport, `PROXY_CEILING_MS`, and legacy provisioning
  parsing (another console release via the build ritual).
- Drop the legacy halves of the Phase 3 schema unions.
- Retire the LKE bridge objects; the cluster keeps plain evie-bot hosting only.
