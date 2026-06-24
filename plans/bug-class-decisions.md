# Home-retire refactor (breaking, clean-break, no migration code)

Retire the literal `home` / `DEFAULT_DOMAIN_ID` Domain id for a random hex id across all three runtimes,
reframe `operatorName` -> `profileName` (the PERSON's name, always shown over the id), fail-closed
identity handling, and rename the host-agent identity `gateway` -> `host-agent`. The owner WIPES evie +
re-provisions from scratch, so there is NO migration / back-compat / coexistence code anywhere - build
for the END STATE only.

(Origin: a bug-class framework-first audit found `"home"` doing double duty as a real Domain id AND an
"unknown" sentinel; a 39-gap refinement audit then found the load-bearing use - the console sends NO
domainId, so `"home"` is how it reaches its operator's mesh. History + the gap list are in git + the
gap-audit workflow output.)

## Locked decisions

- **Operator-home anchor = A (DONE).** The operator home is the Domain slice flagged `isPrimary` on
  evie's `EnrollmentState`; `KubeSecretStore.operatorDomainId()` resolves it. The console addresses
  gateways (no domainId on the wire), so evie scopes the console relay + the register bootstrap
  carve-out to that marker. This is the blocker - without it, retiring `home` breaks every console op.
- **Domain ID = random hex**, pure machine plumbing, never shown to a human. Acceptance (owner):
  `"home"` must not grep anywhere as a domain id - `DEFAULT_DOMAIN_ID` deleted, no `== "home"`, no
  `?: "home"` fallback, fixtures off the literal.
- **`operatorName` -> `profileName` (the PERSON, "Alice"), ONE name per person** (person = owner key =
  one home Domain = one profile name; an operator HOSTS guest Domains but each guest owns theirs). The
  roster ALWAYS renders the profile name, never the hex id. REQUIRED at provisioning (the app's import
  screen gates QR-scan/paste on a non-empty "Your Name", carried into first-root). "(unnamed)" is a
  defensive backstop only. Name entry moves to the phone, so the host `setup-evie-admin.sh` (renamed
  from `provision-console.sh`, admin-only) stages no name.
- **Fail-closed identity.** A present-but-undecodable owner/console key NEVER silently regenerates or
  overwrites; mint only when truly EMPTY; surface recovery (restore backup / re-provision); fp logging
  parity (gateway ships it) + an orphan "key regenerated, re-admit" detector.
- **One atomic deploy** (Phases 1-4 land together, clean-break wipe first), then the host-agent rename
  (Phase 6) as a separate vetted pass.

## Phase 0 - operator-home marker. DONE.

evie `018b6c8`, switchboard `4350c7a` (+ prep `888b5eb`: the `FEDERATION_DOMAIN_ID` compose passthrough).
`isPrimary` on `EnrollmentState`, the `operatorDomainId()` resolver, the 5 console-routing methods +
enroll-op + register gate re-keyed onto one `operatorDomain()` resolver, fail-closed on >1 primary,
`persistDomain` preserves the marker, `provision`/`remove` refuse the primary by the marker. Fully
audited (align / red-team / framework) + tested.

## Phase 1 - retire `home` -> random hex (THE sweep; ONE coherent green pass)

CONCRETE scope, mapped by starting it. It is ONE knot: deleting `DEFAULT_DOMAIN_ID` forces every consumer
at once + a fail-closed routing change that reworks the federation test suite. Sequence: re-key all
consumers (keeps compiling while the const is still defined), delete the const LAST, then the tests.
Reaches green only as a complete pass; half-done is a red build.

**evie** (`DEFAULT_DOMAIN_ID` def in `EnrollmentCoordinator.ts`):
- `sanitizeDomainId`: empty / all-separator -> THROW (every wire op names a real Domain; the
  register/relay boundary callers must catch + reject - check `BridgeService` :240/:439).
- `shouldVivifyCoordinator`: drop the `=== DEFAULT_DOMAIN_ID` line (vivify on rooted/pending only; the
  now-unused param -> `_domainId`).
- `EnrollmentCoordinator` ctor: `domainId` REQUIRED (drop the default) -> cascades to ~15
  `new EnrollmentCoordinator(...)` sites (prod `BridgeService` passes it; the test sites omit it).
- Delete the dead `getActiveEnrollment` + the dead `FederationEnrollOwnerAction` (its import is already
  commented out in `ActionRegistry`).
- `BridgeService`: drop the boot pre-create `coordinatorFor(DEFAULT_DOMAIN_ID)`; `operatorDomain()`
  FAIL-CLOSED (`string | null`, no `?? DEFAULT`).
- `BridgeServer`: `operatorDomain()` (the `?? DEFAULT` accessor) fail-closed -> the 5 routing methods +
  the register carve-out handle null (no route / refuse); the 3 relay `senderDomainId ?? DEFAULT_DOMAIN_ID`
  (an unregistered sender) -> reject the relay.
- `KubeSecretStore`: RETIRE the v1->v2 migration + the `MIGRATION_OPERATOR_NAME` backfill (clean-break,
  no legacy Secret).
- `TenantAdmin`: the provision/remove guards drop the `=== DEFAULT_DOMAIN_ID ||` half (the marker
  `operatorDomainId()` is the sole guard).
- Delete `DEFAULT_DOMAIN_ID` + every import.
- TESTS (the bulk): `EnrollmentCoordinator` / `KubeSecretStore` / `TenantAdmin` / `BridgeServer.federation`
  / `ConsoleBridgeServer` bun tests construct coordinators with an explicit domainId, set the `isPrimary`
  marker so routing resolves (instead of leaning on the `"home"` default), expect the sanitize-empty
  THROW, and drop the migration + `getActiveEnrollment` tests.

**switchboard:**
- `domain-id.ts`: `resolveLocalDomainId` REQUIRES `FEDERATION_DOMAIN_ID` (throw if unset, no `home`
  fallback); `sanitizeDomainId` rejects empty; keep the evie twin byte-consistent.
- `bootstrap-domain.ts`: key the home slice at the random id (passed in), not `DEFAULT_DOMAIN_ID`;
  `composeFederationJson` / `carryOtherDomain` / `homeSliceOf` key on the operator-home id + keep
  exactly ONE `isPrimary` (a second primary is otherwise reachable - framework finding).
- `provision.ts` / `gateway-setup.ts`: mint a random home id, root it, write `FEDERATION_DOMAIN_ID`
  into the gateway `.env` (compose passthrough already DONE).
- Wire `domainId` posture: keep the schema optional + reject empty at the boundary (the lighter path -
  avoids touching the synced `evie-protocol.ts` leaf) vs make it required in
  `GatewayRegisterParams`/`GatewayRelayRoute`. DECIDE before the sweep.
- Fixtures off the `"home"` literal.

**Android:** `localDomainId()` -> `confirmedDomainId(): String?` (null until a local session confirms);
migrate ALL signing + routing sites onto it (`signSetOperatorName`, `submitXdomainLink` link/revoke,
`EnrollParty`/`trustParty` - not just the rename gate), disabling those surfaces until confirmed;
`renameAwaitsDiscovery = firstRooted && confirmedDomainId == null`; `isHomeOperator` -> the operator
marker/role.

**Acceptance:** `"home"` greps nowhere as a domain id; all 3 runtimes compile + tests green.

## Phase 2 - `operatorName` -> `profileName` (the person) + the "Your Name" gate

Rename the wire field across `schemas.ts` + the 3 synced leaves (re-sync via `sync-leaf.ts`) + codegen
`Protocol.kt` + gateway + Android + evie + scripts + tests. BOTH `setOperatorNameSigningBytes` AND
`provisionTenantSigningBytes` are value-positional over the field, so the preimage bytes are unchanged
BUT the fixture JSON keys + the Kotlin readers re-cut (provision-ops vectors). **Profile name REQUIRED at
provisioning:** the app's import screen gains a "Your Name" field; QR-scan + paste are DISABLED until it
is non-empty; the entered name is carried into first-root and owner-signed, so a person is never
nameless (operator AND guest, each on their own device). The "(unnamed)" placeholder stays ONLY as a
defensive backstop, routed through every person-name render (ChatRepository.kt:886 + the 3 id-leak
sites), NEVER the Domain id. ALSO (owner ask): the conversation thread labels the user's OWN rows "you"
(`ThreadRenderer.kt`, `from = if (m.fromMe) "you" else ...`); thread the local `profileName` into the
renderer (a `selfName` field, set from repo state via `ThreadWebView`) so own rows show the person's
name, falling back to "you" only when empty. The other party's `m.from` (host/session name) stays.

## Phase 3 - re-cut the `home`-bearing SIGNING vector corpora (Phase 1's hidden cost)

THREE cross-runtime signed/hashed corpora embed `domainId:"home"` in the preimage (xdomain-link,
enroll-sas, cross-domain-sas) + the protocol golden fixtures: the VALUE changes, so the bytes change and
the vectors regenerate on BOTH runtimes (TS fixtures + Android `testDebugUnitTest` decoders). Rewrite
`domain-id.test.ts` ("defaults to home" -> "throws when FEDERATION_DOMAIN_ID unset").

## Phase 4 - CLASS 5 fail-closed identity, with caller handling

`ProvisioningStore.loadIdentity` / `loadOwnerIdentity` return a tri-state (Loaded/Corrupt/Absent), not
decode-swallow-to-null. `FederationManager` mints only on Absent, fails closed on Corrupt (never
overwrite) + fp log load/mint. EXEMPT `importOwnerBackup` from the no-overwrite rule (restore is the
sanctioned recovery). Make the Compose composition-time key readers (OwnerKeysCard/Users/Sharing/
ManageScreen) non-throwing (nullable accessor / runCatching) - a throw in composition crashes. Add a
corrupt-key branch to `ConsoleClient.requireConsoleIdentity` (the live sign/seal path reads the store
directly) + `classifyConnError` -> `ConnKind.TERMINAL` "key unreadable - restore backup / re-provision".
Gateway `identity.ts` orphan detector (admission present, no key match -> "regenerated, re-admit").

## Phase 5 - ONE atomic deploy + verify

Phases 0-4 are ONE atomic breaking release across 4 artifacts (evie image, gateway container, APK,
provision script) - they CANNOT land independently. Sequenced clean-break wipe FIRST (delete the whole
`evie-federation` Secret, each gateway `federation-allowlist.json`, the phone identity). Rollout order:
push evie (await Push(main) rollout) -> push switchboard (main-push.yml builds the APK) -> rebuild
gateway -> re-provision -> MANUALLY flash `switchboard-release.apk` onto every console (the in-app
updater is opt-in + only sees the new versionCode after re-provision). Optionally bump
`FEDERATION_PROTOCOL_VERSION` + `CONSOLE_PROTOCOL_VERSION` so an old runtime fails fast. Gates: all 3
runtimes + codegen no-drift + synced-leaf hashes + the smell-check grep (`"home"` not a domain id) + a
SEMANTIC acceptance test (a roster row with empty profileName shows "(unnamed)", not the hex id - the
literal grep gives a FALSE green on the leak) + on-device fresh-provision round-trip.

## Phase 6 - rename the host-agent identity `gateway` -> `host-agent` (FINAL, UNVETTED)

The host orchestrator is hardcoded as the team name `"gateway"` (`mcp/index.ts` `projectName`, reserved
in `websocket.ts` `RESERVED_TEAM_NAMES`, mapped to `kind: "gateway"` by `consoleHandler`), which
collides with the Docker Gateway server. Rename the host-AGENT identity name + the wire `kind` enum
value to `host-agent` across: the gateway (`mcp/index.ts`, `websocket.ts` `from`/reserved,
`consoleHandler`, `routes`, `hostRelay`), the wire (`schemas.ts` `TeamInfo` kind enum + codegen
`Protocol.kt`), and the app (every `kind == "gateway"` check + the `GatewayHeader`/host grouping). The
Docker Gateway server KEEPS its name - only the host-agent renames. NOT YET VETTED: this phase needs its
own gap-audit + red-team pass before implementing. The grind STOPS here.

**Minor (separate, low):** evie `CursorMergePullRequestAction.checkGHCLI` (CLASS 2) returns a hardcoded
"GitHub CLI not found" discarding `gh` stderr - unrelated cursor feature; fix the narrow stderr-surfacing
if/when that area is touched.
