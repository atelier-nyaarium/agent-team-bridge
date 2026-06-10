# Android Channel App

Native Android app as a second human-channel surface beside Discord. Talks to all devcontainers concurrently (not Discord's single-holder line). Self-hosted, owns its own chat history.

## Questionaire

### Vision so far (from initial scoping)

- **Native Android only.** Kotlin + Jetpack Compose. No React / no cross-platform layers. (Compose = Google's native Kotlin UI toolkit, not a web layer.)
- **Stands beside Discord, not replacing it.** Discord keeps working via evie. Do not plan Discord removal yet.
- **Multi-devcontainer, not single-line.** The app must hold live concurrent threads with every devcontainer team at once. This is why it uses the *crosstalk* surface, not the Discord *human-channel* (holder pin) surface.
- **App = crosstalk bridge peer.** Architecturally it is a native re-implementation of the host "orchestrator window": registers on the bridge with its own conversation id, `POST /send` to any non-reserved team, receives `response_push`, and (as a named team) can be targeted by devcontainers for agent-initiated pings. Reuses the arbiter's existing routing with little/no arbiter behavior change.
- **Keep evie tools as-is.** Evie stays a headless tool provider + Discord relay. The app does not replace the ~53 evie actions.
- **Get history off Discord.** App persists its own transcript locally (SQLite/Room) = self-hosted on the phone.
- **Reach the bridge via a k8s tunnel using a kubeconfig**, the way switchboard port-forwards into evie.

### Discovered topology (constrains transport)

- Cluster: Linode LKE, API server public at `https://<id>.us-east-2.linodelke.net:443`, auth = bearer SA token + CA (evie-bot/kubeconfig.yaml). Admin-scoped today.
- Evie-bot: LKE pod, label `app=evie-bot-app`, bridge WS on port 20001 **internal to pod, no Service**. Arbiter reaches it via `kubectl port-forward`. Evie `BridgeTransport` is multi-client; `BridgeServer` (arbiter bridge) is last-connected-wins for DM forward only. Second bridge (server-manager) on 20003.
- Arbiter (switchboard): **host Docker, NOT in k8s**, behind home NAT. Holds a persistent outbound bridge to evie's pod.
- Devcontainers: on the host, routed by the arbiter's crosstalk surface.
- Consequence: phone (remote) and arbiter (home NAT) share no direct path. LKE is the only mutual rendezvous.

### Answered

**Q1 - Rendezvous topology: Relay through evie pod.** Reuse the existing arbiter<->evie WS. Add a phone-bridge port in evie-bot; phone tunnels into the pod via kubeconfig; evie relays phone<->arbiter frames. Chosen over a dedicated relay pod (more infra) and direct arbiter exposure (NAT hole / VPN). Accepts coupling chat to evie uptime; evie is already the linchpin.

**Q2 - App role: Full bidirectional peer.** App is a named team on the bridge: it sends to any devcontainer (each = a thread) and is targetable so agents can ping it unprompted. Identity = the device hostname by default, overridable via a Settings "Device Name" field. Implies multi-device support: each device registers as its own distinct peer. Rejected sharing the host's reserved identity (single-line collision). (Cycle 4 audit: the peer is keyed server-side by the per-install device id, not the Device Name, so same-named devices do not collide; the Device Name is a display label. Reserved or existing-team names are rejected server-side - see P3.)

**Q3 - Background delivery: hybrid poll, no push server.** App visible -> live WS tunnel, instant push. App closed -> periodic poll over a brief tunnel connect, pulling missed messages from the arbiter's persistent store. Implemented with WorkManager (Android periodic floor is ~15 min, not 10; Doze may stretch further when idle). Fully self-hosted, no Google/FCM, no ntfy. Accept >=15 min latency while closed; a self-hosted push (ntfy/UnifiedPush) can be added later if instant-while-closed is ever needed. Optional foreground service later to keep a specific thread live.

**Q4 - Phone credential: scoped ServiceAccount + ClusterIP Service.** Mint a dedicated k8s SA with minimal RBAC (reach only the evie phone-bridge in the evie-bot namespace, via services/proxy or pods/portforward), and add a ClusterIP Service so the phone uses a stable service-proxy URL instead of resolving pod names. Phone carries this minimal token, NOT the cluster-admin kubeconfig. Stolen phone reaches only the bridge. Rejected reusing the admin kubeconfig (full-cluster blast radius on a mobile device).

**Q5 - History: host-side durable store on an arbiter volume mount.** Transcripts persist on-prem on a Switchboard arbiter volume mount, pullable by the phone (phone also keeps a local cache). Exact schema / fetch protocol deferred ("figure out later"). Known semantic, recorded by user: the phone log is a MESSAGE LEDGER of phone<->container exchanges, independent of each devcontainer's internal Claude session. If a container restarts or clears its session the agent loses context while the phone log persists, so they can diverge by design; the app should surface when a thread's target session has reset.

**Q6 - Attachments: both directions from the start.** Add a `files` capability to the crosstalk path (text-only today): outbound phone->container on the send frame, inbound container->phone on the reply/response_push (channel_push already has a files field). base64 transport + size backstop mirroring evie's model. Work spans arbiter + evie relay + app, plus local file storage and Android media permissions on the device.

**Q7 - Phone powers: full remote orchestrator (target), staged.** Chat + evie tools + host orchestration (dispatch/session/wake). Staging: (a) chat first; (b) evie tools next, the shortest path since the phone tunnels straight into the evie pod and evie's BridgeTransport is multi-client, so the phone gets its own tool-provider connection with no arbiter hop; (c) host orchestration last - dispatch_cli/session_peek/session_send/wake are host-only MCP tools today, not network services, so exposing them to the phone is the heaviest and most security-sensitive surface. Plus: biometric app-lock (androidx.biometric BiometricPrompt) gating app open + the stored SA token, as an on/off Settings toggle (easy, included).

**Q8 - Thread UI: tabs + inbox.** An inbox lists every devcontainer thread with unread / needs-you badges. Opening a thread pins it as a switchable tab; tapping an inbox item opens or focuses its tab. Browser-tabs-plus-bookmarks feel: the tab strip is the active multitasking set, the inbox is the jump-to-anything index.

## Plan

### Target architecture

Three repos collaborate:

- **Android app** (new) - Kotlin + Jetpack Compose, native, no cross-platform layers. OkHttp for the TLS/WebSocket tunnel, Room for the local cache, androidx.biometric for the lock, WorkManager for background poll, EncryptedSharedPreferences/Keystore for the SA token.
- **evie-bot** (existing, in LKE) - gains a dedicated phone-bridge HTTP port (e.g. 20004) with its own `ANDROID_BRIDGE_TOKEN` (timing-safe bearer via `constantTimeBearerEquals`). The front door is a new fetch-only `Bun.serve`, NOT `BridgeTransport` (which only does WS upgrades). It relays each phone request over the existing arbiter<->evie WS, correlated by opId. Also directly serves the evie tool registry to the phone (phase 6).
- **switchboard arbiter** (existing, host Docker) - models the phone as a virtual bidirectional bridge peer so it reuses the existing crosstalk routing (wake, persistent conversations, multi-reply, response routing). Gains: a `files` capability on the crosstalk path, and a durable transcript store on a volume mount.

**Data path (poll-based; see Refinement Cycle 1):**
`App --(HTTPS request/response via k8s API service-proxy, scoped SA token, TLS pinned to LKE CA)--> evie pod phone-bridge HTTP endpoint (ANDROID_BRIDGE_TOKEN) --(opId-correlated relay over existing arbiter<->evie WS)--> arbiter --(crosstalk)--> devcontainers`

The phone holds NO long-lived socket. It polls (5s foreground, ~15 min background). evie terminates each phone request and round-trips to the arbiter over the arbiter-initiated WS (home NAT blocks inbound to the arbiter), holding the phone's HTTP response open until the relayed reply returns (with timeout).

**Identity:** phone registers as a bridge peer named after the device hostname (Settings-overridable). Multi-device = multiple distinct peers. Each devcontainer is a thread; agents can target the phone by name for unprompted pings.

**Key reuse:** the phone is a native re-implementation of the host "orchestrator window" bridge client. The crosstalk surface is already inherently multi-team, which is what escapes Discord's single-holder line. evie stays a tool provider + Discord relay, untouched in behavior.

### Phased roadmap

1. **Tunnel spike (de-risk first).** Scoped SA + ClusterIP Service in the cluster; evie phone-bridge port skeleton + `ANDROID_BRIDGE_TOKEN`; minimal Android shell that tunnels in via the API service-proxy, authenticates, and lists teams (`/teams` over the relay). Proves the only genuinely uncertain piece (kubeconfig-scoped WS tunnel from Android). No UI polish.
2. **Core text chat.** Arbiter virtual-peer adapter; evie relay multiplexing; phone as bidirectional peer. Send to a container thread, receive replies, receive an unprompted agent ping. Inbox + tabs UI. Local Room cache. This is the heart and the biggest single chunk.
3. **Background + notifications + lock.** Live WS while open; WorkManager ~15 min poll while closed pulling missed from the arbiter persistent store; local notifications; biometric lock + encrypted token storage.
4. **Durable history.** Arbiter volume-mount transcript store; phone backfill/pull protocol; surface when a thread's target devcontainer session has reset (ledger-vs-session divergence).
5. **Attachments both ways.** `files` on the crosstalk send + reply frames; app media picker, inline image render, downloads, Android permissions.
6. **Evie tools on the phone.** Phone pulls the evie tool registry directly from the pod it is tunneled into; tool-call UI; results inline. No arbiter hop.
7. **Host orchestration (heaviest, security-gated).** Expose dispatch_cli / session_peek / session_send / wake to the phone. Needs a deliberate control surface + auth review since these are host-only today.

### Open items (status after the Cycle 4 audit)

- **Relay peer model:** RESOLVED - arbiter virtual peer, with server-side device-name validation (P3).
- **Bridge auth gap:** RESOLVED into P3 acceptance (no widening of the arbiter HTTP surface; token verified at evie; `from` pinned to the validated device).
- **Multi-device collisions:** RESOLVED - peer keyed by the per-install device id (`conversationId`), not the Device Name (P3).
- **LKE proxy:** RESOLVED - transport is plain HTTPS short-poll (no WS upgrade); control-plane request-volume check folded into P6.
- **Phone -> host window:** OPEN - `arbiter`/`host` are reserved targets; full orchestration (P13) needs a dedicated control path to the host.
- **History store:** OPEN - schema + fetch/backfill protocol (deferred; P10).

## Refinement cycles

### Cycle 1 - Relay protocol, peer model, lifecycle (RESOLVED)

**Transport = poll-based HTTPS, no long-lived socket.** Supersedes Q3's "live WS while open". The phone makes brief request/response calls; foreground polls every 5s (in-app timer while visible), background polls on the WorkManager floor (~15 min, Doze may stretch). No foreground service needed by default. This also simplifies the tunnel to plain HTTPS (no WebSocket-upgrade-over-proxy).

**Evie = dumb relay, HTTP front + WS back.** A new phone-bridge on its own port with `ANDROID_BRIDGE_TOKEN` (timing-safe bearer, `constantTimeBearerEquals`). It exposes an HTTP request/response endpoint to the phone (Bun.serve fetch on that port, not a WS upgrade). For each phone request it sends an opId-correlated relay frame to the arbiter over the EXISTING arbiter<->evie WS and holds the phone's HTTP response open until the arbiter's reply frame returns (pending-map + timeout). evie understands nothing about chat semantics; it pipes by device/opId. NAT note: evie cannot call the arbiter inbound, so the arbiter-initiated WS carries both directions. No BridgeTransport rewrite required (client->server legs wrap as tool_call, server->client legs are raw pushes). Evie's own tools (phase 6) are served locally by the same provider, no arbiter hop.

**Arbiter = durable virtual-peer mailbox.** The phone is modeled as a permanent registered peer (team = device name, channel mode) whose socket is a duck-typed virtual object. Because there is no live socket, its `.send()` appends to a per-device pollable queue (capped ring buffer + inactivity TTL) instead of writing to a wire; `.readyState` is always open so agent->phone delivery (channel_push) always enqueues and never hits "no active connections"; the poll op drains the queue. This reuses ALL existing routing unchanged (wake, persistent conversations, multi-reply, response_push/channel_push delivery) - delivery just lands in the mailbox. The peer is excluded from the 30s heartbeat (it is a durable mailbox, not a live connection) and auto-confirmed as lead (no handshake round-trip). Chosen over a loopback bridge client (extra real socket, still needs the op protocol) and an explicit non-registry handler (duplicates routing, drifts from bridge semantics).

**Phone op set (inside the relay envelope):** `register`, `list_teams`, `send` (to a devcontainer), `respond` (to an inbound thread), `poll` (drain my mailbox). Unsolicited agent messages arrive only as queued mailbox entries the phone pulls on `poll`.

**Lifecycle / battery policy:** poll cadence is the policy. 5s foreground, ~15 min background floor. Accepted tradeoff: an agent that needs you while the app is closed waits up to the background floor. Optional future: a self-hosted push (ntfy/UnifiedPush) or an opt-in foreground service for instant-while-closed, if ever wanted. Mailbox cap + TTL bounds a dead device.

**Open sub-items (resolved in Cycle 4):** mailbox cap/TTL remain tunable (defaults 200 entries / 1h idle). The `idle` op is dropped (poll cadence + TTL already bound a dead device; see P9). Device-name collision is resolved by keying the peer on the per-install `conversationId`, not the Device Name (see P3).

### Cycle 2 - Tunnel, auth, provisioning (RESOLVED)

**Reach = Kubernetes API server service-proxy.** Reaffirmed after clarification (polling and k8s are orthogonal; "k8s tunnel" = plain authenticated HTTPS to the cluster's public API server, no kubectl on the device). The phone calls:
`POST https://<lke-api>/api/v1/namespaces/evie-bot/services/<phone-bridge-svc>:<port>/proxy/<op>` with `Authorization: Bearer <scoped-SA-token>`, OkHttp trust pinned to the cluster CA (the API server cert is cluster-signed, not publicly trusted). Private (no new public exposure), $0, reuses cluster auth. This reach is deliberately the one swappable/reversible piece; the relay + poll + mailbox design is independent of it.

**Polling = short-poll.** Each poll returns immediately with whatever is queued (empty if nothing); fixed 5s foreground cadence means evie never holds a request open, sidestepping any API-proxy idle timeout.

**Cluster additions needed (manifests):** a ClusterIP Service fronting the evie pod's phone-bridge port; a dedicated ServiceAccount; a Role granting only `get`/`create` on `services/proxy` for that one service in the `evie-bot` namespace; a RoleBinding. Double-gated: even with the SA token, the proxied service still requires `ANDROID_BRIDGE_TOKEN`. NOTE: evie's k8s manifests are NOT in the evie-bot repo (CI only does `kubectl rollout restart`), so we must first locate where the Deployment/Service are applied from and add the Service + SA there.

**Provisioning = manual paste / file import.** The credential blob (API URL, cluster CA, scoped SA token, ANDROID_BRIDGE_TOKEN, service path) is pasted or imported into the app once, stored in EncryptedSharedPreferences behind the biometric lock. A QR-from-host-script flow can come later; paste is fine to start.

**Open sub-items:** locate/own evie's k8s manifest source; SA token type (static Secret-based token for a held device vs bound/expiring - static is simplest but is a long-lived credential, mitigated by the scoped RBAC + biometric + remote revocation by deleting the SA); CA rotation handling (LKE CA in the current kubeconfig is long-lived, low concern).

### Cycle 3 - Live cluster recon (DONE, tunnel proven)

Read-only probe of the LKE cluster using evie-bot/kubeconfig.yaml via raw curl (no kubectl in env; raw HTTPS+bearer+pinned-CA is exactly the Android path):

- **Tunnel PROVEN end to end.** `GET /api/v1/namespaces/nyaakube/services/nyaakube-balancer:80/proxy/` returned HTTP 200 + real website HTML through the API server with our token + CA. The Android app does the identical call. Biggest unknown de-risked.
- `services/proxy` is RBAC-gated (SelfSubjectAccessReview: admin allowed via cluster-admin), so a scoped Role granting get/create on services/proxy for one service is the exact lever for the phone SA.
- Namespaces: default, evie-bot, github-runner, kube-node-lease/public, kube-system, nyaakube.
- **evie pod** `evie-bot-deployment-*` (1 replica), label `app=evie-bot-app`, containerPorts 80 + 20001. **No Service in evie-bot ns** - confirms port-forward-only today; the phone-bridge ClusterIP Service is net-new.
- **No ingress controller** in the cluster. nyaakube is fronted by a direct LoadBalancer (`nyaakube-balancer` 80/443). So service-proxy adds zero public exposure.
- API server: `https://404fe2d4-...us-east-2.linodelke.net:443`. Cluster CA ~1099 bytes, admin SA JWT.

### Cycle 4 - Plan audit (RESOLVED, findings applied)

5 auditors verified the plan against the real switchboard + evie-bot code; triage accepted ~15 findings and rejected 9 as overcautious/confirmation. The built P1/P2 code is sound; all blockers were in the unbuilt relay wiring (plus one latent hole in P2):

- **Blockers:** evie must consume `phone_relay_reply` (intercept atop `BridgeServer.handleCall`, else `Action not found` -> tool_error every reply); cross-provider reply wiring (the phone-bridge does not own the arbiter socket - use `getActiveBridge()` + a `settlePhoneRelay` entry point); device-name validation (a phone could register as an existing or reserved team and siphon its traffic). Applied to P3/P4.
- **Majors:** the phone front door is a fetch-only `Bun.serve`, not `BridgeTransport`; `removeDevice` must not blind-delete a co-resident real team; arbiter no-auth is now a P3 acceptance criterion; the mailbox `dropped` signal made sticky; client seq-dedup is a P8 acceptance; P11 attachments need 4 named edits; the evie manifest apply-source is a pre-P5 gate plus the `ANDROID_BRIDGE_TOKEN` pod-env. Applied to P3/P4/P5/P6/P8/P11.
- **Minors:** 5s-poll control-plane volume check (P6); Android CI/test gates (P7-P9); `idle` op dropped (P9).

### Build order and status

Android app cannot be built/run in this env (no Android SDK), and the phone is now just a raw-HTTPS client, so build BACKEND-FIRST and prove the whole pipe with curl-as-phone before the app. The phases below are the cycle laps; `audited-implementation` runs one per lap. Prod-touching steps (apply manifests, deploy evie, restart arbiter) are gated on explicit approval. Effort: P3-P6 are days (backend glue + the curl proof), P7-P9 are the bulk (the real multi-thread client + mobile lifecycle, weeks), P10-P13 are incremental adds on a working base.

## P1 Protocol + mailbox (DONE)

`src/shared/phone-protocol.ts` (relay frames + 5 ops + results + mailbox entry), `src/shared/device-mailbox.ts` (`DeviceMailbox` monotonic-seq queue, cursor ack, cap eviction + `dropped` gap signal, idle TTL; `DeviceMailboxStore` idle sweep), `src/__tests__/device-mailbox.test.ts`. Green: 8/8, tsc 0, biome clean.

## P2 Arbiter virtual-peer + handler (DONE)

`src/arbiter/phone/phonePeer.ts`, `src/arbiter/phone/phoneHandler.ts` (reuses `routes.send/respond/teams` + mailbox), `src/arbiter/websocket.ts` (`WsData.virtual` + heartbeat skip), `src/__tests__/phone-handler.test.ts`. Green: full suite 103/103, tsc 0, lint 0.

## P3 Arbiter relay wiring + peer hardening (DONE)

Complete through the full audited-implementation lap (align x2, red-team x2, framework, compliance) and committed to main (137 tests, tsc 0, lint 0). Files: `src/arbiter/phone/{phoneHandler,phonePeer,relayPump}.ts`, `src/shared/{device-mailbox,phone-protocol}.ts`, additions to `evieClient.ts`/`index.ts`/`websocket.ts`/`routes.ts`/`schemas.ts`.

Hardening landed beyond the original spec (from the audits): mailbox accessor + onEvict->removePeer so peer lifetime equals mailbox lifetime; virtual peers excluded from DM-holder selection (`getAllActiveRealWs`), `getTeamMode`, and the heartbeat; a real registration evicts a squatting virtual peer (onVirtualPeerEvicted -> removePeer); CLI-target sends rejected when online and recovered via a post-bound continuation when woken; register-op device rename (rebind migrates the registry sub, mailbox preserved); conversationRegistry pinning + self-heal; ownership-scoped `respond` (only sessions delivered to the device; keeps session_id away from resolveHandshake); per-(conversation,opId) idempotency caching only mutating ops, only on success; mailbox epoch + epoch-gated drain; store-wide LRU device cap; zod `PhoneRelayFrameSchema` at the boundary via `createPhoneRelayPump`; `routes.respond` team-broadcast fallback gated to entries without fromConversationId.

Known accepted-minor (not blocking): `pickFirstOnlineTeam`/`tryDeliverDm` are non-exported closures (virtual-filter behavior reviewed, not unit-tested); the deeper four-parallel-maps -> one PhoneSession consolidation was deliberately deferred (single teardown chokepoint already prevents the bug class).

Wire the handler into the live arbiter (switchboard repo) AND close the security holes the audit found in the already-built P2 code (latent: nothing calls `handleFrame` yet, so not exploitable until the relay is live - but must be fixed before it is).

Plumbing:
- `evieClient.ts`: add `onPhoneRelay?: (frame: PhoneRelayFrame) => void` to `EvieClientConfig` + a `msg.type === "phone_relay"` branch. Clear/fail `pendingCalls` on ws `close` (today only `stop()` does) so an in-flight `phone_relay_reply` fails fast instead of waiting the 120s timeout across a reconnect.
- `index.ts`: construct `DeviceMailboxStore` (+ `startCleanup`) and `createPhoneHandler` with the real routes/registries; in `onPhoneRelay` call `handleFrame(frame)` then `evieClient.callTool("phone_relay_reply", reply)`.

Hardening (must-fix before live):
- Device-name validation in `ensurePeer`/`dispatch`: reject `frame.device` if it is in `RESERVED_TEAM_NAMES` or already exists as a non-virtual team (any sub with `data.virtual !== true`). Today a phone could claim an existing devcontainer's name (PHONE_SUB_ID "phone" never collides with a real subId, so the dedup guard is skipped) and siphon that team's `channel_push`/`response_push`, or claim "arbiter"/"host" and satisfy `holderMatchesSender`.
- `removeDevice`: delete only the `PHONE_SUB_ID` sub; delete the team + mailbox only when no non-virtual subs remain. Never blind `registry.delete(device)` (it would evict a co-resident real team = DoS).
- Multi-device: key the peer by a per-install device id (the phone's `conversationId`), not the human Device Name, so two devices with the same name never share a slot/mailbox. Device Name stays a display label.
- Pin `from`/`fromConversationId` to the validated identity: reject a frame whose `conversationId` is already owned by a different device (no forging `from`).
- Make the mailbox `dropped` gap signal sticky: accumulate across drains, clear only when the phone acks it (or document that the phone treats any non-monotonic seq jump as a gap).

Trust boundary (acceptance, not a deferred open item): no widening of the arbiter HTTP surface. The arbiter still trusts only relayed frames off the `evieClient` WS; the phone token is verified at evie; `/send` etc. stay reachable only from the Docker network + the relay.

Acceptance: typechecks + lint clean; tests asserting (a) relay frame in -> reply out via a fake evie transport, (b) `device` = an existing real team or a reserved name is rejected, (c) `removeDevice` leaves a co-resident real team intact, (d) sticky `dropped`. No prod.

## P4 Evie phone-bridge (DONE)

Committed in the evie-bot repo (`app/features/bridge/PhoneBridgeServer.ts` + edits to `BridgeServer.ts`/`BridgeService.ts`, `PhoneBridgeServer.bun.test.ts`). Audited (combined align+bug+security pass, zero accepted findings; wire contract verified end-to-end against the arbiter), 10/10 bun tests + 21 bridge tests, tsc 0, lint 0. Note: evie-bot's vitest needs Node 20+ (host is 18), so the test is a `*.bun.test.ts` run under Bun's native runner like the existing `BridgeTransport.bun.test.ts`. Default hold widened to 35s (> the arbiter's 25s send bound + reply round-trip).

Original spec:

In evie-bot repo. The phone front door is a NEW fetch-only `Bun.serve` (reuse only `constantTimeBearerEquals` for `ANDROID_BRIDGE_TOKEN`), NOT `BridgeTransport` - whose `handleFetch` only does a WS upgrade and 426s plain HTTP requests. (The earlier "reuses BridgeTransport" wording was wrong for the HTTP front door.)

Relay legs are cross-provider, because the phone-bridge does not own the arbiter socket:
- Forward: per phone HTTP request, get the live arbiter connection via `getActiveBridge()` and push a `{type:"phone_relay", ...}` frame on it (mirroring `BridgeServer.forwardDM`). Target the current `connectedClient` (last-wins); on no connection, bounce the phone request with a retryable error so it re-polls.
- Consume: the arbiter replies as a `tool_call` action `phone_relay_reply` on the arbiter bridge (port 20001), so `BridgeServer.handleCall` must intercept `name === "phone_relay_reply"` at the TOP (before `handleActionCall`, which would throw `Action not found` -> tool_error spam), route its params into a shared pending-map by `opId` to settle the held HTTP request, then return a trivial value so the transport sends a clean `tool_result`.
- Wire the handle-passing in `BridgeService.onStart`: `BridgeServer` owns the arbiter socket and exposes `settlePhoneRelay(opId, reply)`; the phone-bridge HTTP server owns the pending-map.

Acceptance: builds + lints in evie-bot; integration test driving `phone_relay_reply` through `BridgeServer.handleCall` settles a held request by opId; opId timeout AND arbiter-offline both bounce the phone cleanly.

## P5 K8s manifests (DONE - authored, not applied)

Authored as `evie-bot/deploy/phone-bridge.yaml` + `phone-bridge.README.md`, committed in evie-bot. Pre-gate resolved: evie's Deployment is managed imperatively via the Linode k8s dashboard (managedFields show `dashboard-api` + `kubectl-rollout`, no `last-applied-configuration`), so standalone `kubectl apply` objects are safe and survive rollouts. Package: ClusterIP Service (`evie-phone-bridge` -> pod port 20004, selector verified against the live pod label), scoped ServiceAccount + Role (get/create on `services/proxy` for `evie-phone-bridge:20004` only) + RoleBinding, and a long-lived SA-token Secret. The `ANDROID_BRIDGE_TOKEN` app-token is created imperatively (kept out of git) and added to the pod via `kubectl set env`. README documents apply order, the RBAC `can-i` dry-run (verified against the load-bearing port-form resourceName), and phone provisioning. Reviewed against the live cluster; NOT applied (gated on user approval).

Original spec:

Pre-P5 gate (hard prerequisite): locate the source that applies evie's Deployment (NOT in the evie-bot repo; CI only does `kubectl rollout restart`). Confirm how it is applied and that new objects survive the next apply. Authoring YAML before this risks orphan manifests.

Then author (do NOT apply) as ONE approval/apply package: the ClusterIP Service fronting the evie phone-bridge port, a scoped ServiceAccount, a Role granting only get/create on `services/proxy` for that one service in `evie-bot`, a RoleBinding, the SA token Secret, AND the `ANDROID_BRIDGE_TOKEN` pod-env addition to the Deployment. Acceptance: apply-source found + confirmed; package reviewed by user; SelfSubjectAccessReview dry-run documented.

## P6 Curl-as-phone end-to-end (DONE - deployed + validated live)

Deployed and validated in production. Full cycle: pushed evie (CI built image + k8s rollout) and switchboard (Android APK release) via `gitPushNewBranch(merge)`; created the app-token secret + applied `phone-bridge.yaml` + set the env (phone bridge came up on 20004); rebuilt the arbiter + host daemon (`down.sh`/`start-arbiter.sh`/`start-host-daemon.sh`). `phone-bridge-smoketest.sh` returned ALL PASS (health, register, list_teams returning 5 online teams, idempotency replay). A live phone `send` of "hello" to the `nyaadot` team round-tripped: the agent's reply came back through the mailbox (`seq:1, cursor:1, epoch:2`). The deploy ritual is documented in `CLAUDE.md` ("Deploying the phone bridge"). The header-passthrough fix held in production.

Original (deploy-gated) spec:

Authored `evie-bot/deploy/phone-bridge-smoketest.sh` (curl-as-phone: health, register, list_teams, send, poll, idempotency replay). The live run is gated on the user deploying P3-P5. Tracing the deploy path here surfaced a real integration fix (now committed): the k8s API service-proxy consumes the request `Authorization` header (the SA token) for its own auth, so the evie phone bridge reads the app token from a separate forwarded header `X-Android-Bridge-Token` instead. The smoke test's register check is the canary for that header surviving the proxy hop; if it does not, the fallback is to drop the app-token gate and rely on the scoped SA token + RBAC alone. This corrects the Cycle 2 "double-gated" note (the two gates ride two different headers on one request, not one).

True gate: external cluster apply approved + applied (the P5 package), not just P3-P5 code done. Then simulate the phone with curl through the service-proxy: register, list_teams, send to a mock team, poll the mailbox, respond. Run the 5s foreground loop for several minutes watching for 429 / API-priority-and-fairness throttling and audit-log volume (5s polls traverse the LKE control-plane API server; foreground-only + ~15min background bounds it). Record the new tradeoff: chat availability is now coupled to LKE control-plane availability (alongside the existing evie-uptime coupling). Proves the whole pipe minus the UI.

## P7 Android tunnel spike (DONE)

Built + run + validated. `switchboard/android/` is a Kotlin/Compose app (`com.atelier_nyaarium.switchboard`, minSdk 26, compileSdk 35, AGP 8.7.3 / Gradle 8.11.1 / Kotlin 2.0.21). `PhoneClient` builds an OkHttp client pinned to the cluster CA and reaches the phone bridge through the k8s API service-proxy (SA token in `Authorization`, app token in `X-Android-Bridge-Token`). The spike screen pastes a provisioning blob, tests the tunnel, and lists teams; a base64 `provisioning_b64` + `autotest` intent extra allows headless injection. CI: `.github/workflows/main-push.yml` + `_build-android.yml` build the APK on push (path android/**) and refresh a single latest GitHub release (delete + recreate the `android-app` tag, `make_latest`), mirroring evie's pattern.

Validated end to end on a headless emulator: builds (`./gradlew :app:assembleDebug`), installs, renders the Compose UI (screenshot), and the CA-pinned tunnel reached the LIVE LKE API server (`reachable (HTTP 200)` from the emulator). Only `list_teams` awaits the P5/P6 deploy; the tunnel mechanism is proven.

### Dev environment (set up this session, on the host)

- `kubectl` v1.36.1 in `~/.local/bin` (verified against the cluster).
- Android toolchain in `~/android-dev` (user-space, no sudo): Temurin JDK 17, Android SDK (cmdline-tools, platform-tools, platform/build-tools 35, emulator, x86_64 system image), Gradle 8.11.1. Source `~/android-dev/env.sh` for `JAVA_HOME`/`ANDROID_HOME`/PATH.
- Headless emulator AVD `phone35` (KVM-accelerated via the `/dev/kvm` ACL on the user; software GPU `-gpu swiftshader_indirect`). Boot, `adb install`, and `adb exec-out screencap` all work without a display.

### Original spec

Minimal Kotlin/Compose app (built on the user's machine): paste-provisioned creds, OkHttp with CA pinning + bearer, call `list_teams` over the service-proxy, render the list. De-risks the device-side tunnel. Acceptance: Gradle build + ktlint/detekt gate (CI-able without an emulator); unit test for the OkHttp CA-pinning client.

## P8 Android multi-thread chat (tabs + inbox) - core DONE

Core built + validated live on the emulator against the deployed backend (with the scoped SA token, not admin). `ChatRepository` holds per-team threads + an unread tally and runs the 5s poll loop, routing each mailbox reply to its team via the `conv:<id>:<team>` session id; `PhoneClient` gained register/teams/send/poll. UI: provision screen -> inbox (live teams + unread badges) -> thread (send + received bubbles), state-based nav, process-lifetime `Repo` singleton. Verified by driving the real UI: opened nyaadot, sent `ping-from-the-app-UI`, and the agent's `pong-from-the-nyaadot-session` reply came back through the poll loop and rendered in the thread.

Still to do (P8 polish, deferred): switchable tab strip (currently single open thread), local Room cache for durable transcripts (in-memory today; couples to P10), and the unit tests for poll/cursor/seq-dedup. Acceptance for those: the client dedupes inbound entries by `seq` and advances the poll `cursor` monotonically (highest contiguous seq consumed), so a duplicate drain from a lost ack never double-inserts; a non-monotonic seq jump or sticky `dropped` surfaces a gap.

Original spec:

Full chat client: send/poll loop (5s foreground), per-team threads, inbox with attention badges, opening a thread pins a tab. Local Room cache. Acceptance: the client dedupes inbound entries by `seq` and advances the poll `cursor` monotonically (highest contiguous seq consumed), so a duplicate drain from a lost ack never double-inserts the transcript; a non-monotonic seq jump or a sticky `dropped` surfaces a gap. Unit tests for the poll/cursor/dedup logic.

## P9 Android poll lifecycle + biometric + provisioning

WorkManager background poll (~15 min floor); biometric lock (androidx.biometric) gating app + EncryptedSharedPreferences token; Settings (Device Name, poll cadence). Optional QR provisioning. Unit tests for the WorkManager poll + token storage. (Idle-on-minimize op dropped from scope: poll cadence + mailbox TTL already bound a dead device; revisit only if instant-while-closed is ever added, which would need a PhoneOpKind extension + protocol-version bump.)

## P10 Durable history

Arbiter volume-mount transcript store; phone backfill/pull; surface target-session-reset (ledger vs session divergence).

## P11 Attachments both ways

Four backend edits (the crosstalk path is text-only today): (1) add `files` to `ResponsePushPayload` and have `PhonePeer.send` copy `p.files` into the reply entry; (2) add `files` to `SendRequestSchema`; (3) forward files into the `channel_push` in `routes.send`; (4) pass `op.files` through in `phoneHandler.send` (`PhoneSendOp` + `MailboxEntry` already carry `files`). Confirm the evie relay carries the bytes and the 500MB `ChannelFilesSchema` backstop applies on this path. App side: media picker, inline image render, downloads, Android permissions.

## P12 Evie tools on the phone

Phone pulls the evie tool registry directly from the pod it tunnels into; tool-call UI; results inline. No arbiter hop.

## P13 Host orchestration

Expose dispatch_cli / session_peek / session_send / wake to the phone via a deliberate control surface + auth review (host-only today; needs the phone->host path resolved).

