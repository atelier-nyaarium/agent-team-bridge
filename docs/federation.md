# Federation

The self-hosted Router, how a Gateway reaches it, and the trust model.

## Self-hosted Router

`src/federation-server/` is the Router. Three surfaces share one TLS port: bearer-gated gateway WS,
app-token-gated console ops, and token-exempt device approval for fresh devices.

The Router certificate is minted once. Rotation requires re-provisioning every enrolled Gateway and
phone. It is distinct from the ephemeral certificate used by the 20003 enrollment listener.

**Reach: one Router, several addresses.** Home routers may not hairpin LAN-to-public connections. The
Router advertises `{publicHost, publicPort?, lanAddresses}` through the app-token-gated `reach` op.
The phone stores this in `reach.json` and tries LAN addresses, public host, then bootstrap address.

**Gateway and phone fail over differently.** The phone fails over per operation. The Gateway fails
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
- Failover follows thrown `IOException`, not HTTP status.
- Debug ingest uses the transport's current base after reach changes.

## Pinning the Router

The Router leaf is self-signed. Its fingerprint is its identity. `gateway/router/pinnedSocket.ts`
owns the check.

- **Pin before the WS upgrade.** The bearer must not be sent before the TLS leaf matches.
- **Resolve the real `ws` package.** Bun's bare `ws` substitution lacks peer-certificate access and
  ignores `createConnection`.
- Preserve `match`, `mismatch`, `unreadable`, and `pending` as separate verdicts.
- Chain verification stays off. The fingerprint is the identity check for this self-signed leaf.
- `assertBunFloor` requires Bun 1.4+. `check-pinning-runtime.ts` verifies runtime behavior. Node uses
  the real `ws` package.
- `moduleDir()` must use `fileURLToPath()`, not URL pathname conversion.

## Trust

The Router routes opaque sealed payloads by `dstGateway` and `relayId`. It cannot read or forge E2E
payloads. Presence discovery is local merging of `list_teams` responses.

The owner device is the trust root. Owner-signed admissions are mirrored on the Router and every
Gateway, so revocation still applies while the Router is unreachable.

- **Crypto:** Ed25519 signing, X25519 boxes, HKDF-SHA256, and AES-256-GCM. AES-256-GCM is required
  because Bun lacks ChaCha20.
- **Never sign raw JSON.** Versioned newline-joined encodings are reproduced byte-exactly across
  Node, Bun, and Android.
- Registration requires keys, an owner-signed admission, and fresh possession proof. No bearer
  fallback.
- A Gateway without a Domain starts standalone for `/health` and `/enroll`; the bridge activates only
  when both transport and Domain resolve.
- Enrollment roots the first owner key through a single atomic CAS write. The owner root private key
  never leaves the phone.
- `ReplayGuard` runs after signature verification.
- Trust-on-first-enroll rejects later snapshots rooted at a different owner key.
- Console relay frames are sealed and signed by the enrolled console key; the Gateway checks the
  owner-signed `kind:console` admission.
- `CONSOLE_BRIDGE_TOKEN` remains the shared app-token gate for the console surface.

**A cross-machine answer states how complete it is.** `discover()` returns asked, answered and
unreachable ids plus `rosterKnown`, so a partial result is not a plain success and an unreadable
roster is not "no peers". `isRegistered` differs from `isConnected`: a refused registration leaves
the socket open, so a revoked gateway reads as alone. The console retains rows for an unreachable
gateway rather than sweeping them.

## File map

- `src/federation-server/` - Router surfaces, registration, enrollment, trust.
- `src/gateway/router/routerClient.ts` - Gateway reach failover and Router registration.
- `src/shared/router-reach.ts`, `android/.../RouterReach.kt` - equivalent candidate ordering.
- `src/gateway/router/pinnedSocket.ts` - TLS pinning.
- `tests/fixtures/router-reach/vectors.json` - cross-runtime reach and pinning behavior.
- `src/shared/crypto.ts` - federation sealing and signatures.
