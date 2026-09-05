# Federation

The self-hosted Router, how a Gateway reaches it, and the trust model.

**Compatibility:** Protocol version 2. Protocol-1 Gateways receive `unsupported` for value and delivery ops.

## Self-hosted Router

`src/federation-server/` is the Router. Three surfaces share one TLS port: bearer-gated gateway WS,
signed OwnerOps for the phone, and token-exempt device approval for fresh devices.

The Router certificate is minted once. Rotation requires re-provisioning every enrolled Gateway and
phone. It is distinct from the ephemeral certificate used by the 20003 enrollment listener.

**Reach: one Router, several addresses:** Home routers may not hairpin LAN-to-public connections. The
Router advertises `{publicHost, publicPort?, lanAddresses}` through the app-token-gated `reach` op.
The phone stores this in `reach.json` and tries LAN addresses, public host, then bootstrap address.

**Gateway and phone fail over differently:** The phone fails over per operation. The Gateway fails
over per reconnect, advancing only when a socket never opened.

- Gateway registration cannot call `reach`: it has a WS bearer, not the console app token. It
  receives optional reach data in `gateway_register`.
- `FEDERATION_ROUTER_HOST` overrides the sealed bundle address for Gateway setup.
- LAN uses the Router port. Public uses `publicPort`; absent means the Router port.
- A private candidate uses `LAN_CONNECT_TIMEOUT_MS`.
- The typed address remains last. There is no last-successful-address field.
- `reach.json` stays beside `transport.json`; delivered transport bytes remain stable while learned
  reach data changes.
- Reach is not exposed on `/health`.
- Failover follows thrown `IOException`, not HTTP status. It re-posts the same signed op, so the
  Router answers a repeated nonce with the first answer, in flight or settled, within the skew window.
- Debug ingest uses the transport's current base after reach changes.

## Pinning the Router

The Router leaf is self-signed. Its fingerprint is its identity. `gateway/router/pinnedSocket.ts`
owns the check.

- **Pin before the WS upgrade:** The bearer must not be sent before the TLS leaf matches.
- **Resolve the real `ws` package:** Bun's bare `ws` substitution lacks peer-certificate access and
  ignores `createConnection`.
- Preserve `match`, `mismatch`, `unreadable`, and `pending` as separate verdicts.
- Chain verification stays off. The fingerprint is the identity check for this self-signed leaf.
- `assertBunFloor` requires Bun 1.4+. `check-pinning-runtime.ts` verifies runtime behavior. Node uses
  the real `ws` package.
- `moduleDir()` must use `fileURLToPath()`, not URL pathname conversion.

## Trust

The Router routes opaque sealed payloads by `dstGateway` and `relayId`. It cannot read or forge E2E
payloads. Presence rows are not sealed: the Router folds the owner projection, and a gateway keeps
only its own rows authoritative.

The owner device is the trust root. Owner-signed admissions are mirrored on the Router and every
Gateway, so revocation still applies while the Router is unreachable.

- **Crypto:** Ed25519 signing, X25519 boxes, HKDF-SHA256, and AES-256-GCM. AES-256-GCM is required
  because Bun lacks ChaCha20.
- **Never sign raw JSON:** Versioned newline-joined encodings are reproduced byte-exactly across
  Node, Bun, and Android.
- Registration requires keys, an owner-signed admission, and fresh possession proof. No bearer
  fallback.
- A Gateway without a Domain starts standalone for `/health` and `/enroll`; the Gateway federation bridge activates only
  when both transport and Domain resolve.
- Enrollment roots the first owner key through a single atomic CAS write. The owner root private key
  never leaves the phone.
- `ReplayGuard` runs after signature verification.
- Trust-on-first-enroll rejects later snapshots rooted at a different owner key.
- Phone OwnerOps are sealed and signed by the enrolled console key. The Router checks the owner-signed
  `kind:console` admission.
- `CONSOLE_BRIDGE_TOKEN` remains the shared app-token gate for the console surface.
- A cross-Domain pairing names the Domain root, never the signing device. The listening token
  names the receiver's gateway id, and a requester refuses a token naming its own id, so two Domains
  whose Gateways share an id pair only from a Gateway whose id differs from the receiver's.

## Content keys

- The owner phone derives each Domain-bound content key from the owner signing key and epoch.
- Each epoch-bound key envelope is sealed to the recipient's admitted box key and signed by an admitted console.
- The phone stores keys in the Keystore-backed `AppStateStore` `contentKeys` slot. The Gateway stores them in `DATA_DIR/federation/content-keys.json`.
- Add Device delivers current key envelopes in `ConsoleTransport.contentKeys`. Gateway bootstrap delivers them in `GatewayBootstrapBundle.contentKeys`.
- Bootstrap writes admission, transport, Domain id, and keys under `federation/staging/`, writes an `INSTALLED` marker, then copies the artifacts atomically with transport last. Recovery retries a complete marked staging directory, rolls back incomplete or corrupt staging, and keeps staging on other activation errors.
- Gateway re-enrollment validates the merged live and bundle view, requires a newer admission, merges the allowlist, and merges keys without dropping held epochs.
- First enrollment uses trust on first use for the Domain root.
- Deploy the Router before the app. Unsupported join signatures cause refusal.
- Blob bytes seal per chunk on the existing 1 MiB boundary, each frame being a nonce, the ciphertext and its tag. The blob id stays the plaintext digest, so the Router verifies the CIPHERTEXT digest it was told and only a reader holding the key can verify the plaintext. Chunk index and the final flag ride in the AAD, so a Router cannot reorder, truncate, or splice chunks. `src/shared/sealed-blob.ts` and `crypto/SealedBlob.kt` are twins over a shared fixture corpus.
- Board text binds its entry id into the AAD the same way. See `docs/task-board.md`.

## Inboxes

- Addresses: `owner:<domainId>/<ownerSignPub>`, `session:<domainId>/<gatewayId>/<sessionId>`, `gateway:<domainId>/<gatewayId>`.
- A row is `{ seq, acceptedAt, size, envelope, producerSig, body }`. The producer signs the envelope; the Router adds seq, acceptedAt, and size.
- The op ledger keys on `(owner, conversationId, opId)`. A repeat with the same hash answers the recorded result; a different hash answers `conflict`.
- **A retry is one operation:** The producer mints `opId` once per invocation, and every retry carries it. The identity hash covers the CLEAR operation.
- The phone uses protocol version 2. A protocol-1 Gateway still registers but receives `unsupported`
  for value ops and delivery ops.
- Capacity refuses before storage: the row cap answers `refused`, the Domain quota answers `durability_failure`, a failed fsync answers `durability_uncertain`.
- Gateway frames name only themselves. The Router takes the Domain and gateway from the connection; a session origin must be in the session registry; a peer row into another Domain needs a link edge.
- `gateway_register` returns an incarnation. Every inbox frame carries it; a stale one is refused.
- The Router pushes `inbox_deliver` on append and again after each register. The gateway keeps a durable claim per delivery under `DATA_DIR/inbox-claims/`, offers once, and acks on the receiver's word. A redelivered claimed row is re-acked, never re-offered.
- An undelivered row expires after 30 days with an `expired` result row to its sender.
- A console reaches the inbox through signed OwnerOps: `deliver` with a `console_op` row, `consumer_register`, `inbox_read`, `inbox_advance`, `planes_read`, `report_read`, and `capabilities_report`. `gateway_value` forwards VALUE kinds as `value_op`. Delivery answers use `op_result`. Value answers use typed `unreachable` or `timeout` outcomes.

## Owner state

- Every owner-scoped record lives in the per-owner store under `DATA_DIR/owner/`, keyed by kind and id with a CAS version. A service answers only the Domain named in the call.
- Services register their ops and frames through `ownerServiceHooks.ts`. A frame handler receives the authenticated registration; the bridge deletes `domainId` and `gatewayId` from the payload first, so no handler can read one.
- `ownerOpRegistry.ts` catalogues every owner-op kind with its value schema, its mutation class, and where one exists its answer schema. Registration takes a catalogued kind, so a kind with no schema or no class cannot be added, and the intake parses the value before the handler sees it. `delivery` names the one kind that appends a delivery row and carries its own nonce; `value` names the kinds the migration fence holds; `read` names the rest. The catalog is also the source the Kotlin `Protocol.Wire` constants are generated from.
- Presence: a gateway sends `presence_baseline` after registering and `presence_delta` with a sequence; a gap answers `presence_resync`. A dropped socket marks the gateway's rows unreachable; the next baseline replaces them. The owner projection folds rows, roster, coverage, spawn points, and each linked Domain's friend projection; a friend sees shared sessions only.
- Shares: records per session target and friend, a generation per pair bumped by unshare and unlink. A peer row is admitted only while shared, stamped with the generation, and retired `target_revoked` when the generation moves before delivery. A gateway attests live cross-Domain jobs with `share_job_live`, and writes the record itself with the `cross_domain_share` and `cross_domain_unshare` frames. Those two carry the same `{sessionTarget, target}` as the owner ops and are authorized by the registration: the Domain is the registration's, and the session target's gateway segment must be the registering gateway, so a gateway shares only its own sessions. The 30-day sweep keeps attested shares.
- The Gateway's `cross_domain_share` value op writes the Router record and its own mirror in one operation, record first. The record is what admits the friend's rows. A refused record answers the value op as failed and leaves no mirror, so the phone posts nothing itself.
- A peer reply back into the origin Domain targets a job key, not a registered session. It is admitted by the origin's own link edge instead of a share. A linked Domain can therefore append reply rows for jobs the gateway does not hold; the gateway drops them at delivery, and the inbox row cap bounds the flood.
- `cross_domain_unlink` drops the Domain's link edge as well as its shares.
- Board: entries with a clear envelope and sealed title, body, and names; writes carry `expectedRevision` and no actor, because the receiver names the writer from the authenticated channel; the same authority and cascade rules the gateway used, plus `mayTake` for claim and release; observations land as `board_observation` rows in the affected sessions' inboxes. Attachments must be held in the reference-held store.
- Scheduled sends: one record per target; replace and cancel are versioned; a Router timer fires through the op ledger under the send's own op id and writes a `scheduled_result` row the phones fold.
- Capabilities and read anchors are tier-1 records with their own OwnerOps.
- Blobs: `blob_begin` and `blob_chunk` are refused until blob sealing is designed, so the Router holds no gateway-uploaded bytes. A `blob_fetch` reads the cache first and forwards to the origin gateway only on a miss.

**A cross-machine answer states completeness:** `discover()` returns asked, answered and unreachable
ids plus `rosterKnown`. `isRegistered` differs from `isConnected`: a refused registration leaves
the socket open, so a revoked gateway reads as alone. The console retains rows for an unreachable
gateway rather than sweeping them.

## File map

- `src/federation-server/` - Router surfaces, registration, enrollment, trust.
- `src/gateway/router/routerClient.ts` - Gateway reach failover and Router registration.
- `src/shared/router-reach.ts`, `android/.../RouterReach.kt` - equivalent candidate ordering.
- `src/gateway/router/pinnedSocket.ts` - TLS pinning.
- `tests/fixtures/router-reach/vectors.json` - cross-runtime reach and pinning behavior.
- `src/shared/crypto.ts` - federation sealing and signatures.

## Migration

### Preconditions

Router live. Key backfill confirmed for every member. Leases set for every member.

Leases support `active`, `offline`, `retired`, and `excluded` Gateway states.

### Gateway fence

The Gateway writes `DATA_DIR/migration-epoch`. Phones and agents see `migrating` for fenced writes.
Wait 60 seconds for in-flight operations to settle.

### Authority

Migration authority turns on when every `active` lease has `completedEpoch` equal to `N`. An
`offline` Gateway stays fenced on reconnect until it completes. `retired` and `excluded` Gateways
stay fenced on reconnect. Non-active leases do not block authority.

### Phone

The Router welcome carries `migrationEpoch`. The phone runs self-migration once per epoch, on any
accepted welcome. Scheduled sends upload under their own opId. Read anchors re-report. An unanswered
upload retries on the next welcome. A refused record keeps its local alarm. A local record is
released only after the Router accepts it.

### Recovery

| Crash point | Safe rerun |
|-------------|------------|
| Fence before settle | Wait 60 seconds |

Lowering the fence refuses before 60 seconds or with a malformed fence. A missing fence also refuses.
