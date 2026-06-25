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
- **`operator` -> user OR admin by sense; `isPrimary` -> `isAdminDomain`** (owner). "operator" is overloaded:
  the NAME (`operatorName`, every Domain's display label) is a user's name -> `profileName` (Phase 2); the
  ROLE (`operatorDomainId` / `operatorSignPub` / the operator-signed ops / `TenantAdmin`'s guard) is the
  admin who runs evie + provisions others -> `admin*` (`adminDomainId`, `adminSignPub`, admin-ops,
  `runGuardedAdminOp`). The Phase-0 marker `isPrimary` reads like "1 of N", not authority -> `isAdminDomain`
  (this slice IS the admin's controlling Domain), and `operatorDomain()` / `operatorDomainId()` ->
  `adminDomain()` / `adminDomainId()`. (`isAdminDomain` is the proposed word; owner may swap for
  `isAuthority` / `isControlling` - NOT `isRoot`, which already means owner-key rooting.) The role rename
  spans all 3 runtimes + the synced crypto/enrollment leaves (~70 refs) and the wire-stable `*_V1`
  signing-constant strings (`SET_OPERATOR_NAME_V1` etc.), so it rides Phase 2 (field renames) + Phase 3
  (vector re-cut). All a Phase-5 smell-check gate.
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

## Phase 1 - retire `home` -> random hex (THE sweep)

**evie + switchboard DONE + green + committed.** evie `019ed18`, switchboard `316e83d`.
- evie: `DEFAULT_DOMAIN_ID` deleted (0 refs in source), `sanitizeDomainId` throws on empty,
  `EnrollmentCoordinator` ctor requires `domainId`, `shouldVivifyCoordinator` drops the default-vivify,
  `BridgeService`/`BridgeServer` `operatorDomain()` fail-closed (`string | null`: no route / refuse on
  null; an unregistered-sender relay is rejected), the v1->v2 migration + `MIGRATION_OPERATOR_NAME`
  backfill + dead `getActiveEnrollment` removed, `TenantAdmin` guards on the `isPrimary` marker alone.
  ~35 federation/store tests reworked. Lint clean, 242 bridge tests pass.
- switchboard: `resolveLocalDomainId` requires `FEDERATION_DOMAIN_ID` (throws unset), `sanitizeDomainId`
  throws empty, `bootstrap-domain.ts` threads the home Domain id (no hardcoded key), `provision.ts`
  resolves it from the gateway env or mints a random hex on a fresh setup and writes it back via
  `envSet("FEDERATION_DOMAIN_ID", ...)`. Lint clean, 695 tests pass.
- Wire `domainId` posture (was UNDECIDED): kept the schema optional + reject-empty-at-the-boundary path
  (the lighter one; the synced `evie-protocol.ts` leaf untouched).

**Android (REMAINING Phase-1 piece - needs the local Gradle build gate before push):** scope is 5 files,
~29 refs, concentrated in `ChatRepository.kt` (19). Mechanical part: `localDomainId(): String` ->
`confirmedDomainId(): String?` (drop the `?: DEFAULT_DOMAIN_ID` fallback at :1019, return the local
session's domain or null); thread the ~14 callers (`signSetOperatorName` :1059, `submitXdomainLink`
link/revoke :1359/:1372/:1530/:1714, `EnrollParty` :1397, `trustParty` :1576, `adminDomainId` :1140,
`mergeLinkedDomains` :1209, the `home` reads :1232/:1957, plus the `operatorDisplayName` :886 display),
GATING every signing site on non-null (no signing with a fallback id) and routing the display to
profileName, not the id; `renameAwaitsDiscovery = firstRooted && confirmedDomainId() == null`; retire
`FriendOnboarding.DEFAULT_DOMAIN_ID`.

MODEL (owner, pending final yes): person = one DOMAIN (trust identity / owner key) who stands up their own
GATEWAYS (machines) under it. "home" conflated Domain and Gateway, which is the whole reason it dies. The
OPERATOR is the evie-runner who provisions other people's Domains; their Domain is the `isPrimary` one on
evie (TenantAdmin already gates provision/remove on exactly that). A guest owns a Domain + its Gateways but
is NOT an operator.

So `isHomeOperator()` (:1027, currently `confirmedDomainId == DEFAULT_DOMAIN_ID`) -> `isOperator()` = "my
confirmed Domain is the primary one." This is OPTION A: evie surfaces its existing `isPrimary` marker onto
the local session (one field on the register reply / `TeamInfo`), the console reads it. NOT "anyone with a
rooted Domain" (a guest is not an operator; showing them the admin = a dead button evie rejects). So this
piece is NOT Android-only: it adds one wire field (`TeamInfo`/register-reply `isPrimary`), codegen, the
evie stamp, and the Android read, on top of the `confirmedDomainId` edits. Gate (mandatory, per CLAUDE.md -
Android broke main twice when skipped): `JAVA_HOME=... ANDROID_HOME=... ./gradlew :app:testDebugUnitTest`.

**Acceptance:** `"home"` greps nowhere as a domain id in SOURCE (test fixtures still carry it as a local
const / literal - cleaned in the Phase 5 smell pass); all 3 runtimes compile + tests green.

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

ALSO rides here (same wire + field churn): the operator-ROLE -> `admin*` rename - `operatorDomainId` ->
`adminDomainId`, `operatorSignPub` -> `adminSignPub`, the operator-signed ops + `runGuardedOperatorOp` +
`TenantAdmin`'s "operator" -> admin, and the Phase-0 marker `isPrimary` -> `isAdminDomain`. See the
operator/primary locked decision for the full scope + the `*_V1` constant note (Phase 3).

## Phase 3 - re-cut the `home`-bearing SIGNING vector corpora. DONE.

The three corpora (xdomain-link, cross-domain-sas, enroll-sas) + the decode-only protocol
fixture were regenerated at `alice` from the real signing/SAS functions (a regen script, not
hand-edited), cross-runtime verified by a forced Android `--rerun-tasks` (the Kotlin twins
re-executed and agree). The provision-ops `SET_DISPLAY_NAME_V1` re-cut rode Phase 2. The `home`
Domain-id sample data was then swept from the switchboard / evie / Android unit tests. The exact
`"home"` literal now greps nowhere as a Domain id; `isPrimary` / `operatorName` / `operatorDomainId`
/ `operatorSignPub` / `SET_OPERATOR_NAME` all gone. Residual is conceptual prose + identifiers
(`homeOwner` var, `home-gw` gateway-id) only.

## Phase 3 (original scope, for reference) - re-cut the `home`-bearing SIGNING vector corpora (Phase 1's hidden cost)

THREE cross-runtime signed/hashed corpora embed `domainId:"home"` in the preimage (xdomain-link,
enroll-sas, cross-domain-sas) + the protocol golden fixtures: the VALUE changes, so the bytes change and
the vectors regenerate on BOTH runtimes (TS fixtures + Android `testDebugUnitTest` decoders). Rewrite
`domain-id.test.ts` ("defaults to home" -> "throws when FEDERATION_DOMAIN_ID unset").

The operator-role rename also shifts the wire-stable `*_V1` signing-constant strings (`SET_OPERATOR_NAME_V1`
etc.) in the preimage, so those corpora re-cut HERE alongside the home-bearing ones rather than in a separate
pass.

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
runtimes + codegen no-drift + synced-leaf hashes + the smell-check grep (NONE of these survive: `"home"` as
a domain id; the overloaded `operator` identifier - `operatorName`/`operatorDomainId`/`operatorSignPub`/
operator-ops, all split to `profileName` or `admin*`; `isPrimary`/`primary` as the admin-Domain marker) + a
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
