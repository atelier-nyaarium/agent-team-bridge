# Peer UX unification (questionaire in progress)

**Status:** Questionaire lap 3, post deep-analysis. The full team-roster reversal is owner-approved.
Superseded earlier-lap Q/A has been pruned into "Decided so far"; the trail is in Amendment notes (bottom).

## Build progress (audited-implementation cycle)

- **Lap 1 - SAS width cut (12 -> 6 digits): DONE + verified + committed.** SAS_DIGITS 12->6 + SAS_MODULUS
  10^12->10^6 in src/shared/cross-domain-sas.ts AND the Kotlin twin proto/SasCrypto.kt; cross-runtime vectors
  re-cut; CrossDomainLink.kt length gate + LinkWizard.kt grouping (chunked(3), "847 291") + the TS asserts +
  stale 12-digit test literals updated. Gates GREEN: TS lint(biome+tsc) + 655 vitest; Android
  compileDebugKotlin + testDebugUnitTest. Audited (align: 6/6 aligned; red-team: cryptographically sound, P1
  commit-reveal closes the offline grind, cross-runtime parity verified; framework: twin pattern complete).
  Commit f90a1ce (local on main, not pushed).
- **Lap 2 - enroll ceremony (COMPLETE, full 3-runtime build + full audit chain).** Built across evie +
  switchboard + Android, then run through align (12/12 clean) -> red-team (4 confirmed bugs fixed + verified,
  incl. the CRITICAL User-First edge-routing the owner confirmed) -> framework-first (2 extractions) -> docs.
  All gates green both repos; commits local on main, unpushed (the evie rollout + gateway rebuild + on-device
  wire round-trip are the owner's deploy walls). Remaining plan work is lap 3 (the Users roster + share-control
  surface, the deferred laundry, and the final cleanup pass). Implementation order + status:
  - [DONE + verified] **Crypto core (TS):** `ENROLL_SAS_V1` (fixed-slot/role-tagged, owner-anchored) +
    `ENROLL_COMMIT_V1` in src/shared/cross-domain-sas.ts; cross-runtime vectors at
    tests/fixtures/enroll-sas/vectors.json; src/__tests__/enroll-sas.test.ts (13 tests). Injective props pinned
    (role-swap / field-reassign / substitution / pin + domainId binding / role + salt commitment binding). TS
    lint + test GREEN. Distinct version literals so an enroll code is never interchangeable with a gateway code.
  - [DONE + verified] **Crypto core (Kotlin twin):** enroll* mirrored in proto/SasCrypto.kt + EnrollSasTest.kt
    reading enroll-sas/vectors.json + the corpus registered in _signing-vectors-manifest.json. Full Android
    testDebugUnitTest GREEN (twin reproduces the TS vectors byte-for-byte); full TS suite 668 GREEN. Crypto
    core COMMITTED as 2f133e6 (local on main with f90a1ce). The cross-runtime crypto core is DONE on both
    runtimes.
  - [DONE + verified, committed bc17194] **Shared schemas (switchboard, source of truth):** EnrollHandshakeOp
    (commit/reveal/cancel by handshakeId + role, NO pin, NO signature) + EnrollReveal + EnrollHandshakeResult in
    enrollment.ts (synced leaf, re-stamped + copied to evie); EnrollHandshakeRef on ProvisioningSchema (admin
    owner keys + domainId + handshakeId + pin); codegen ROOTS + SEALED_ROOTS + Protocol.kt regenerated. GREEN:
    switchboard lint + 668 tests (codegen-drift + sync-hash) + Android build + evie lint. (evie's enrollment.ts
    copy is staged in the evie tree, committed with the coordinator slice next.)
  - [DONE + verified, evie commit 58784f8] **evie (dumb broker):** EnrollHandshakeCoordinator (in-memory,
    single-replica-safe; relays commit/reveal by handshakeId; R-dos guards = per-window attempt cap charging
    fresh+flood commits, global concurrent-window cap, TTL sweep, role-slot bound to first committer,
    idempotent re-poll); handleEnrollHandshake intake in ConsoleBridgeServer (app-token, pre-admission, like
    handleFirstRoot); onEnrollHandshake wired in BridgeService (always on, no Secret). evie computes NO SAS.
    GREEN: evie lint, EnrollHandshakeCoordinator.bun.test (8), ConsoleBridgeServer.bun.test (29). The synced
    enrollment.ts copy committed with it. (Full evie vitest gate in the devcontainer = a pre-deploy step.)
    >> SERVER/WIRE BACKBONE COMPLETE across both repos (crypto 2f133e6 + schemas bc17194 + evie 58784f8).
  - [DONE + verified, committed 349339f + 248f7d4 + 14b009b] **Android enroll UI + client.** Client
    `ConsoleClient.enrollHandshake` (349339f); pure core `EnrollCeremony.kt` (role pairing, role-ordered SAS,
    commit-reveal verify, QR-pinned admin-key check) + `EnrollCeremonyTest` (7); `ChatRepository` orchestration
    (`buildInviteBlob` mints+embeds the ref, `adminEnrollContext`/`enrolleeEnrollContext`, `enrollExchange`
    commit->poll->reveal->poll->verify->SAS, `enrollConfirm` signs the edge over the CONFIRMED peer domain,
    `enrollCancel`) (248f7d4); `EnrollCeremonyScreen` (shared waiting->compare->done, admin shows the QR,
    enrollee auto-pops post-first-root + a board CTA + a persisted `enrollCeremonyDone` latch) wired into
    MainActivity (14b009b). GREEN: compileDebugKotlin + full testDebugUnitTest + **assembleDebug (R8)**.
    >> ENROLL CEREMONY COMPLETE across all 3 runtimes; the on-device wire round-trip + evie deploy are the
    owner's walls.
    - **Protocol-ordering clarification (vs the map below):** the compare is AFTER reveal, NOT gated on [Yes].
      `ENROLL_SAS_V1` binds the REVEALED owner keys (not the commitments), so both phones must reveal before
      either can compute the code. Flow: commit -> poll peerCommit -> reveal -> poll peerReveal -> verify the
      peer's reveal opens its commitment (enrollee also pins the admin keys to the QR) -> compute SAS -> glance
      compare -> [Yes] signs the link edge. Revealing public owner keys + spent salts to the dumb broker leaks
      nothing; the human [Yes] still gates the only trust commitment (the edge). Original map (kept for history;
      full map in the workflow output tasks/wttde4mg5.output):
    - **Client:** add `ConsoleClient.enrollHandshake(op): EnrollHandshakeResult` mirroring `ConsoleClient.enroll`
      / `firstRoot` (POST to evie's /relay with the app-token bearer; body `{ enrollHandshake: <EnrollHandshakeOp> }`;
      decode `EnrollHandshakeResult`). NO sealing (pre-admission, like firstRoot).
    - **Admin QR gen (hook in `ChatRepository.buildInviteBlob`):** mint handshakeId + pin
      (Base64(SecureRandom)), add `enrollHandshake = EnrollHandshakeRef{adminOwnerSignPub, adminOwnerBoxPub,
      adminDomainId, handshakeId, pin}` to the blob; shown via the existing `QrImage`/`QrCode` on
      `HostNetworks.HostedTenantDetailScreen`. Admin keys from `FederationManager.ownerIdentity()`.
    - **Enrollee hook (in `ChatRepository.firstRootIfPending`):** AFTER first-root succeeds, if
      `prov.enrollHandshake` is set, enter the ceremony UI with the parsed `EnrollHandshakeRef`.
    - **Ceremony (both sides, mirror `LinkWizard` commit-reveal + `VerifyStep`):** mint salt;
      `SasCrypto.enrollCommitment(party, role, salt)` -> POST Commit -> poll (re-POST) for peerCommitment;
      `SasCrypto.enrollSas(adminParty, enrolleeParty, pin)` LOCALLY -> show the 6-digit code + the [Yes]/[No]
      compare (reuse the LinkWizard 6-digit display, but a GLANCE compare not typed - per the design); on [Yes]
      POST Reveal (EnrollReveal{ownerSignPub, ownerBoxPub, domainId, salt}) -> poll for peerReveal -> verify
      `SasCrypto.enrollCommitment(peerReveal..) == peerCommitment` LOCALLY; then BOTH owner-sign a
      `SignedXDomainLinkEdge` to the peer's Domain over the EXACT confirmed (domainId, keys) (R-edge, no re-fetch)
      via `FederationManager.signXdomainLinkEdge` + submit `submit_xdomain_link`; on [No]/timeout POST Cancel.
    - **Roles:** ADMIN = showed the QR (the HostedTenantDetail side), ENROLLEE = scanned. Build verifies with
      `assembleDebug` + `testDebugUnitTest`; the on-device wire round-trip is the owner's wall.
  - [DONE] **Lap-2 align audit (12-dimension Workflow fan-out, run wf_64308a7f):** 12/12 ALIGNED, 0 gaps. Vetted
    against the plan + the red-team build requirements: R-pre (fixed-slot role-tagged ENROLL_SAS_V1, TS+Kotlin
    byte-identical, vector-pinned), R-edge (edge signed over the EXACT verified peer domain + the enrollee's
    pendingTenant domain, no localDomainId re-fetch), R-dos (all 5 evie guards present + tested), dumb-broker
    (no SAS/pin/commitment-verify at evie; cross-domain-sas.ts NOT synced), pin-OOB (absent from every frame),
    commit-reveal binding, QR-pin admin auth (enrollee-only expectedPeer), edges-only trust (no admission, no
    gateway-peer write), glance compare, NO migration/legacy code, codegen no-drift + sync-hash match, roles +
    stable per-invite handshake secrets. Nothing to fix.
  - [DONE] **Lap-2 red-team (12-angle adversarial Workflow + verify, run wf_eb1abd19):** 9 angles CLEAN
    (relay-MITM residual sound, coordinator-races none, commitment-hiding sound, edge-domain-confusion none,
    android-poll-failure graceful, pin-multiguess one-shot, error-oracle opaque, role-slot first-committer
    DoS-only/in-model, first-root-before-ceremony ordered). 4 issues fixed (see red-team-fix):
    - **(CRITICAL, owner-confirmed: User-First) evie edge-op routing.** `dispatchEnrollOp` ran every
      `submit_xdomain_link`/`revoke_xdomain_link` against the HOME coordinator, whose `addLinkEdge` rejects any
      edge with `srcDomainId != home`. So a gateway-less ENROLLEE's edge (src = its first-rooted tenant Domain)
      was refused -> one-way trust, and a user with NO gateway could never record their half. Fix: route an edge
      op to `coordinatorFor(edge.srcDomainId)` (evie already vivifies a rooted coordinator for any first-rooted
      Domain, gateway or not). Surfaced by the red-team's first-root dimension + confirmed live by the owner.
    - **(HIGH) cancel-dispose-race.** The ceremony's DisposableEffect unconditionally `enrollCancel`s on leave,
      deleting the whole broker window; if A confirms + leaves before B polls A's reveal, B is stranded (A->B
      edge only). Fix: skip the dispose-cancel once this phone has CONFIRMED (a decline/walk-away still cancels).
    - **(HIGH) premature-latch.** The LinkedNoRelay "Later" button latched `enrollCeremonyDone`, so a relay-edge
      reject permanently killed the enrollee re-offer. Fix: "Later" routes to onCancel (dismiss, no latch); only
      a real Done (Linked) latches.
    - **(MEDIUM) double-confirm edge accumulation.** Each `enrollConfirm`/retry minted a fresh edge nonce, so a
      lost-ack retry accumulates duplicate edges at evie. Fix: pin one edge nonce per ceremony (the link path's
      same non-pinned-retry issue is laundry-listed).
    - **All 4 fixes VERIFIED** (6-agent fix-verify, run wf_4e362680): every finding resolved, zero regressions,
      including a security re-check of the new evie edge routing (shouldVivifyCoordinator blocks vivify-DoS;
      addLinkEdge still owner-verifies against the srcDomain's rooted key, so no cross-Domain write) and the
      regression sweep (link wizard unchanged; no missed callers; no migration code). Gates green: switchboard
      compile + testDebugUnitTest + assembleDebug (R8); evie 44 bun tests + biome + tsc. Commits: evie 97f8c1e,
      switchboard c83ecd4.
  - [DONE] **Lap-2 framework-first audit (8-dimension Workflow, run wf_4864cc05):** 1 LEAVE (edge-confirm-
    outcome thin/justified), 5 DEFERRED to the lap-3 Users-surface rework + cleanup (they will rework this UI
    anyway), 2 acted NOW (see framework-fix):
    - **(NOW) Shared ceremony UI primitives.** `Busy` / `InfoSurface` / `grouped(code)` were duplicated between
      LinkWizard and EnrollCeremonyScreen (I introduced the second copy). Extract to one shared place and point
      both screens at it. The higher-level panels (LinkedNoRelay/Failed) keep their per-ceremony copy (divergent
      copy + the onLater latch difference; lap-3 reworks them).
    - **(NOW) Shared SAS reduction kernel.** The digest -> first-8-bytes-BigInt -> mod 10^6 -> pad-6 reduction is
      byte-identical across crossDomainSas + enrollSas in BOTH runtimes; extract a private reducer per runtime so
      the 6-digit width lives in one place (vector-pinned, so a regression breaks the cross-runtime tests). The
      PREIMAGE builders stay specialized (the audit surface).
    - **Both NOW chunks DONE + verified (commit 694bf4e):** shared Busy/InfoSurface/grouped in Federation.kt (both
      ceremonies point at the one copy); reduceToSas private kernel in SasCrypto.kt + cross-domain-sas.ts. Gates
      green: TS lint + 668 tests (cross-domain-sas + enroll-sas vectors byte-for-byte preserved); Android
      testDebugUnitTest (the Kotlin twin still reproduces the vectors) + assembleDebug (R8, UI extraction holds).
    - **Deferred to lap-3 (laundry):** (a) **nonce-pinning convention + a LATENT BUG** - signProvisionTenant /
      signRemoveTenant are idempotent at evie (dedup by operatorSignPub+nonce) but ChatRepository calls them with
      NO pinned nonce, so a network-hiccup retry mints a fresh nonce and creates a DUPLICATE provision/remove at
      evie instead of replaying. Pin those nonces (the enroll edge path already does). (b) rendezvous-broker seam
      (EnrollHandshakeCoordinator vs the gateway CrossDomainHandshakeCoordinator). (c) ceremony-context factory
      unification. (d) evie onEnrollOp table-driven dispatch. (e) the holistic dual-ceremony-wizard scaffold (the
      crypto cores stay justifiably separate; the UI scaffold is the real extraction, folded into lap-3).
  - [TODO] **Users roster unification UI + share-control** (the original peer-ux core; the design-pass mockups):
    large Compose; separate from the enroll ceremony.
  - [TODO] **Then:** the Users roster unification UI + share-control surface (the original peer-ux core; large
    Compose). Deploy (evie rollout + gateway rebuild) + on-device round-trip = the final owner-coordinated steps.
- **Lap 3 - Users surface (IN PROGRESS, owner: "build it all out, debug issues as they come").** A 4-phase
  multi-runtime feature (wire -> evie -> gateway -> Android). Owner decisions this lap: (a) build all phases now,
  do NOT wait on the lap-2 deploy/validate (debug later); (b) **NO SAS fork** - keep the two existing 6-digit
  flows (enroll owner-anchored glance-compare + user-to-user typed), do NOT build a unified hybrid derivation.
  Phase-1 gap (run wf_866e52b2, vs the lap-2 baseline): the owner-keyed trust edge (`XDomainLink`, both owner
  keys, in federation-protocol.ts) + the owner-anchored SAS (`enrollSas`) ALREADY exist. Net-new Phase-1 wire
  shapes: an owner-keyed UNTRUST tombstone (mirrors XDomainLink, gateway-persisted, evie never sees it), a
  cross-tenant ROSTER op (name + presence + fingerprint + own-gateways; NO gatewayId/key in a row), a
  PENDING-TRUST op (arm/cancel/poll, keyed by target owner key, TTL + rate-limit, no token/gatewayId exposed), a
  DISCRIMINATED share target ({kind:domain}|{kind:everyone-trusted}), an anti-rollback monotonic snapshot
  VERSION on DomainSnapshot (snapshot-derived, not separately signed), and a console-PRESENCE "absent" value +
  the Android else->ended fold fix. Then Phase 2 evie (roster aggregation, console rendezvous, pending-trust
  store, cross-owner snapshot relay, owner-key index, presence), Phase 3 gateway (ForeignOwnerKeyring +
  owner-anchored seal/unseal, central everyone-I-trust gate, all-sessions overview), Phase 4 Android (the Users
  screen, arm+highlight trust, share control, consent rails, wording). The FINAL slice = the cleanup pass.
  - **Lap-3 PROGRESS (resume point for a fresh instance):**
    - [DONE, commit 8db8021] **Untrust tombstone.** `XDomainUntrust`/`SignedXDomainUntrust` + signing-bytes
      (`XDOMAIN_UNTRUST_V1`, owner-keyed: myOwnerSignPub + peerOwnerSignPub + revokedAt + nonce) + sign/verify in
      `src/shared/federation-protocol.ts`; Kotlin twin in `crypto/XDomainLinkCrypto.kt` (untrustSigningBytes/
      signUntrust/verifyUntrust); cross-runtime vector in the `xdomain-link` corpus (`untrust` key); TS tests
      (xdomain-link.test.ts + xdomain-link-edge.test.ts); Kotlin tests (XDomainLinkTest.kt); emitted to Kotlin as
      a codegen ROOT (`SignedXDomainUntrustSchema`). The console op carrying it + the gateway tombstone handler
      land in the gateway phase. THIS IS THE PATTERN for any new signed scheme: schema+signing in the right
      shared file -> gen vector from the TS ref with the corpus's fixed key -> Kotlin twin -> codegen ROOT (or
      nest in an op) -> TS + Kotlin tests -> manifest if a NEW corpus.
    - [NEXT] the remaining Phase-1 shapes - each is interconnected with its evie/gateway/Android producer, so
      prefer CONNECTED slices over wire-only stubs: console-presence "absent" value on `TeamInfoSchema.status`
      (closed enum) + the Android status fold; the monotonic snapshot VERSION field on `DomainSnapshotSchema` +
      the applySnapshot refusal gate (gateway `Allowlist` + Android `FederationManager.applyDomainSync`); the
      DISCRIMINATED share target ({kind:domain}|{kind:everyone-trusted}) on `CrossDomainShareEntry` + the share
      ops; the cross-tenant ROSTER op (new EnrollOp/ConsoleOp variant + a stub handler until Phase 2); the
      PENDING-TRUST op (arm/cancel/poll, keyed by target owner). Existing landmarks to reuse: `XDomainLink`
      (owner-keyed link already exists), `enrollSas` (owner-anchored SAS already exists), `cross_domain_unlink`
      (domain-keyed; the untrust is the owner-keyed sibling), `crossDomainShareState` (the share store).
- **OWNER DIRECTIVES (standing, channel):** (1) **NO migration / back-compat / coexistence code anywhere** -
  the owner is WIPING evie from scratch, so build for the END STATE only (e.g. do not add token<->admission
  coexistence shims, old-format readers, or version-straddling branches in any NEW code). (2) The **FINAL
  implement-phase (last slice) includes a dedicated CODE CLEANUP pass**: rip out dangling/unused code, any
  existing migration code, and legacy landmines across the touched surface (the clean-break the wipe enables).
- **Deferred laundry (non-blocking, tracked, NOT bundled into the width-cut commit):** global per-(requester,
  receiver) attempt cap [the per-token cap resets on re-listen; locus = evie/console-bridge, NOT the gateway
  coordinator]; confirm() consumes the pairing before validating (poor error recovery, fails closed);
  defensive SAS-width zod bound; injective/fixed-slot SAS preimage hardening + a committed leading-zero
  vector. Full detail lives with the implementing agent's notes.

## Enroll-ceremony architecture (lap-2 analysis - RESOLVED: evie-resident)

**Scope decision (owner): C - full 3-runtime build.** Build the whole enroll ceremony across evie + switchboard
+ Android, updating the evie repo as needed; only critical-stop for a real blocker. The evie image rollout +
gateway rebuild + the on-device wire round-trip (R8/minify gate) are the final OWNER-COORDINATED steps (a
device + a cluster deploy are the only walls); everything else is built and locally unit-verified first.


A 5-angle cross-repo analysis (switchboard + evie) resolved WHERE the FLOW-1 enroll commit-reveal compare
plumbs. Consensus (4/5 agents; the lone "gateway-reuse" dissent ignored that the fresh enrollee has NO gateway):

- **The enroll handshake MUST live at EVIE, not the gateway.** A fresh enrollee has just first-rooted and is
  reachable ONLY via evie's poll-based console-bridge (no gateway, no WS). The gateway's
  `CrossDomainHandshakeCoordinator` needs a gateway-minted listening token + synchronous gateway_relay
  routing - incompatible with a gatewayless poll client. This MATCHES the owner's existing **D1** ("build
  console-to-console Trust NOW... server-resident evie rendezvous... PORT the coordinator defenses").
- **Build a new `EnrollHandshakeCoordinator` in evie** (parallel to TenantAdmin, ~400-600 LoC): window state
  persisted in the K8s federation Secret (survives an evie restart mid-ceremony), keyed by
  (adminOwnerId, enrolleeConversationId)/handshake-nonce; ports the gateway coordinator's defenses
  (single-flight, attempt cap 5, TTL, replay, and the per-relationship rate-limit the gateway lacks - the
  laundry-listed global cap naturally lands HERE); new console-bridge ops `enroll_commit`/`enroll_reveal`
  surfaced to the enrollee via the poll mailbox.
- **NO SAS in evie; NO SAS synced leaf** (corrected after the design red-team). Because evie is a DUMB BROKER
  and the PHONES compute the SAS, evie never computes any SAS - so `cross-domain-sas.ts` stays switchboard-only.
  The ENROLL SAS is a NEW owner-anchored derivation living in switchboard (the TS reference for
  vectors/tests) + the Android `SasCrypto.kt` twin (the real phone-side compute), pinned by a NEW cross-runtime
  vector corpus - exactly like the existing gateway SAS, no synced copy. evie only needs the enroll handshake
  FRAME schemas (to relay opaque commit/reveal blobs keyed by handshakeId) - those live in `enrollment.ts`
  (already a synced leaf).
- **Scope = 3 runtimes + an evie deploy.** evie (the coordinator + ops + Secret persistence + the synced
  leaf), switchboard (the shared `enroll_*` op schemas + a consoleHandler relay arm + the enroll-QR payload:
  admin ownerSignPub + handshake nonce, ~+155 bytes / +4 QR modules, measured-fine), Android (the 5-frame
  enroll UI + the commit-reveal client + owner-signing the admission on mutual [Yes]). Building+testing needs
  NO deploy (both repos have test gates); RUNNING it needs an evie image rollout + the gateway rebuild + an
  on-device wire round-trip (the R8/minify gate).
- **PROTOCOL CORRECTION (from reading the real code - the analysis was optimistic):** evie is UNTRUSTED at
  enroll (the entire reason the 6-digit compare exists is to catch an evie substitution - closing D4). So:
  - **evie is a DUMB BROKER, it does NOT compute the SAS.** If evie computed + returned the SAS it could just
    hand both phones matching codes and MITM silently. evie only relays the commit then reveal frames (keyed by
    a `handshakeId`), enforcing single-flight + attempt-cap + TTL + a per-(adminDomain, enrolleeConv) rate cap.
  - **The PHONES compute the SAS locally** (SasCrypto / the synced crossDomainSas core) over the keys each
    actually holds, and verify the peer's reveal against the peer's commit locally. The humans compare. A
    substituted enrollee key yields a mismatch; commit-reveal stops evie grinding it (evie must commit its
    substitution before it learns the real key); the 6-digit residual holds.
  - **The pin rides in the QR (OOB), and is NEVER sent to evie** - both phones fold it into the SAS, so evie
    cannot even compute a candidate code to grind. (Sharper than the gateway path, where evie relays a sealed
    pin.)
  - **Owner-anchored SAS preimage (NET-NEW vs the gateway's gateway-keyed preimage):** the enroll SAS binds
    BOTH owners' keys (ownerSignPub + ownerBoxPub + domainId) + the pin, NOT gateway keys (the enrollee has no
    gateway). This is a NEW derivation with its OWN cross-runtime vector corpus (TS + SasCrypto.kt twin),
    sibling to crossDomainSas. The 6-digit reduction + commitment algebra are reused; only the preimage fields
    change.
  - **Trust output = the EXISTING cross-Domain link edges, not a new admission.** The enrollee first-roots
    their OWN Domain (existing first_root), so admin + enrollee are two Domain owners; on mutual [Yes] each
    owner-signs a `SignedXDomainLinkEdge` to the other's Domain (existing `submit_xdomain_link`). The handshake
    is PURELY the key-confirmation ceremony; first_root + link edges are existing machinery.
- **DESIGN RED-TEAM VERDICT (6 angles): core SOUND, build requirements baked in.** Relay-two-session DEFEATED
  (the OOB QR admin-key + the evie-unknown pin make A's and E's codes diverge under any evie substitution),
  pin-secrecy SOUND, commit-reveal-with-active-broker SOUND (synchronous commit-before-reveal per leg). Three
  build requirements (no protocol break):
  - **(R-pre) Fixed-slot, role-tagged ENROLL_SAS_V1 preimage** (not flat-sort): `ENROLL_SAS_V1 \n ADMIN \n
    ownerSignPub_A \n ownerBoxPub_A \n domainId_A \n ENROLLEE \n ownerSignPub_E \n ownerBoxPub_E \n domainId_E
    \n pin`, with a sibling `ENROLL_COMMIT_V1` fixed-slot commitment. Net-new, so built injective from the
    start (closes the field-role-reassignment the gateway flat-sort is only saved from by its commitment).
  - **(R-edge, was HIGH) Close the confirm->sign gap:** the XDomainLinkEdge binds domainIds, NOT owner keys.
    So domainId MUST be a committed field in the ENROLL_SAS preimage (it is), AND each phone signs its
    SignedXDomainLinkEdge over the EXACT locally-confirmed (domainId, keys) it computed the SAS over - NEVER a
    value re-fetched from evie post-confirm. Chain: SAS confirms the (key,domain) pair -> phone signs edge to
    the confirmed domain -> first_root guarantees that domain is owned by that key. (Defense-in-depth option,
    laundry: also carry the peer ownerSignPub in the edge.)
  - **(R-dos, was HIGH) evie coordinator guards:** per-(handshakeId) attempt cap (5) + per-(adminDomain,
    enrolleeConv) rate cap + handshakeId idempotency (dedup retries) + an UNGUESSABLE handshakeId + each
    role-slot bound to its FIRST committer (anti-hijack). The global per-relationship cap (lap-1 laundry) lands
    HERE.
  - The pin appears in NO frame (excluded from the commit/reveal schemas by construction); phones verify the
    peer commit + compute the SAS locally; evie computes nothing.
- **Open implementation forks (recommended defaults, not blockers):** (D5) the handshake nonce rides IN the QR
  as a one-time invite (like the pendingTenant nonce), so the 6-digit SAS stays the ONLY out-of-band signal;
  the enroll handshake frames are phone-minted, NOT owner-signed (only the resulting admission is signed - no
  5th signing scheme); rate-limit + attempt-cap live INSIDE the evie coordinator keyed on
  (adminDomainId, enrolleeConversationId); the enrollee authenticates the pre-admission handshake with its
  console-bridge bearer token (it has no admission yet, by definition).

## Vision

Splice the Federation screen's split sections - GUEST NETWORKS (host/invite a friend) and PEERS (link +
per-session share) - into ONE surface: a roster of your network's members. Tap a person to act on them.
"Trust this person" replaces "Link". Names always visible; sessions private by default, shared selectively.

## Decided so far

Roster + visibility:
- **Full team roster** (lap-3 Q1=A, re-confirming lap-2 Q1=B). Every member of your network is visible by
  name to every other member, INCLUDING two friends you host who do not know each other - so you can tap a
  person to act on them. This is the owner-approved, scoped, NON-transitive reversal of isolated-by-default
  (names only; never transitive to peers' peers). A fresh red-team is required before build.
- Names public, **sessions private by default** (lap-1 Q1b). Each member shares selectively (work shared,
  personal kept private).
- **Console-only members are VISIBLE only** in the first build (lap-3 analysis): a member with no gateway has
  no key to seal to and no route to send a cross-Domain op, so trusting/sharing-TO them is the
  separately-deferred gateway-bootstrap piece. Their status dot = console presence (not a gateway).

Trust (was "Link"):
- **Rename Link -> Trust** (channel). "Trust this person." Also avoids the "Peer" wording category error.
- **Both-present commit-reveal SAS, launched from a roster row** (lap-2 Q2=A). No unsolicited inbound: the
  other side still explicitly arms its own window. The find-each-other code-swap dance goes; a **6-digit
  (2 groups of 3) symmetric SAS compare STAYS** as the one anti-tamper check (UNIFIED across enroll + Flow 2;
  see the Decision update).
- **Compact SAS** (lap-1 Q3): shrink the chrome only. UPDATE: the in-person ENROLL ceremony IS now a
  glance-compare ([Yes]/[No] "these should match"); the remote user-to-user Flow 2 keeps the typed match (read
  + enter), because the parties are not co-present. Interaction model is per-context, not one global form.
- Per-row **overflow (kebab) menu** (lap-1 Q4): Trust (untrusted) / Manage shares (trusted) / Untrust. **NO
  Rename in the kebab** (D3=A - the admin cannot sign a rooted user's name). A user renames their OWN name in
  their Profile (self-rename, `set_operator_name`). See the SELF-RENAME-ONLY note in the Design pass.

Share:
- Two modes (channel steering, replacing the old "public"): **share with specific people** OR **share with
  everyone I trust** (dynamic - all current AND future trusted people; auto-revoked on untrust). Clearly
  labeled. "Everyone I trust" is bounded to your trusted/linked set, never the world.

Entry + wording:
- **The host action ("Enroll/host a friend") is operator-gated** (isHomeOperator); the roster + the Trust
  actions are NOT gated, so a guest can still trust/share.
- **Standing note (user):** vet every string for on-screen-context clarity as it is rewritten; apply the
  federation-wording discipline (cut what the title/section already says).

## Analysis (lap 3 - deep multi-repo: switchboard + evie-bot + nyaaskills)

Method: an 8-agent dynamic workflow (trust, wire/codegen, evie routing, link FSM, share model, Android
UX/wording, console presence, nyaaskills coupling) + a direct read of the security-critical code. Findings
converge; corrections to the lap-1 audit noted.

### Code-confirmed invariants (the floor the design sits on)
- Isolated-by-default is STRUCTURAL at evie: `handleListGateways` returns only gateways in the caller's OWN
  Domain as `{gatewayId, online}`, no operatorName, and an unregistered caller sees nothing (evie
  BridgeServer.ts:823-837). `gatewayConnections` is partitioned per Domain (106-109).
- A guest/tenant is its OWN Domain rooted at its OWN owner key on the friend's phone (first_root). So
  "members of your network see each other" is a genuine CROSS-Domain name disclosure between
  mutually-isolated owners, not an intra-Domain tweak.
- The link is strictly GATEWAY-to-GATEWAY commit-reveal SAS-AKE: the receiver opens a listening window +
  mints a token `<gatewayId>.<random>`, the requester routes by the token's gateway-id prefix, a 12-digit
  type-to-match SAS over the committed keys+pin, attempt-capped at 5, each owner owner-signs an XDOMAIN_LINK
  edge (crossDomainHandshake.ts). evie routes by GATEWAY id, never Domain id.
- Cross-Domain share is per-`(sessionTarget, toDomainId)` plain state on the OWNING gateway's volume, gated
  LIVE at access time by `isSharedTo` (crossDomainShareState.ts; hostRelay gate). Only devcontainer/loose
  kinds are shareable. The relay denies a non-shared op with ONE byte-identical error (no existence/kind oracle).

### Corrections to the lap-1 audit
- The per-peer share-toggle UI IS built (Federation.kt ShareRow/ShareCheck/setCrossDomainShare). "Manage
  shares" is largely a re-skin + the new mode, not net-new.
- The dynamic "everyone I trust" share is nearly FREE on the gateway. [SUPERSEDED by Red-team lap 1 - FALSE:
  the share store + all 5 read sites are domain-keyed exact matches with zero peer awareness, and Q4 re-keys
  trust to OWNER identity. It is net-new gateway work (discriminated target + a central gate helper +
  owner->Domain-set resolution + an across-domains expiry). See Red-team rank 14/15.]
- The roster membership LIST may be DERIVABLE from the DomainSnapshot the console already polls. [SUPERSEDED
  by Red-team lap 1 - FALSE: a DomainSnapshot is ONE owner's slice; co-hosted guests are separate isolated
  Domains, so your poll contains zero bytes about them. The roster needs a net-new cross-tenant evie
  aggregation op. See Red-team rank 1/2.]

### Hard blockers (load-bearing, must decide)
- A console-only member is UNLINKABLE + un-shareable-TO today: no gateway means no peer record
  (CrossDomainPeerSchema needs friendGatewayId/Sign/Box), no seal box key, and no route to send a
  cross-Domain op. The design note's "console-only linkable + consuming" IS the separately-deferred unbuilt
  gateway-bootstrap piece. First build: console-only = VISIBLE only.
- "Peer" as the unifying noun is a wording category error: federation-wording.md reserves Peer = a network
  you have LINKED; the roster includes un-linked members.
- Name source: admissions carry NO name field. A signed name = ADMISSION_V1->V2 churn (synced leaf + vectors
  + evie + Kotlin). An unsigned name (gateway TeamInfo.team + console device label) is cheap and spoofable
  but carries no trust weight.
- Presence for a console-only dot has NO signal + NO wire field today (status enum closed to
  {online,available}); it needs new evie console-presence state.
- Launch-from-roster must NOT auto-arm the receiver (no passive surface): the receiver still explicitly arms
  its own window; the SAS type-to-match stays whole (compact = render-size only).

### Coherence flags
- federation-management-ux.md + several plans are still in stale "Switch"/"arbiter" vocabulary; map to the
  CODE (post-rename), not the prose.
- federation-wording.md says "nothing changed yet" but GUEST NETWORKS etc already shipped; diff against the
  shipped strings.
- owner-broadcast-consoles.md needs an evie owner index (ownerKeyId); the roster needs the same - build once.

## Questionaire (lap 3 - post deep-analysis, re-anchored on the "trust this person" steering)

**Q1. Who appears in the list?** -> A, FULL TEAM ROSTER (user: "A. Full roster so you can actually tap on the
person."). Everyone in your network is visible + tappable, including co-hosted guests who do not know each
other. Confirms the owner-approved cross-Domain name disclosure; boundary assumed = the members on your evie
(you + your hosted guests), non-transitive; the red-team is required before build.

**Q2. How does the other person come into a Trust?** -> Mainly B with A's no-prompt (user: "Mainly B, sorta
A's no prompt. We are arming a trust back feature. It will remain on the Trust screen though (no unsolicited
pings), just highlighted that user's row somehow."). Tapping Trust on someone's row ARMS your side and posts
a pending trust-back; the target sees the requester's row HIGHLIGHTED on their own Trust screen (NO push /
unsolicited ping - the signal lives only on the Trust screen), explicitly taps it back to arm, then the
12-digit SAS compare runs on both. Preserves no-auto-arm + the both-present SAS.
  - Design/red-team notes (consequences): (1) a "pending trust" state must be stored server-side (evie) and
    surfaced as a per-row flag; (2) routing the handshake to the target's gateway must resolve SERVER-SIDE
    (do NOT expose a gatewayId/key in the roster row - that would be a seal/probe handle); (3) the pending
    request needs a TTL (mirror the listening-window expiry) + a rate-limit so pending markers cannot be
    spammed across rosters; (4) the red-team must bless the on-screen pending marker as non-passive (it adds
    only "X armed trust toward you" over a name already visible in the roster).

**Q3. Console-only members: visible-only vs build Trust now?** -> B, BUILD THE TRUST FOUNDATION NOW (user:
"B. Right, Trust IMPLIES a friend system like thing. Foundation has to be built now not later. In the
immediate implementation, it essentially provides them nothing but a friends list. It has more meaning when
Gateways are added later."). Trust is a persistent friend edge between PEOPLE, recorded now even when a
member is console-only (it yields only a friends list until they add a gateway).
  - IMPLICATION (forces the crypto re-anchor, Q4): the shipped link binds GATEWAY keys (CrossDomainPeerSchema,
    the SAS reveal, the XDomainLink edge), so it cannot record a trust edge for a gateway-less member. A
    friend-system foundation requires re-anchoring the trust edge on OWNER identity.

**Q4. Re-anchor Trust on owner identity + accept the metadata compromise?** -> A, YES (user: "A it is!").
The crypto design (now decided):
  - **Trust edge = owner-to-owner.** The SAS (which already carries both owners' keys) pins the two OWNER
    keys; each owner signs "I trust owner B". No gateway in the edge, so it is recordable now, even
    console-to-console. The AES-256-GCM / X25519 seal CIPHER is UNCHANGED - only the identity binding +
    key-distribution change (small risk surface).
  - **Late gateways are free.** When B adds a gateway, B's owner signs a `kind:gateway` admission; A (having
    pinned B's owner key at the SAS) learns B's current gateways from B's owner-signed snapshot, relayed by
    evie but verified under B's owner key (evie cannot forge it). No re-trust ceremony.
  - **"Share with all trusted" needs NO group crypto.** Traffic is interactive/pairwise (a peer reaches INTO
    your session), so each engaging peer seals PAIRWISE to your gateway as today. "All trusted" is purely the
    share GATE answering yes for any currently-trusted owner, resolved LIVE at access time. No group key, no
    broadcast cipher, no re-keying on membership change.
  - **"Share the session, not the gateway" is preserved.** The seal secures the transport; ACCESS is gated
    per-session AFTER unseal (only shared sessions, only devcontainer/loose kinds). Trust grants ZERO
    sessions by itself. The target session name is inside the sealed payload, so evie cannot see which
    session a peer reached.
  - **Accepted compromise = METADATA, never content.** evie sees the social graph (names, presence,
    who-hosts/trusts-whom, traffic timing) and can withhold / stale-replay or (for unsigned fields) mislabel,
    bounded by the SAS at trust-time + owner-signed messages/revocations. It can NEVER read content, forge a
    message, or escalate a lie into a fake trust.
  - Implementation note: console-to-console Trust (no gateways) needs the SAS to route over the
    console-bridge transport (new) rather than gateway-relay; the commit-reveal logic is reused.

**Q5. Member names: owner-signed/verified or evie-served?** -> B, EVIE-SERVED + RENAMABLE (user: "B is fine.
Let the person rename their profile if they want. Fingerprint and topology explains a lot about a person.").
Names are unsigned, evie-served (cheap), and the person renames their own profile freely. The REAL identity
signals are the owner FINGERPRINT (the SAS digits, surfaced on the row) + the network TOPOLOGY (their
gateways); the cryptographic trust STATUS disambiguates a forged/duplicate name (a fake "Nyaarium" shows as
untrusted = red flag; an imposter cannot fake sealed shared content).
  - Consequence (good): unlocks the CHEAP roster path - the membership LIST derives from the DomainSnapshot
    the console already polls; no ADMISSION_V1->V2 churn, no name pinning at trust.
  - Design note: surface the owner fingerprint on a peer row (the verifier the user relies on), and show a
    trusted peer's gateways/topology as the recognition aid.

**Q6. Boundary + the unifying noun/screen name?** -> Boundary CONFIRMED (roster = the members on your evie,
non-transitive). Noun = A, USER-CENTRIC -> "Users" (user: "Roster is members yes. A. User-centric. You can
call them 'Users' instead of 'Your people'. Just sounds cleaner."). The merged screen/section is "Users";
each row is a user; trusted users get a "Trusted" badge + their fingerprint. Verb stays "Trust". Drops the
"Federation"/"Peers"/"Networks" jargon. Exact strings get vetted in the wording pass.

**Q7. Where does sharing live + the default path?** -> A, SESSION-CENTRIC + a central overview (user: "A. But
you need to also include in the trusts section of settings a way to see all sessions and share settings.").
One share state, surfaced three ways: (1) PRIMARY - on a project/session, a control Private / Everyone I
trust / Specific users (the per-project person-picking dance is gone; Everyone-I-trust is one tap, Specific
opens a picker for the low-key one-to-one); (2) a CENTRAL "all sessions + share settings" overview in the
Users section (audit + manage every session's share state in one place); (3) a read-only per-user "what X can
see from me" view from the row's kebab. All three edit/read the same per-session share state.

## Plan (consolidated v2 - lap-3 questionaire + Red-team lap-1 + D1/D2 resolved)

> NOTE: the **Design pass** + the **Decision update** below are the LATEST UX truth and SUPERSEDE the UX
> specifics in these phases where they differ - notably: the verification code is **6 digits, 2 groups of 3
> (`847 291`), UNIFIED** across both flows (not 4/8/12); trust splits into **two flows** (admin-enroll now
> ENDS in a mutual 6-digit [Yes]/[No] compare that CLOSES D4 + user-to-user 6-digit SAS); **there is NO
> Rename** (D3=A - users self-rename only); and there are **no "whose-network" labels**. A future build should
> reconcile the phases below against the Design pass + Decision update.

Headline: re-anchor Trust gateway-to-gateway -> OWNER-to-OWNER (Q4). The seal CIPHER is unchanged, but this is
a net-new key-distribution + identity subsystem, NOT a binding tweak (Red-team theme 2). HYBRID SAS: keep the
gateway box key IN the SAS when a gateway exists at trust time (today's strong human-verified binding,
unchanged); the owner-signed-snapshot path is ONLY for LATER-added gateways. Order: wire -> evie -> gateway ->
app, gated by the red-team. CLEAN-BREAK migration (D1): existing gateway-anchored peers re-trust after the
re-anchor lands; no lazy on-disk migration.

**Phase 0 - Red-team.** Lap 1 DONE (67 confirmed findings, folded in above). Lap 2 re-audits this revised plan
+ the now-in-scope console rendezvous + consent rails. Build is gated on it.

**Phase 1 - Wire shapes. THREE separate signed schemes, each owing a versioned signing-bytes fn + a vectors
corpus + a Kotlin twin + a `_signing-vectors-manifest.json` line:**
- The owner-to-owner trust EDGE (the trust decision; binds the two OWNER keys, SAS-verified) + an owner-signed
  UNTRUST tombstone (mirror revoke_xdomain_link, issuedAt floor) so untrust fails closed locally.
- SAS_V2: owner-anchored, gateway-OPTIONAL. Keeps the gateway box key in the preimage WHEN a gateway is
  present (hybrid); for a gateway-less party the seal anchor is the console/owner box key. Re-cut
  cross-domain-sas.ts + SasCrypto.kt + the cross-domain-sas vectors.
- Owner-signed MONOTONIC snapshot version (anti-rollback): applySnapshot refuses an older version; revocations
  MERGE, never drop. A vector proves an applied revocation survives a later older-snapshot apply.
- "Everyone I trust" = a DISCRIMINATED share target ({kind:'domain',domainId} | {kind:'everyone-trusted'}),
  NOT a sentinel.
- The cross-tenant roster op shape + the pending-trust op shape (server-side routing, no gatewayId/key in a
  row). Pin the console-presence representation (a new absent value vs a separate optional field; fix the
  Android else->ended fold).
- Regenerate Protocol.kt; re-stamp + cp the synced leaves; run BOTH the evie gate and the LOCAL Android build
  (testDebugUnitTest, then assembleRelease - CI compiles neither Kotlin nor evie's in-container vitest).

**Phase 2 - evie (the net-new server pieces; "cheap/derive" struck).**
- A NET-NEW cross-tenant roster op (membership + names + presence): the data is in evie's Secret but no serve
  path exists. Scope by the admitted-console SIGNATURE (bind caller -> Domain); SEPARATE
  operator-enumerates-tenants from guest-sees-co-tenants; OPAQUE-REJECT on absence; poll-rate ceiling. evie
  (not the phone) is the source of truth for the hosted-tenant list. Field allowlist: name + presence +
  fingerprint + their-own-gateways; strip host/guest topology (non-transitive covers TOPOLOGY).
- The console-to-console rendezvous (D1=A): a server-resident listening-window store keyed by a console-minted
  handle / owner key (NOT a gatewayId), correlate two consoles' POSTs to one window, the receiver learns a
  pending commit via its poll cycle, and PORT the coordinator defenses (single-flight commit-then-reveal,
  attempt-cap=5 counted-before-check, window TTL, per-(requester,target) rate-limit, replay guard). Prove evie
  holding ordering state cannot reorder/replay to grind the SAS.
- The pending-trust store (arm + highlight): keyed by TARGET owner key; TTL; rate-limit key
  (requesterOwner,targetOwner) + an aggregate per-requester cap; opaque-reject; idempotent re-arm;
  clear-on-cancel/expire. HARD RULE: a roster tap mints NO token + exposes NO gatewayId + makes NO frame
  routable; the receiver's "no open window" stays the SOLE admission gate.
- The cross-owner snapshot RELAY (the late-gateway key-distribution): a NEW evie -> peer frame carrying a
  trusted owner's owner-signed kind:gateway admission set to its trusted peers (the foreign ownerSignPub is
  the verification key, never evie-asserted).
- The evie owner-key index (owner -> {live gateway conns, console presence}) the roster + arm-routing need;
  converge with the owner-broadcast ownerKeyId index (build once). Decide retention + deletion-on-leave.
- Console PRESENCE authority = the GATEWAY (the only node that admission-verifies a console): timestamp
  liveness on each opened sealed frame, publish for its own-Domain consoles, flow cross-Domain via the
  owner-signed gateway-verified path, TTL to absent. (If schedule slips, ship dot-less and add later.)

**Phase 3 - gateway.**
- A NET-NEW ForeignOwnerKeyring: store trusted OWNER roots (from the SAS); accept an evie-relayed foreign
  owner snapshot; verifyAdmission/Revocation under the FOREIGN owner key (distinct from the single-owner home
  allowlist that refuses foreign roots). Resolve a peer's CURRENT gateway box key at seal time from it, gated
  by the anti-rollback version.
- Seal/unseal: the box key used at seal AND unseal MUST chain to a kind:gateway admission verified under the
  SAS-pinned owner key (re-checked at resolution; never from an unsigned field). Define the UNSEAL verify-key
  lookup + the SealedBody peer-CLASS for an owner-anchored peer (a derived owner -> current-gateways index
  feeding resolveCrossByGateway, or a v3 class). Hybrid: a gateway present at trust time keeps its SAS-pinned
  key as the bootstrap until the first snapshot arrives.
- Trust DECISION reads the LOCAL owner-edge ONLY (fail-closed on delete); the relayed snapshot is a key
  FRESHNESS hint for an already-trusted owner, never the grant.
- "Everyone I trust": ONE central isSharedTo(sessionTarget, srcDomain, isTrusted) helper routing ALL read
  sites (gate, discovery filter, reply-drop, sweep); map an inbound srcDomain -> trusted OWNER (one owner may
  run several Domains); expireBySessionAcrossDomains for off-everyone/untrust teardown; per-session
  devcontainer/loose kind gate intact.
- Back the central all-sessions share overview (Q7); for multi-gateway owners, define the aggregation
  (per-gateway, or fan-out over the owner's own gateways) - converge with the owner index.

**Phase 4 - Android (the "Users" surface).**
- The Users screen (replaces Federation's split sections): MY NETWORK card + the Users roster (name +
  presence dot + Trusted badge + fingerprint; console-only users visible + FULL trust endpoints per D1).
  LazyColumn + a per-row kebab (a NEW pattern; the app uses long-press today). An untrusted row renders the
  name MUTED (trust state dominant); a console-only Trusted row is an inert friends-list entry.
- The arm+highlight Trust flow + the compact SAS (commit-reveal + the 12-digit type-to-match kept WHOLE,
  chrome shrunk only). The SAS_V2 SasCrypto.kt twin. Show the fingerprint at the SAS moment so a forged-name
  lure still hits the out-of-band compare.
- Session-centric share control (Private / Everyone I trust / Specific users) + the central all-sessions
  overview + the read-only per-user "what X sees" view. "Everyone I trust" copy scoped to reachable-gateway
  owners; show the current trusted set at the one-tap moment.
- Consent rails (D2=A): notice-and-accept at hosting, a guest self-set/blank roster name, an appear-in-roster
  opt-out, a "who can see me" audit/revoke.
- Wording (Q6): roster entry = "User" (never "member"/Member*); retire the live "Federation" title + the
  "Peers" subheader; reconcile operatorName's three rename surfaces. Vet against the SHIPPED strings.
- Build gate: assembleRelease + an on-device register/poll/seal round-trip for the changed sealed ops.

**Merge sequencing (rank 31):** deploy evie Phase 2 + confirm the snapshot relay + roster ops are LIVE before
merging Phase 3 gateway consumers to switchboard main (the gateway restart is a non-selective git pull of
main). Gate new gateway code on an evie-capability check so an un-upgraded evie degrades to no-op.

## Red-team (lap 1) - findings, adopted refinements, and open owner decisions

An 18-angle adversarial plan red-team, each finding verified against the ACTUAL CODE by an independent
skeptic: 84 raised, 67 confirmed, 9 blockers. The DESIGN is sound but the COST MODEL was wrong in three
load-bearing places, and several security-critical mechanisms the plan named in one line are net-new
subsystems. Full corpus: workflow run wf_d190f27b-078.

### Root-cause themes (the 7 the findings collapse into)
1. The roster's "derive from the polled DomainSnapshot, no new evie op" premise is FALSE. A snapshot is ONE
   owner's slice; co-hosted guests are separate isolated Domains. The roster REQUIRES a net-new cross-tenant
   evie aggregation op (membership + names + presence) that inverts the per-Domain partition. The single
   biggest mis-size. (ranks 1, 2)
2. The SAS re-anchor is a net-new crypto subsystem, not a binding tweak. Moving gateway box keys OUT of the
   human-compared SAS re-roots box-key trust in an evie-relayed owner-signed snapshot, which needs: a
   per-foreign-owner keyring (none exists; allowlist is single-owner + refuses foreign roots), a new
   cross-owner snapshot-relay frame (domain_update is owner-self-scoped + applyDomainSync rejects a foreign
   root), an owner-signed MONOTONIC anti-rollback version (applySnapshot is an unconditional replace; a
   stale-replay resurrects a revoked key = CONTENT break, not metadata), a seal/unseal-time
   verify-against-the-SAS-pinned-owner gate, an owner-edge UNTRUST artifact (so untrust fails closed),
   migration of existing gateway-keyed peers, and a v1/v2/v3 SealedBody class rethink. (ranks 1, 3, 4, 8, 9,
   10, 18)
3. Console-to-console Trust is NOT "reuse over a new transport." The SAS preimage hard-binds 3
   gateway-mandatory fields a gateway-less party lacks (needs a new SAS_V2 + vectors + Kotlin twin), AND the
   console-bridge is poll-based, push-less, gateway-terminating, stateless - no rendezvous/listening window
   and NONE of the commit-reveal defenses (single-flight, attempt-cap, rate-limit, replay), which all live in
   the gateway coordinator. (ranks 5, 6)
4. The pending-trust arm/highlight flow (Q2) is unbuilt and not yet blessable: no store, no TTL, no working
   rate-limit KEY (the existing throttle keys on a dstGateway the roster-tap withholds, and fans out to the
   whole roster), no server-side owner->gateway index, no marker idempotency/clear-on-cancel. (ranks 11, 12,
   13, 21, 22, 33)
5. The roster reverses per-Domain isolation into a cross-Domain PERSONAL-DATA disclosure with no consent /
   audit / revoke / moment-of-change surface: a co-hosted guest is named (under a HOST-typed name they never
   approved) + presence-tracked to strangers; untrust does NOT remove a hosting-derived row; evie becomes a
   cross-owner social-graph data controller. (ranks 7, 19, 25, 26, 36)
6. Wire/codegen/R8/build obligations under-enumerated and in the exact lane CI does not gate (three separate
   signing-byte schemes + vectors + Kotlin twins; the closed status enum + the Android else->ended bug; the
   assembleRelease + on-device round-trip the build steps never name; non-phase-granular gateway deploy).
   (ranks 17, 24, 31, 32)
7. Wording: "member" is a RESERVED code term (an admitted keyring entry / Manage Gateways); do not reuse it
   for a roster row - extend Q6's "User". "Everyone I trust" must be scoped to reachable-gateway owners.
   (ranks 28, 29, 30, 34)

### Adopted refinements (folded into the design; no owner input needed)
- HYBRID SAS (the key risk-reducer, rank 4): KEEP the gateway box key IN the SAS for any gateway present at
  trust time (today's human-verified seal-key binding, unchanged), and use the owner-signed-snapshot path
  ONLY for LATER-added gateways. Shrinks the new crypto subsystem's blast radius and migrates existing links
  for free.
- Trust DECISION is the LOCAL owner-edge (fail-closed on local delete); the evie-relayed snapshot is only a
  key-FRESHNESS hint for an already-locally-trusted owner, never the trust grant. Untrust = delete the local
  edge + an owner-signed UNTRUST tombstone (mirror revoke_xdomain_link, issuedAt floor).
- Anti-rollback: owner-signed MONOTONIC snapshot version + refuse-if-older + revocations MERGE (never drop),
  with cross-runtime vectors. Phase 1.
- Roster = net-new cross-tenant evie op (strike "derive/cheap"): scope by the admitted-console signature;
  separate operator-enumerates-tenants from guest-sees-co-tenants; opaque-reject on absence; poll-rate
  ceiling; converge with the owner-broadcast ownerKeyId index (build once); evie (not the phone) is the
  source of truth for the hosted-tenant list.
- "Everyone I trust" = net-new gateway work (strike "nearly free"): a discriminated share target, ONE central
  isSharedTo(target, srcDomain, isTrusted) helper routing ALL read sites, owner->Domain-set resolution at the
  gate, and expireBySessionAcrossDomains for the untrust / off-everyone teardown.
- Pending-trust spec (concrete): evie store keyed by TARGET owner key; rate-limit key
  (requesterOwner,targetOwner) + an aggregate per-requester cap; TTL; opaque-reject; idempotent re-arm;
  clear-on-cancel/expire. HARD server rule: a roster tap mints NO token, exposes NO gatewayId, makes NO frame
  routable - handleIncomingCommit's "no open window" stays the SOLE admission gate (no unsolicited surface).
  The marker carries ZERO trust weight (fingerprint + SAS is the gate; a forged marker still hits the
  out-of-band compare).
- Consent rails: notice-and-accept at hosting ("X and the people they host may see your name + online
  status"); a guest can self-set/blank their roster name; an appear-in-roster opt-out; a "who can see me"
  audit/revoke; surface that evie sees the graph. (Names stay public-by-default per Q1b, plus these rails.)
- Field allowlist for a guest's roster row: name + presence + fingerprint + their-own-gateways only; strip
  host/guest topology (non-transitive covers TOPOLOGY, not just names); never source from
  crossDomainPeers.all() or discover().
- Build gates: name the assembleRelease + on-device register/poll/seal round-trip for every changed sealed
  @Serializable op; SEQUENCE THE MERGES (evie Phase 2 live before Phase 3 gateway consumers land), since a
  gateway restart is a non-selective git-pull of main.
- Wording: roster entry = "User" (never "member"/Member*); retire the live "Federation" title + "Peers"
  subheader; reconcile operatorName's three rename surfaces; scope "everyone I trust" copy to
  reachable-gateway owners; a console-only Trusted row reads as an inert friends-list entry.

### RESOLVED OWNER DECISIONS (lap-1 forks)
- **D1 = A: build console-to-console Trust NOW** (user: "A. now. if we must, I will reprovision."). Q3=B
  confirmed at its true cost - IN SCOPE for v1: a SAS_V2 (owner-anchored, gateway-OPTIONAL, with a
  console/owner box key as the seal anchor for a gateway-less party) + a server-resident evie rendezvous (a
  console-bridge listening-window store + the ported commit-reveal defenses: single-flight, attempt-cap,
  rate-limit, replay). Console-only members are FULL trust endpoints, not visible-only.
- **D2 = A: names public-by-default (Q1b) + consent rails** (user: "A."). IN SCOPE: notice-and-accept at
  hosting ("X and the people they host may see your name + online status"), a guest self-set/blank roster
  name, an appear-in-roster opt-out, a "who can see me" audit/revoke, and surfacing that evie sees the graph.
- **Reprovision accepted** (user: "if we must, I will reprovision."): RESOLVES the migration blocker (rank 9).
  A CLEAN BREAK is acceptable, so the re-anchor does NOT need a lazy on-disk migration of existing
  gateway-anchored peers - require a re-trust (re-provision) after the re-anchor lands; recovery is already a
  documented clean-break.

## Red-team (lap 2) - the v2 refinements verified; the 6 remaining specs to land before build

A second 12-angle adversarial red-team of the REVISED plan, each finding code-verified: 71 raised, 55
confirmed. **Verdict: the core architecture is SOUND** (owner-to-owner re-anchor, hybrid SAS,
local-edge-as-sole-trust-gate, anti-rollback intent, consent rails as committed scope) - the lap-1
refinements landed, and most surviving findings are SPEC-PRECISION + COMPLETENESS on net-new, not-yet-built
subsystems, not design contradictions. The adversarial verify even CORRECTLY downgraded an over-claimed
"rotation re-opens substitution" blocker to minor (forbidding override would contradict the owner-signed
design - a rotation IS authoritative via the owner signature). Six blockers remain, all resolvable here at
the planning altitude. Full corpus: workflow run wf_b0ea408f-f67.

### The 6 blockers + their adopted resolutions (fold into the phases)
- **B1 (rank 1) - the roster op's caller->Domain authz has no surface at evie.** evie receives only
  `{opId, signerSignPub, sealed, ...}` and NEVER verifies signerSignPub (the GATEWAY does, via consoleSealer +
  its box key). RESOLUTION: the roster request is a NEW evie-direct op carrying the console's owner-signed
  `kind:console` admission + a fresh proof-of-possession (mirroring `verifyRegistration`/`firstRoot`'s
  self-signature). evie verifies the OWNER SIGNATURE on the admission (a public-key check - NO box key needed)
  to bind caller -> Domain, then scopes the roster to that Domain. This is the ONLY path that also works for a
  console-only (gateway-less) member. Note the metadata posture: evie verifies a signed-but-cleartext body.
- **B2 (rank 2) - the console-to-console rendezvous must NOT put the commit-reveal ordering oracle inside
  evie** (the content-blind adversary the SAS exists to defeat; the SAS preimage is non-injective, so timing
  IS the defense). RESOLUTION: keep single-flight OFF evie - ONE console mints the window and is the
  authoritative state-holder (accepts exactly one inbound commit, rejects the second); evie stays a dumb
  relay/mailbox. Invariant: commitments + the SAS are computed PHONE-side; only salted commitments + ciphertext
  transit evie. Add a console-to-console twin of `cross-domain-mitm.test.ts` driving the attack through a
  hostile evie store.
- **B3 (rank 3) - "anti-rollback version" has no signed home** (today's `version()` is an UNSIGNED content
  hash; DomainSnapshotSchema has no version field). RESOLUTION: a NET-NEW owner-signed envelope - a MONOTONIC
  integer counter inside a versioned preimage (`DOMAIN_VERSION_V1\nownerSignPub\ndomainId\nversion\nnonce`),
  owner-incremented + signed on every Domain mutation, verified under the SAS-pinned/home owner key BEFORE
  refuse-if-older. This is a FOURTH signed scheme (its own signing-bytes fn + vectors + Kotlin twin + manifest
  line); it must cover the FOREIGN-owner snapshot (the real stale-replay surface). Keep the content-hash
  `version()` only as the cache-skip token (rename it).
- **B4 (rank 4) - notice-at-hosting has no fire-point** (first-root is automatic, evie-direct, headless on the
  next `connect()`). RESOLUTION: the notice-and-accept dialog fires on the guest's blob-IMPORT screen (BEFORE
  `provision()` persists); Decline aborts. The accept is recorded as NEW connect-FSM state that
  `firstRootIfPending` reads and refuses to first-root without. Not a cosmetic dialog - a precondition gating
  the automatic first-root.
- **B5 (rank 5) - console-only members have no presence authority** ("gateway = presence authority" is
  self-contradictory for a gateway-less member). RESOLUTION: presence is GATEWAY-attested for gateway-backed
  members, and EVIE-attested for console-only ones - evie timestamps liveness on each relayed `console_relay`
  frame keyed by the cleartext signerSignPub (the only id it reads), bound to a Domain via the admissions evie
  already holds, TTL-to-absent. Explicitly evie-attested (unsigned, stale-replayable within the SAS bound),
  consistent with the Q4 "evie sees presence" compromise, and NEVER a trust input. If deferred, ship
  console-only rows dot-less and SAY SO (not buried in an "if schedule slips" aside).
- **B6 (ranks 6/8/9 - major, consolidated) - the seal-key precedence across the two key sources is unstated +
  self-contradictory.** RESOLUTION (one Phase-3 precedence spec): the SAS-pinned box key is AUTHORITATIVE for
  its `(domainId, gatewayId)` for its LIFETIME; a relayed snapshot may only ADD box keys for gatewayIds NOT
  present at trust time, NEVER override a trust-time-pinned key. A rotation (same gatewayId, new boxPub) is
  authoritative via the OWNER signature (owner-signed admission, anti-rollback-versioned), NOT snapshot
  freshness - so reword the Phase-3 "until the first snapshot arrives" line accordingly. FAIL CLOSED if neither
  source yields a key (never guess/fall through). The gateway-less seal ANCHOR = `ownerBoxPub` (stable across
  console reinstalls; matches the owner-edge; the phone holds its priv, so console-to-console seal is
  phone-to-phone, no gateway involved) - and it MUST be a committed field in the SAS_V2 preimage so the human
  compare covers the actual seal key.

### Two consolidated specs the audit asks for before vectors freeze
- **SAS_V2 preimage (ranks 7/8):** before cutting ANY vector - bump the domain-sep literal to SAS_V2 /
  SAS_COMMIT_V2; make the preimage SELF-DESCRIBING + fixed-shape (role-tagged per-party blocks or fixed slots
  with an explicit absent-marker) carrying a gateway-present/absent DISCRIMINANT + the chosen anchor key in a
  canonical slot, so absent-field aliasing, multiset reassignment, and anchor-type DOWNGRADE are all
  impossible (today's flat 10-field sort cannot do this safely). Vectors for all combos (gw/gw, gw/none,
  none/none) + a present-vs-absent-differs + a within-party-reassignment negative + a V1-vs-V2 no-collision.
- **Codegen/cross-runtime checklist (theme 5):** every wire/schema change owes - signing-vectors corpus +
  manifest line (for a signed op), a `tests/fixtures/protocol` golden fixture + `_manifest.json` entry (for a
  ConsoleOp/result), a synced-leaf re-stamp+cp (the owner-edge + untrust tombstone land in the SYNC-HASH leaf
  `enrollment.ts` as new EnrollOp members), Protocol.kt regen, and the assembleRelease + on-device round-trip.
  Anti-rollback (B3) is the FOURTH signed scheme. Fix the Android `else -> "ended"` fold to map unknown
  presence values to a neutral state BEFORE introducing any new presence value.

### Consent rails re-phasing (theme 4) - move the server halves to Phase 2
The enforceable half of three of four rails is server-side, so they cannot ship Phase-4-Android-only: the
roster-visibility OPT-OUT field + filter, the who-can-see-me audience query, and the notice-accept gate all
move to Phase 2 evie with a DEFAULT-SAFE (not-in-roster) posture + an evie-capability gate (so an un-upgraded
evie degrades the rail to safe-default, not a leak). The opt-out also interacts with roster-armed trust:
define whether an opted-out guest stays arm-trustable to the host who provisioned them (recommended) or the
opt-out also removes the trust-arm surface. HostNetworks must drop its local-store name read (evie is the
source of truth) so the host does not see two names for one guest.

### Conclusion
Close these 6 (+ the two consolidated specs + the consent re-phasing) and the plan is BUILD-READY. The
remaining minor/nit tail is checklist tightening that folds into Phase 1 WITHOUT further red-team rounds
(the lap-2 verdict's own finding). Plan-refinement has CONVERGED: lap 1 (67 findings, design-level) -> lap 2
(55, spec-level) -> the surviving items are all named with adopted resolutions above.

## Design pass (DesignSync mockups - claude.ai/design project "switchboard-peer-ux")

### Decision update (2026-06-23) - enroll mutual-compare + unified 6-digit SAS (SUPERSEDES 4-digit, 12-digit, FLOW-1 auto-trust)
Owner-locked this session, over the channel + terminal:
- **ONE verification code, 6 decimal digits, 2 groups of 3 (`847 291`), UNIFIED** for BOTH the enroll ceremony
  and the user-to-user Flow 2. Replaces the earlier 4-digit (Flow 2) and 12-digit (cross-domain) split.
  Rationale: a yes/no COMPARE has no typing cost, so length is "free" on the happy path; the real ceiling is
  human RUBBER-STAMPING, which rises with length, while the crypto residual is already negligible past ~6
  digits. 6-dec is the shortest code that clears a sane floor AND the most-practiced compare pattern (OTP
  muscle memory), decimal avoids hex glyph ambiguity, and it stays visually distinct from the 16-hex identity
  fingerprint. Considered + rejected: 8-hex (more glyphs, letter/digit ambiguity, looks like a short
  fingerprint) and keeping 12 (over-built, worsens rubber-stamping).
- **FLOW 1 (enroll) now CLOSES D4** by ending in a mutual compare instead of silent auto-trust. After the
  in-person QR scan, evie nudges BOTH phones to a confirm screen showing the SAME 6-digit code; each taps
  [Yes, match] / [No]. Both Yes -> the admin<->user trust edge commits. Either [No] or a timeout -> evict the
  half-formed edge, both reset, redo the scan. Nothing is trusted until both confirm.
- **NON-NEGOTIABLE build constraint:** the enroll compare MUST ride the EXISTING commit-reveal handshake
  (crossDomainHandshake), bootstrapped by the QR. A bare compare over the final keys is OFFLINE-GRINDABLE in
  ~milliseconds at ANY length (evie picks substituted keys to collide the two codes). With commit-reveal the
  router must commit its substituted keys before learning the peer's, collapsing the attack to one blind
  online guess per single-flight window: ~1-in-1,000,000 at 6 digits (re-pairings separately capped). This is
  why the in-app fingerprint glance was insufficient and the mutual compare is the real fix.
- **QR size is a NON-ISSUE (measured this session).** The enroll QR adds the admin owner sign-pubkey (44 b64
  chars) + a handshake nonce; total ~2614 bytes -> QR v38, 169x169 modules, vs today's fresh provisioning QR
  at 2459 bytes -> v37, 165x165. That is +155 bytes / +4 modules per side, SINGLE frame, 339 bytes of headroom
  under the v40 ECC-L cap (2953). The blob is dominated by the cluster caPem (1120) + saToken (948) = 2068
  bytes; the identity fields are noise. The "Copy code instead" button carries the identical payload as the
  camera-less fallback. (To meaningfully shrink the QR later, the lever is gzip-ing caPem/saToken or fetching
  them out-of-band, never the identity fields.)
- **Interaction model is per-context** (not one global gesture): in-person enroll = glance [Yes]/[No] compare;
  remote Flow 2 = typed read-and-enter of the same 6-digit code (symmetric per rank-8). Both share the one
  SAS_V2 derivation.

Confirmed live with the owner while iterating HTML mockups (these translate to Android Compose at build):
- The screen is **"Users"**. The admin action is **"Enroll a user"** - NOT "Host a friend" / "Invite": it is
  in-person (no email invite), and "enroll" matches the codebase's existing enrollment terminology. Admin-only.
- **Vocabulary: ADMIN** (the network operator/owner) vs **USER** (a person given app access; a network member).
  Prefer these over operator/member in the UI.
- **Q1=A RE-CONFIRMED concretely** (the Nyaarium-vs-Kashia dual view): a plain USER sees ALL co-members on the
  network by name even before trusting them; trust is per-person (not inherited); enroll is admin-only. On the
  user's view the admin-only Enroll button is HIDDEN entirely (no explanatory text).
- Roster rows are **PEOPLE (users), never devices** (a device name like "Aqua" is not a roster entry).
- **Do NOT surface "whose network" to users** (owner: "no point specifying it; it's clearly the admin's k8s
  cluster"). Drop "Nyaarium's network" / "on your network" / "on this network" from the UI; the identity area
  is just the person + fingerprint (no "Your network" header). A user implicitly belongs to the admin's
  cluster; it needs no label.
- Cards: `admin-vs-user` (the dual view IS the roster, both sides + the pending trust-back state, e.g. "Mira
  wants to trust you" on Kashia's side; replaced the duplicate `users-roster`), `trust-ceremony`,
  `enroll-flow`, `kebab-menu` (per-row overflow: a USER's trusted-person menu = Manage shares / Untrust; the
  ADMIN's menu adds Rename; untrusted = Trust), `share-control` (the Q7 surface: an all-sessions overview with a per-session state chip -
  Private / Everyone I trust / Specific - plus the per-session picker "Who can reach this session?" with
  Private / Everyone I trust / Specific people + a checkbox user list; a not-yet-trusted person shows "trust
  first", greyed; framing "your agents stay yours, this only lets a trusted person collaborate on this one
  session").
- Untrusted roster rows show PRESENCE ONLY (online/offline); NO "not trusted" text - the Trust button +
  missing badge already convey it (trustedness was on the row twice).
- **ONE real name per user; SELF-RENAME ONLY; NO proxy/alias names anywhere** (owner: never approved a
  private-username store; D3=A). A user's display name (operatorName) is set by the ADMIN as the BOOTSTRAP
  label at enroll (provision_tenant), then RENAMED ONLY by the user themselves (the shipped self-rename =
  `set_operator_name` signed by the user's OWN owner key, FederationManager.signSetOperatorName). Post-root the
  user is the SOLE writer; the admin CANNOT rename a rooted user (Red-team lap-3 rank 1 - operatorName is signed
  by the user's own root, not the admin's). So the per-row **KEBAB has NO Rename for anyone**: trusted-person
  menu = Manage shares / Untrust; untrusted = Trust. A user renames their OWN name in their Profile, never
  another user's. This SUPERSEDES + REJECTS every earlier "Rename-local-label / per-viewer alias / proxy name /
  admin-rename" mention (incl. lap-1 Q-RENAME-LABEL): no such store, no admin-rename op, ever.

### Trust splits into TWO flows (owner refinement)
- **FLOW 1 - Admin enroll** (a new user NOT yet in the system): the new phone (Kashia) scans the ADMIN's QR
  off the admin's screen, IN PERSON. That one scan provisions her phone (Evie / console-bridge creds) and
  first-roots her Domain. The QR carries the admin's owner sign-pubkey + a handshake nonce, so it ALSO seeds a
  commit-reveal trust handshake. The instant she scans, evie nudges BOTH phones to a confirm screen showing
  the SAME 6-digit code; each taps [Yes, match] / [No]. Both Yes -> the admin<->user trust edge commits. Either
  [No] or a timeout -> evict the half-formed edge, both reset, redo the scan. This mutual compare is what
  CLOSES D4 (replacing the earlier silent auto-trust): the in-person QR authenticates the admin->user leg, the
  6-digit compare authenticates the user->admin leg, and commit-reveal makes the short code grind-resistant.
  (The QR is a one-time, in-person bearer secret; the trust step reuses crossDomainHandshake. `enroll-flow` card.)
- **FLOW 2 - User-to-user** (both already enrolled, typically REMOTE): two existing users trust each other via
  the **6-digit** temp VERIFICATION code (a per-ceremony MITM check, NOT an identity) - SAME derivation as the
  enroll code. SECURITY: with commit-reveal + single-flight, an active MITM gets ONE blind online guess per
  ceremony window = ~1-in-1,000,000 at 6 digits (re-pairings separately capped; see rank-9). This is the arm +
  on-screen-highlight + safety-code flow (`trust-ceremony` card).
  - Safety-screen UX: framed as "give your code". A card labeled **"Your verification code"** (reusing the
    Users-card chrome) shows your 6-digit code; TAP-TO-COPY (the Users-page identity card is tap-to-copy too).
    Because the parties are REMOTE (no glance-compare), the other-code input is 6 TYPEABLE digit boxes + a
    PASTE icon to the right (manual; no auto-check). The code is SYMMETRIC (both sides compute the identical
    value, rank-8), so it is an enter-the-same-code COMPARE, not an asymmetric give/type; the paste-block-own
    affordance is DROPPED (a no-op on a symmetric code). No footer / no fingerprint on this screen.
  - **FINGERPRINT vs CODE** (distinct, both kept): the FINGERPRINT (16 chars / 4 groups, stable, on the Users
    page) is a long-lived IDENTITY - how someone recognizes/verifies your key any time (longer so it stays
    collision-safe as a permanent id). The 6-digit CODE is the PER-CEREMONY MITM check, safe to be short
    because commit-reveal + single-flight bound it to one blind online guess (~1-in-1,000,000 at 6 digits). The
    fingerprint is NOT shown on the trust ceremony (the code is the check there); it lives on the Users page
    for recognition. The two are deliberately DIFFERENT alphabets/shapes (16-hex fingerprint vs 6-decimal code)
    so they are never conflated. The `fingerprint()` primitive is **16 chars / 4 groups** (SHA-256 first 8
    bytes) and is EMBEDDED in signed provision-op preimages - do NOT change it (truncating breaks cross-runtime
    signatures). Shown in FULL on the Users page (16 chars / 4 groups, matching the primitive). (Red-team lap-3
    rank 6 fixed an earlier "standardize at 12 chars" crypto trap.)
- **SECURITY DECISIONS (owner-confirmed):** (a) Admin-enroll trust - SUPERSEDED: the earlier "auto-trust,
  accept the persistent evie-substitution residual" is REPLACED by the FLOW-1 mutual 6-digit compare (see the
  Decision update + D4 RESOLVED). evie is no longer trusted to carry the user->admin key unverified; the
  in-person compare catches a substitution. (b) Digit count - UNIFIED at 6 (2 groups of 3) across both flows
  (was 4 for Flow 2 / 12 for cross-domain); with commit-reveal + single-flight the residual is ~1-in-1,000,000
  per ceremony. (c) Flow-2 out-of-band: there is NO in-app direct-message/chat surface in Switchboard (it
  coordinates Claude projects, not messaging), so the codes cannot leak through an in-app channel; they are
  traded out-of-band by nature.
- **QR screen behavior:** show NO expiry countdown text; AUTO-DISMISS the QR ~1 minute BEFORE the token
  timeout, so a put-down phone never leaves a live enroll QR exposed.

## Red-team (lap 3) - the design-pass changes vetted; reconcile before build + 2 owner forks

A 9-angle lap-3 red-team focused on the post-lap-2 DESIGN PASS (4-digit code, two-flow trust, admin-only
rename, no alias), each finding code-verified: 56 raised, 43 confirmed. **Verdict: the design pass is SOUND
IN INTENT and owner-accepted - lap 3 overturns NO owner decision.** But it is NOT build-ready: it is an
OVERLAY the phases below it never reconciled (theme 1), so a builder following the phase checklist would trip
on stale text + orphaned items. Two genuine blockers + reconciliation/precision fixes. Full corpus: workflow
run wf_c656b918-22a.

### Adopted reconciliation + precision fixes (fold into the build; no owner input)
- **6-digit code is a WIRE change, not a display tweak (rank 2, blocker):** the SAS output IS the compared
  value end to end. A Phase-1 bullet folded into the SAS_V2 cut: SAS_MODULUS 10^12->10^6 + SAS_DIGITS 12->6 in
  BOTH cross-domain-sas.ts AND SasCrypto.kt; re-cut tests/fixtures/cross-domain-sas/vectors.json; fix the
  CrossDomainLink.kt length gate (`length != SAS_DIGITS` would SILENTLY REJECT a 6-digit code) + the
  LinkWizard.kt "12 digits" string + the two TS asserts; run the LOCAL Android build (the CI-blind lane).
  (Digit count locked at 6 this session; the enroll ceremony reuses the SAME derivation - see Decision update.)
- **Fingerprint stays 16 chars / 4 groups (rank 6) - NOT 12** (fixed above): `fingerprint()` is signed into
  provision-op preimages; only the rendered display may show fewer groups.
- **Residual is ~1-in-10,000 per ceremony, not 1-in-2,000 (rank 9):** single-flight binds the human to ONE
  committed SAS guess per window; the 5-try cap bounds PIN brute-force, not five SAS guesses (~1-in-2,000
  needs ~5 separate full re-pairings). The owner's 4-digit acceptance STANDS; the number is BETTER than
  stated - just correct the mechanism so a builder does not "fix" it by loosening single-flight.
- **Paste-blocks-own-code is a NO-OP on the symmetric SAS (rank 8):** crossDomainSas sorts both parties'
  fields order-independently, so both sides compute the IDENTICAL code (your code == their code). DROP the
  paste-block-own affordance; reframe FLOW-2 as a symmetric COMPARE (enter the same 4 digits both see), not an
  asymmetric give/type. Decide symmetric-vs-asymmetric for SAS_V2 before vectors freeze (symmetric is the
  natural read).
- **QR auto-dismiss decouple (rank 7):** the enroll nonce TTL is ~24h, so "~1 min before the token timeout"
  never protects a put-down phone. Drive auto-dismiss off a SHORT foreground timer (60-120s of the QR shown),
  independent of the redemption nonce; Phase-4 home; plumb a timing field into the Android display model.
- **Scrub the stale 12-digit / 10^12 / fingerprint-at-SAS strings (rank 4):** Phase 4 "12-digit type-to-match
  kept WHOLE", Decided-so-far, Q2, and any fingerprint-on-the-ceremony-screen. Widen the Plan-v2 NOTE banner
  to also cover Decided-so-far + the Q-block.
- **Presence "offline" (rank 11):** the untrusted-row online/offline requirement reuses the lap-2 B5 absent
  value + the Android else->ended fix - back-reference it, not net-new.
- **Orphaned affordances -> Phase-4 homes (rank 12/15):** mark the lap-1/2 "single SAS" statements
  FLOW-2-specific; tap-to-copy (verification code / identity card / fingerprint - reuse copyToClipboard); the
  FLOW-2 paste action (reuse readClipboard, after the rank-8 resolution).
- **"Whose-network" string scrub (rank 14):** extend the Phase-4 retirement list to "MY NETWORK" / "GUEST
  NETWORKS", not just the two lap-1 strings.
- **SAS_V2 injective preimage is now LOAD-BEARING at 4 digits (rank 10):** the 4-digit width is conditional on
  the self-describing/fixed-slot preimage landing in the SAME cut; the within-party-reassignment negative
  vector is no longer belt-and-suspenders.

### OWNER FORKS (both RESOLVED this session)
- **D3. Admin-rename of a rooted user is cryptographically IMPOSSIBLE as written (rank 1, BLOCKER). RESOLVED =
  A** (owner: "admin cant rename user? then remove the context option") - the kebab **Rename is REMOVED** (no
  admin-rename op built); the admin sets only the enroll BOOTSTRAP label (provision_tenant), and post-root the
  USER self-renames (the sole writer, `set_operator_name`).
  operatorName is renamable ONLY by the target Domain's OWN rooted owner key (the user's). The admin runs a
  different Domain at a different key, so an admin-signed rename is rejected; the admin can only set the
  PRE-root staging label at enroll (provision_tenant), overwritten by the user's first self-rename. So the
  kebab "Rename" has NO buildable backing for an enrolled user. **(A)** admin sets the name ONLY at enroll;
  post-root rename is USER-ONLY; HIDE the kebab Rename for rooted users (clean, matches the crypto, no new op).
  **(B)** build a net-new operator-signed "rooted-tenant-label" override op (a 5th signed scheme + vectors +
  Kotlin twin + a precedence rule) so the admin CAN relabel a rooted user - a deliberate trust inversion (an
  admin overriding a sovereign user's self-set name) that re-opens the "two names for one user" problem. You
  wanted admin-rename via the kebab (B), but it is a real net-new capability with an authority question; A is
  the cheap, crypto-clean default.
- **D4. RESOLVED (2026-06-23) - close it, do not accept the residual.** The persistent-MITM shape was real: a
  durable owner-edge means a key a compromised evie substitutes AT ENROLL becomes the PERSISTENT seal/trust
  root (all future content to the attacker until re-trust), undetectable by the in-app fingerprint glance.
  RESOLUTION: FLOW-1 now ENDS in a mutual in-person 6-digit [Yes]/[No] compare riding the commit-reveal
  handshake (see Decision update + the rewritten FLOW 1). The in-person QR authenticates admin->user; the
  compare authenticates user->admin; commit-reveal makes the 6-digit code grind-resistant (~1-in-1,000,000 per
  ceremony). This removes the single accepted exception to the Q4 "evie can never forge a trust" invariant.
  BUILD NOTE: FLOW-1 still needs its phase home + the QR-seeded handshake wiring (no edge-minting path exists
  today); plan:18's "fresh red-team before build" still applies to the new FLOW-1 ceremony specifically.

## Amendment notes (what earlier laps superseded - kept so the trail is not lost)

- lap-1 "directed/unsolicited link (tap Link -> the target gets an Accept prompt)" -> REVERSED by the lap-1
  audit and lap-2 Q2=A: the link stays both-present, no passive inbound surface.
- lap-1 "the anonymous Show-my-code / Enter-code rendezvous is replaced by the roster" -> NUANCED by lap-3:
  the roster makes who-to-trust discoverable, but the receiver still arms its own window and the SAS compare
  stays; only the find-each-other code swap is dropped.
- lap-1 Q2 / lap-2 Q3 "hybrid + public-to-the-team share" -> RENAMED by channel steering to "share with
  everyone I trust" (bounded to the trusted set, not a true public).
- "Link" verb / "Peer" noun -> RENAMED to "Trust" (channel); "Peer" is reserved for an already-linked network.
- lap-1 rough Plan + lap-1 Audit (the 70-gap STOP) + the A/B/C DECISION-NEEDED fork -> RESOLVED (roster
  reversal approved) and FOLDED into the Analysis section + Decided-so-far above. The audit's load-bearing
  constraints now live in Analysis > "Code-confirmed invariants" and "Hard blockers".
