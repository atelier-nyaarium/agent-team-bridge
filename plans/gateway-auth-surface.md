# Gateway HTTP surface: unauthenticated routes on a LAN-published port

Context: a security review during the enroll trial (2026-06-25), refined by an
8-agent adversarial audit (16 verified findings). Finding stands: the gateway's
entire HTTP+WS API is published to the LAN with no app-layer auth. The audit
corrected the fix (Option 1 is not a zero-code bind), added two missed routes
(`/connector/{project}/ws` SSRF, and the new `/admit-payload`), and reclassified
`/pending`.

## Two distinct surfaces

### A. Gateway, port 20000 - LAN-reachable, UNAUTHENTICATED

- `docker-compose.yml:6` maps `"20000:20000"` (host bind `0.0.0.0`), so any LAN
  device reaches it (arming address `192.168.1.238:20000`). The container's
  **internal** bind is also `0.0.0.0` and must stay that way - bridge siblings
  reach it via the `switchboard:20000` DNS name (`BRIDGE_ROUTER_URL`), and the host
  daemon + `start-gateway.sh` health check reach it via `localhost:20000`. The LAN
  exposure is the **publish**, not the bind. Behind NAT, so not internet-reachable
  unless port-forwarded.
- `src/gateway/routes.ts` has **no** token/`Authorization`/4xx-auth check on any
  handler (audit confirmed per-handler, not just by grep). The HTTP routes trust
  the network boundary, but the boundary is the whole LAN.

  | Route | Risk |
  |---|---|
  | `WS /connector/{project}/ws` | **SSRF / arbitrary egress.** Gateway-unauthenticated (`index.ts:685-707`, `Authorization` captured but never checked); `connectorProxy.ts:9` opens an outbound WS to `ws://${project}:20002/ws` where `project` is an **unvalidated attacker-chosen hostname**. Upstream (`listener.ts:230`) only enforces a token in HTTPS+token mode; default is unauth. |
  | `POST /human/notify` | push arbitrary notices to the owner's phone consoles (spam/phishing) **when the console bridge / mailboxStore is enabled**; sender `from` is attacker-spoofable |
  | `POST /send` | inject a message into any agent conversation - **prompt-injection** into devcontainer agents; **self-wakes offline devcontainers** (resource amplification); `from` is attacker-spoofable |
  | `POST /plugin-action` | drive a device-side plugin action (e.g. the Designer's delete-card) in any conversation; same shape as `/human/notify` - self-scoped to the caller's own `from`, but `from` itself is attacker-spoofable the same way |
  | `GET /pending` | **disclosure/recon** (was wrongly "benign"): leaks every live `session_id`, which then arms `/respond` + `/poll` against existing conversations |
  | `POST /respond`, `/poll` | drive the request/response mailbox; require a known `session_id` (404 otherwise) - a real guard, but **defeated by `/pending`** above |
  | `POST /ingest` | unbounded append to the gateway log (`routes.ts:387-399`) - disk-fill DoS. **No in-repo client POSTs this gateway route** (distinct from evie's `/ingest`). |
  | `GET /teams`, `/discover` | enumerate local teams + remote gateways (recon) |
  | `WS /bridge` | register as **any non-host team name (used or unused)** - joining a **live** team's name subscribes the attacker to that team's `channel_push` fan-out (`routes.ts:681-683`), i.e. passive message interception; only the reserved `host` slot is `HOST_WS_TOKEN`-gated |
  | `GET /admit-payload` (added by enroll-fixes P0) | arming-only public-data disclosure: the enrollment **nonce** + `signPub`/`boxPub` + LAN target. Consumer is loopback-only (`setup.ts`); the phone never GETs it. A leaked nonce alone cannot enroll (bundle must be sealed + owner-signed). |
  | `POST /enroll` | crypto-gated (sealed bundle + one-time nonce), live only during the ~10 min arming window - spammable but not forgeable |
  | `GET /health` | benign |

### B. evie console-bridge, port 20004 - internet-reachable, GATED

- The Android client reaches it through the K8s API service-proxy at the **public**
  LKE endpoint, sending `Authorization: Bearer <saToken>` (API-server-enforced) +
  `X-Console-Bridge-Token` (evie-enforced). Both are admin-issued in the blob.
- Routes: `/relay` (catch-all op intake) and `/ingest`.
- **Scope honestly (audit):** this repo only shows the *client* using the service-
  proxy. Whether that is the **only** public path (no separate Ingress/LoadBalancer)
  is an evie/deploy fact, not knowable here - see follow-ups. A leaked-blob holder
  has the shared per-network tokens and can hit `/ingest` (no per-op seal).

## Answer to the question

- **Internet / no relationship:** No - evie's bridge is behind the admin-issued SA
  token; the public endpoint 401s anyone without it (subject to the evie-side
  caveat above).
- **LAN / no relationship:** **Yes.** Port 20000 is LAN-published with no app-layer
  auth, so any LAN host can spam `/human/notify`, `/send`, `/ingest`, drive
  `/connector/.../ws` as an SSRF primitive, and recon via `/pending`+`/teams` - no
  invite, no creds.

## Decision: origin-aware gate, token only on the host-published path (owner-confirmed)

Keep the `0.0.0.0` publish. Drop unsolicited (no-cred) mutate/flood traffic with a
**single cheap check at the top of the `Bun.serve` `fetch()` handler** - before
`router()` calls `await req.json()` (`index.ts:637`), before `routes.ingest`'s
`appendFileSync` (`routes.ts:387`), and before the `/connector` + `/bridge`
upgrades. Unsolicited = one comparison -> `401`: no body parse, no file append, no
outbound WS. (Panel: security 5/5 unanimous.)

**Empirically grounded (this is the hinge).** This host runs
`EnableUserlandProxy: true` (docker default); the `switchboard` bridge is
`172.18.0.0/16`, gateway `172.18.0.1`. Therefore:
- Internal devcontainer traffic arrives over the bridge with its **real bridge IP
  `172.18.0.N` (N != 1)** - a LAN host **cannot forge** it (the LAN can only reach
  the published port and is SNAT'd to `.1`).
- LAN traffic AND the host daemon / health-check / `setup.ts` (the host-published
  path) all arrive SNAT'd as **`172.18.0.1`** - indistinguishable by IP. A naive IP
  allowlist is therefore **falsely-safe** (trusting `.1` to admit the daemon also
  admits the LAN). The earlier `requestIP` warning holds.

**The gate** (`server.requestIP(req)` + one token):
- Source is a bridge IP other than `.1` (`172.18.0.N`) -> **trusted** (devcontainer).
  No token. **Zero per-container wiring** - this is what clears the convenience bar.
- Source is `172.18.0.1` (host daemon / LAN / loopback-via-proxy) -> **require
  `GATEWAY_TOKEN`** (`x-gateway-token` header, and at the `/bridge` upgrade). The host
  daemon shares the gateway's `.env`, so it carries the token for free; an unsolicited
  LAN request has none -> `401`.
- Exempt regardless of origin: `GET /health` (readiness curl) and `POST /enroll`
  (credential-less arming intake, guarded by its own one-time nonce). Under
  enroll-fixes P0/F2, `GET /admit-payload` is arming-only public data on the
  host-published path - either exempt it like `/enroll`, or have `setup.ts` send the
  token (it already reads `.env`).
- Gated set: mutate/flood (`/send`, `/respond`, `/poll`, `/human/notify`, `/ingest`,
  `/plugin-action`), non-`host` `/bridge` registration, and `/connector/{project}/ws`. Also gate the
  recon reads `/teams`/`/discover`/`/pending` under the same `.1`-needs-token rule
  (cheap, and it closes the `/pending` session_id leak).

**Provisioning (the convenience win).** `start-gateway.sh` auto-mints `GATEWAY_TOKEN`
into `.env` beside `HOST_WS_TOKEN`
(`grep -qE '^GATEWAY_TOKEN=' .env || echo "GATEWAY_TOKEN=$(openssl rand -hex 32)" >> .env`),
`docker-compose.yml` passes `GATEWAY_TOKEN=${GATEWAY_TOKEN:-}`, and the host daemon
reads it from the same `.env`. **Devcontainers need nothing** (trusted by bridge IP) -
no secret sprawl, no rotation fan-out, no `install.sh` change.

**Complementary cleanups:** delete the gateway's port-20000 `/ingest` route (no
in-repo client) rather than gate it; add a body-size cap on `/human/notify`
(belt-and-suspenders flood guard); when adding the token, bind/verify `from` to the
authenticated origin instead of trusting the body field (closes sender spoofing).

**Verify at build time (the one load-bearing assumption):** confirm on the live
gateway that `server.requestIP()` returns the devcontainer's `172.18.0.N` for
internal bridge traffic and `172.18.0.1` for the host-published path under
userland-proxy - a devcontainer POST + a host `curl` + a LAN `curl`. Standard docker
behavior, but it is the hinge of the gate, so test it before relying on it.

**Rejected alternatives:** loopback-scoping the publish (`127.0.0.1:20000:20000`)
conflicts with `/enroll` needing the LAN during arming -> a two-state publish touching
compose + the enroll scripts (owner keeps `0.0.0.0`); a pure shared token forces
per-devcontainer wiring (secret sprawl + rotation - the convenience violation); a pure
IP allowlist is falsely-safe under userland-proxy (above).

## Cross-reference: enroll-fixes P0 (shipped)

The enroll-fixes work (P0/F2) added `GET /admit-payload` to this router; it is
handled above (arming-only, host-published path -> exempt-or-token). That work's own
plan deferred the hardening decision to this doc, and it is now made (origin-aware
gate, keep `0.0.0.0`).

## Follow-ups to verify (not yet confirmed)

- evie-side: confirm `/relay` + `/ingest` are reachable **only** via the API
  service-proxy (no separate public Ingress / LoadBalancer), and whether a leaked
  blob's SA/app token can be rotated.
- The core "no handler checks auth" claim is **audit-confirmed** for `routes.ts`;
  the connector-proxy upgrade is confirmed unauthenticated at the gateway layer.
- `docker port switchboard` once it is back up, to confirm the `0.0.0.0:20000`
  host binding empirically (container was down/purged at review time).

## Cross-reference: session-id-teardown Phase G (2026-07-09)

`plans/session-id-teardown.md` Phase G added `displayLabel`-driven session creation
to `POST /send`: a not-yet-existing composite target now MINTS a fresh, persistent
`SessionStore` record (and fires a real host-daemon wake dispatch, container
bring-up included) rather than just re-waking an existing one. This makes the
`POST /send` row's already-documented "self-wakes offline devcontainers (resource
amplification)" risk above strictly worse - an unauthenticated caller can now also
create an unbounded number of new phantom records and drive real container
bring-up cost per distinct target, not merely re-wake existing ones. No rate limit
or per-caller cap exists on minting today (see `plans/session-id-teardown.md`'s own
Painpoints/red-team notes for Phase G). Whoever implements the origin-aware gate
decided above should confirm it also covers this creation path, not just re-wake.

## Cross-reference: versioned-state-planes red-team audit (2026-07-18)

Phase 2's `phase2-read-anchors` audited-implementation cycle ran a 9-dimension red-team pass
(adversarial-verified) covering `src/gateway/websocket.ts` and `src/gateway/routes.ts` as part of
auditing Phase 1's presence work. Two findings deepen the `WS /bridge` and `/pending`+`/respond`
rows above - not new gaps, further evidence toward the gate already decided but never built:

- **`WS /bridge` register goes past the documented passive interception.** The row above says
  joining a live team's name subscribes an attacker to its `channel_push` fan-out (passive). The
  audit found `confirmedLeadTeams` (websocket.ts) is keyed by the team-name STRING alone, with no
  binding to which socket actually answered the real handshake - so once any team has EVER
  completed one real handshake (the normal case for every actively-used team), a brand-new
  connection can register under that name claiming `isMainOrLead:true` and be instantly
  `handshakeConfirmed` with zero challenge-response. Because `resolveLiveIncarnation` picks the
  first confirmed socket in Map-insertion order, an attacker who registers first permanently
  outranks the legitimate agent's own later reconnect - active impersonation (every
  `crosstalk_send` to that team silently routes to the attacker), not just passive listening.
  Unfixed - the real fix (binding confirmed-lead status to something more than a bare string,
  without losing the fast-path's whole point of skipping re-confirmation for a KNOWN-good
  reconnect) is a trust-model change, not a quick patch, and belongs in whatever implements the
  origin-aware gate above rather than as an isolated patch.
- **Channel job ids are deterministic and reused forever, which is worse than the `/pending`-leak
  framing above.** The `/respond` guard ("requires a known session_id") assumes the id is a
  leaked-but-otherwise-opaque secret. It is not: `storeKey({kind:"conv", conversationId, address})`
  is a pure, computable function of two non-secret inputs (a conversationId, which "rides verbatim
  in every session_id a caller has seen" per this doc's own `/pending` finding and the handshake
  code's own comments; and a target address, public via `/teams`/`/discover`). Anyone who has ever
  exchanged one message with a sender can compute every future job id for that sender without
  `/pending` ever leaking anything, and `PendingJobStore.deliver()` allows unlimited re-delivery
  on a persistent (channel) entry with no ownership check - so a forged reply can be POSTed at any
  future time, indefinitely, attributed to any target the attacker names. Unfixed - the gate above
  (gating `/respond`/`/poll` under `.1`-needs-token) closes the LAN-attacker case in this doc's own
  stated scope, but does not address a same-Domain participant who legitimately holds the token
  computing another participant's ids; worth confirming whether that residual is in scope for
  whoever implements the gate, or is accepted under the "trusted collaborators" framing the
  cross-Gateway trust model already uses elsewhere.

Two smaller, already-fixed findings from the same pass (not part of the accepted gap above, fixed
directly since they were simple, contained, and closed no legitimate use case): a conversationId
collision on `WS /bridge` register no longer evicts/steals a DIFFERENT team's live socket (it only
ever legitimately meant the same process reconnecting under its own unchanging team); and the
plane-registry tripwire no longer crashes the whole gateway process if a single plane's own
snapshot/identity computation throws.

## Cross-reference: plugin-actions (2026-07-11)

`plans/plugin-actions.md` (deleted, shipped) added `POST /plugin-action`, a generic agent-initiated
mailbox entry `{pluginId, actionType, payload}` that drives a device-side plugin (e.g. the Designer's
delete-card) with no dedicated wire type per action. It self-scopes to the caller's own `from` -
there is no separate target field, so a caller has no MORE room to name another conversation than
`/send` already has - but that plan's own text is explicit this is NOT a new authentication boundary:
`from` is exactly as attacker-spoofable here as it is on `/send`/`/human/notify` above. Whoever
implements the origin-aware gate should include `/plugin-action` in the gated set (already added to
the table and bullet above).
