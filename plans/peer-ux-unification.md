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
      nothing; the human [Yes] still gates the only trust commitment (the edge). (The pre-build implementation
      map was reduced once shipped; the as-built detail is the [DONE] bullets above + git history.)
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
    - [DONE] **ROSTER data path COMPLETE end to end** (the Users surface's plumbing; the Compose SCREEN is the
      only remaining roster piece, Phase 4). Commits: switchboard b67ea89 (wire: RosterRequest/Member/Result +
      the ROSTER_V1 proof in the synced enrollment.ts, codegen'd) + aa46c8d (members optional, absent on opaque
      reject) + 1306545 (the proof Kotlin twin in ProvisionOpsCrypto + a provision-ops vector) + 1bbeee5 (Android
      transport: ConsoleClient.roster + FederationManager.signRosterRequest + ChatRepository.fetchRoster); evie
      05155bd (synced enrollment) + fdec6df (the pure `buildRoster` core + roster.bun.test: full-roster, guest
      sees co-tenant, opaque non-member, revoked console, pending excluded, gateway-key-not-member) + a29314e
      (the I/O: KubeSecretStore.listDomains, BridgeServer.onlineDomainIds, BridgeService.handleRoster with
      proof+freshness+replay, the ConsoleBridgeServer `roster` intake + 4 intake tests). Visibility = Q1 "full
      roster": a console admitted in ANY Domain on the evie sees EVERY rooted Domain (membership-gated, no
      per-row predicate); a row is {ownerSignPub, operatorName, online} only (no gatewayId/box/domainId). To
      render: `ChatRepository.fetchRoster()` returns the `RosterMember` rows.
    - [DONE, commit e938011] **Basic Users SCREEN** (`Users.kt`, `UsersScreen`): fetches `fetchRoster()` and
      renders each member (name + a "you" tag + the owner fingerprint + a presence dot), loading + opaque-reject
      handled; reachable from the Federation hub via a "Users" entry. The RICHER surface is the remaining Phase-4
      work: the Trusted badge + per-row kebab + the arm-trust flow + share control - all of which need the trust
      state RECONCILED onto owner identity (today the local trust/share state is domain-keyed - linkedDomains /
      crossDomainShareState - while the roster + enroll edges are owner-keyed; reconcile before the badge/kebab).
    - [DONE, commit 2e90d47] **Refactor A slice 1 - the owner-keyed friend graph + the Users trust surface.**
      A local, owner-keyed trusted-owners store (`ProvisioningStore` KEY_TRUSTED_OWNERS, `FederationManager`
      trustedOwners/isTrusted/add/remove + `signUntrust`) - the FRIEND graph the Users surface reads, recorded
      even for a gateway-less person (Q3=B), distinct from the gateway relay-affinity edges. Written on every
      completed trust ceremony: `enrollConfirm` (now takes `peerOwnerSignPub`) and `confirmWithMyLink`. The Users
      roster (`Users.kt`) now renders a per-owner **Trusted badge** + a per-row **kebab with Untrust** (drops the
      friend edge + mints the owner-keyed untrust tombstone; an untrusted row shows presence only). `ChatRepository`
      isOwnerTrusted/trustedOwners/untrustOwner. Gates green (testDebugUnitTest + R8). This is the owner-keyed
      trust QUERY the surface needed - the reconciliation the prior [NEXT] flagged is now DONE for the read path.
    - [FLOW-2 COMPLETE end to end across all 3 runtimes] **The Trust button + arm/highlight/compare**
      (roster-initiated user-to-user trust). Honors Q2=B no-prompt + Q4=A owner-keyed + "no SAS fork" (REUSES the
      enroll commit-reveal). Commits: sb 465e7ce/e38e4a2/fb1df0a/ec4220d + evie 41dacb9/d802d7b. The full path
      works: a Trust button on an untrusted roster row arms a rendezvous (sb 3c/3d); the target sees the row
      HIGHLIGHTED with a Respond button (the `fetchPendingTrust` poll, no push); both run the owner-anchored
      6-digit SAS compare (reusing `enrollSas` with sorted-owner-key roles + the rendezvousId pin) via
      `TrustCompareScreen`; a mutual [Yes] records the owner-to-owner friend edge (`enrollConfirm`) and the
      Trusted badge appears. evie is the dumb `TrustRendezvousCoordinator` (indexed by target owner). All gates
      green both repos. Sub-slice detail:
      - [DONE, sb 465e7ce + evie 41dacb9] **Sub-slice 1 - wire ops + PoP.** `TrustHandshakeOp` (arm/join/reveal/
        cancel) + `TrustHandshakeResult` + the target's `TRUST_PENDING_V1` PoP query
        (`TrustPendingRequest`/`Entry`/`Result`) in the synced enrollment.ts; codegen'd (sealed `TrustHandshakeOp`,
        74 Kotlin types); the PoP Kotlin twin in `ProvisionOpsCrypto` pinned by a provision-ops vector with a
        roster cross-check. enrollment.ts re-synced to evie. Gates green (TS 692 + Android + evie).
      - [DONE, evie d802d7b] **Sub-slice 2 - the evie broker + intake.** `TrustRendezvousCoordinator` (dumb broker,
        indexed by TARGET owner; arm creates+indexes, join binds the target slot, reveal relays; attempt +
        per-target + concurrent caps + TTL). `ConsoleBridgeServer` routes `trustHandshake`/`trustPending`;
        `BridgeService.handleTrustPending` verifies the proof + freshness + non-replay. 10 broker tests + 43 bridge.
      - [DONE, sb e38e4a2] **Sub-slice 3a+3b - Android transport + PoP.** `ConsoleClient.trustHandshake` (arm/
        join/reveal/cancel, POST evie-direct like the enroll handshake) + `trustPending` (the highlight query);
        `FederationManager.signTrustPendingRequest` (signs the TRUST_PENDING proof with the OWNER key, since the
        arms index by owner) + `freshRendezvousId`. Compiles + R8.
      - [NEXT - sub-slice 3c+3d: the orchestration + UI] (THE remaining FLOW-2 piece; the whole backend +
        transport are DONE + tested). (c) `ChatRepository` orchestration, MIRROR `enrollExchange` (the existing
        enroll commit-reveal): `armTrust(targetOwner)` = `freshRendezvousId` + this side's commit + POST arm;
        `fetchPendingTrust()` = poll `trustPending` (owner-signed) -> the armed rows; `trustExchange(rendezvousId,
        peerOwner)` = (join if target / re-arm if initiator) -> poll peerCommit -> reveal -> poll peerReveal ->
        verify -> SAS; trust-confirm = `addTrustedOwner(peerOwner)` + `submit_xdomain_link` when gateways exist.
        THE SAS: REUSE `EnrollCeremony.sas`/`SasCrypto.enrollSas` + `enrollCommitment` with the role derived from
        SORTED owner keys (`if (myOwner < peerOwner) ADMIN else ENROLLEE`) so both sides compute the SAME ordered
        code, and `rendezvousId` as the pin. The `EnrollParty` = `(ownerSignPub, ownerBoxPub, domainId)`. (d) Users
        screen: a **Trust** button on untrusted rows -> `armTrust`; a poll of `fetchPendingTrust` -> HIGHLIGHT the
        armed initiator rows (a badge/accent, NO push - Q2=B); tapping a highlighted row joins -> a compare panel
        (REUSE `EnrollCeremonyScreen`'s Compare/reveal UI, or factor its compare panel into a shared composable).
        On a [Yes] match the trusted badge appears (the friend graph already drives it via slice A1).
      Original decided design (for reference):
      - **Rendezvous = a NEW evie target-indexed pending-trust broker** (mirror `EnrollHandshakeCoordinator`, but
        keyed by owner pair + INDEXED by target owner so "who armed trust toward me?" is a cheap query, NOT a QR
        handshakeId). Ops: `trust_arm` (initiator posts {initiatorOwnerSignPub, targetOwnerSignPub, rendezvousId
        (fresh, the SAS "pin"), commitment, sig}, stored under targetOwnerSignPub), `trust_pending` (target
        queries by its owner key -> the armed rows, to HIGHLIGHT them - no push), `trust_reveal`/`trust_poll`
        (the commit-reveal relay), `trust_cancel`. TTL'd + attempt-capped like the enroll broker. evie stays
        content-blind on the keys (it only indexes the two owner keys + relays opaque commit/reveal).
      - **SAS = REUSE `enrollSas`** (owner-anchored, already built) with roles assigned by SORTED owner-key order
        (symmetric in effect, no new scheme) and the `rendezvousId` as the pin (scopes the compare to this
        rendezvous; the commit-reveal still closes the offline grind). TYPED compare (user-to-user), not glance.
      - **Trust output = the owner-to-owner trust edge** (`addTrustedOwner` both sides + the existing
        `submit_xdomain_link` relay edge when gateways exist; gateway-less still records the friend edge).
      - **Android:** the untrusted-row kebab/Trust button -> `trust_arm`; the Users screen's `trust_pending` poll
        HIGHLIGHTS armed rows; tapping a highlighted row arms back -> the compare panel (REUSE
        `EnrollCeremonyScreen`'s compare/reveal UI). Build slices: F2.1 evie broker + ops + wire, F2.2 Android
        client + the arm/highlight/compare UI.
    - [DONE this stretch - the bounded fix-nows + the untrust gateway half]:
      - [DONE, sb 8da71ae] **The synced-leaf footgun fix** - `scripts/sync-leaf.ts` (format -> restamp -> cp
        atomically, reading each target from the leaf header) + a CLAUDE.md warning.
      - [DONE, sb a0cd0b5] **The bridgeSend closed-enum fall-through** (a defensive final else). The Android
        `else -> "ended"` presence folds are LEFT (an unknown presence = not-active is a defensible default).
      - [DONE, sb 7021e72] **The owner-keyed UNTRUST gateway handler** - the local-state half. A
        `cross_domain_untrust` console op (owner-keyed sibling of `cross_domain_unlink`) drives
        `CrossDomainPeers.removeByOwner` (forget every peer Gateway of every Domain the person owns) + drops the
        shares + settles the jobs for those Domains; `ChatRepository.untrustOwner` submits it after the local
        friend-graph removal. Idempotent, console-sealed. The RELAY-edge revoke (the owner-signed tombstone's
        Router half) is still TODO - it is entangled (needs the peer's domains, which the roster strips).
    - [NEXT, the remaining UX-lap slices - all gateway-side / large, best as focused passes]:
      (a) **DISCRIMINATED share target** ({kind:domain}|{kind:everyone-trusted}) on `CrossDomainShareEntry` + the
      share ops + the gateway gate (`crossDomainShareState.isSharedTo`) + the "everyone I trust" helper (the
      gateway derives "trusted owners" from `crossDomainPeers`' `friendOwnerSignPub`, so an everyone-trusted share
      matches any requesting Domain whose owner is in the peer set). The kebab's "Manage shares". TOUCHES THE
      RELAY GATE (security-sensitive) - do as a focused pass. (b) the untrust RELAY-edge revoke + the link console
      op (the tombstone's Router half). (c) the **renames + UI restructure** (the Users surface absorbs the
      Federation hub's MY NETWORK / PEERS / GUEST NETWORKS; retire "Federation"/"Peer"-as-noun). (d) **Refactor A
      slice 2** (the gateway storage re-key: crossDomainShareState/Peers owner-keyed - the multi-Domain
      robustness fix). The FINAL slice = the dead-code cleanup pass (Final scouting bucket F - note CLAUDE.md says
      the evie_* proxy is intentionally KEPT, so confirm before removing). Landmarks: `XDomainLink`, `enrollSas`,
      `cross_domain_unlink`/`cross_domain_untrust`, `crossDomainShareState`, `CrossDomainPeers.removeByOwner`.
    - **Roster evie landmarks (grounding for the aggregation, found this stretch):** presence = evie's
      `BridgeServer.gatewayConnections: Map<domainId, Map<gatewayId, ConnectionId>>` (a Domain with a live
      gateway conn is online). Per-Domain name + owner live in the `EnrollmentState` in the federation Secret
      (`operatorName`, `ownerSignPub`), written by `TenantAdmin` (provision/rename). The existing Domain-scoped
      query to EXTEND is `BridgeServer.handleListGateways(connId)` ("online peer roster for the caller, presence
      only") - it already returns only the caller's OWN Domain gateways as `{gatewayId, online}` with NO
      operatorName, and an unregistered caller sees nothing. The roster op is the CROSS-TENANT generalization:
      scope by the admitted-console signature -> the caller's owner -> the Domains they may see (operator sees
      its hosted tenants; a guest sees the operator + co-tenants), returning per member `{operatorName, presence,
      fingerprint(ownerSignPub), their-own-gateways}` and STRIPPING host/guest topology; opaque-reject on
      absence; a poll-rate ceiling. Transport = the console-bridge (evie-direct, like firstRoot / enrollHandshake),
      NOT the gateway relay. Careful: this is a cross-Domain NAME DISCLOSURE - over-disclosure (leaking topology
      or a non-visible Domain) is a privacy bug; build the visibility predicate FIRST and red-team it.
    - **Design clarifications (vetted this stretch - do NOT re-derive):**
      - **Console presence lives on the ROSTER-MEMBER shape, NOT `TeamInfoSchema.status`.** A console-only person
        has no session/team, so they never appear as a `TeamInfo`; their online/absent dot is a field on the
        roster op's member rows. So do NOT add "absent" to the TeamInfo status enum. The Android `else -> ended`
        folds (MainActivity, the session subtitle + StatusChip) are NOT buggy today (the only non-online/available
        TeamInfo status is the Android-synthesized "ended"); they are a latent-robustness nit, not load-bearing.
      - **The monotonic snapshot-VERSION gate is belt-and-suspenders, LOW priority.** `applyDomainSync`
        (Android `FederationManager`) and the gateway `Allowlist.applySnapshot` already UNION the server snapshot
        over the local one for BOTH admissions and revocations (canonicalSnapshot), so a stale snapshot served by
        an untrusted evie CANNOT drop a locally-held revocation or admission - the union is the real rollback
        defense. The version refusal-gate only adds defense-in-depth; skip it unless a concrete rollback gap is
        found that the union does not already cover.
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

## Final scouting (pre-UX-lap crust sweep - runs wf_c27a8a3b + wf_e8432cba)

An 11-dimension dynamic sweep across switchboard + evie + Android (Gateway-era bug classes, gateway-presence
assumptions, closed-enum folds, stale labeling/renames, dead code, and framework-first abstractions). ~80
findings; the actionable core below. THE dominant finding is ONE structural refactor (A) that is the
prerequisite for the richer Users surface and absorbs most of the high-severity crust.

### A. THE structural refactor: decouple OWNER IDENTITY from the HOME/DOMAIN id (the UX-lap prerequisite)
The system CONFLATES "the owner" with "the home Domain" (the `DEFAULT_DOMAIN_ID = "home"` hardwiring) and keys
trust/share/peer/routing by `domainId` (+ `gatewayId`). User-First needs owner identity as a first-class key:
the Users surface's per-row "is this person trusted?" and "reach a gateway-less member" CANNOT be answered by
domain-keyed state (one owner may run several Domains). The holistic verdict: the single highest-value refactor
for the lap is to extract console routing + identity from the home-Domain monolith into a first-class
OWNER-KEYED identity object - decouple "whose home" (owner id) from "which Domain does this console reach"
(domain id). Do this FIRST in the lap; the Trusted badge / kebab / share all depend on it. High-severity sites
(all coupled to the UX lap unless noted):
- `crossDomainShareState` keyed by `(sessionTarget, toDomainId)` -> an unshare to ONE of a user's Domains drops
  shares to ALL of them; the relay gate + discovery filter read it by domainId.
- `crossDomainPeers` keyed by `(friendDomainId, friendGatewayId)` + `crossDomainHandshake.confirm()` writes the
  peer Domain-keyed -> the same friend re-links as a second peer when you operate a different Domain.
- the cross-Domain LINK edge + its revocation are per-`(srcDomain, dstDomain)`, NOT per-owner; and
  `XDomainLinkSchema` REQUIRES a non-empty `peerGatewayId` -> a gateway-LESS friend cannot be linked AT ALL (a
  hard User-First blocker; the whole pairing handshake is unreachable for a console-only member).
- evie `BridgeService` flushes + broadcasts `DEFAULT_DOMAIN_ID` for `submit_admission` / `submit_revocation`
  REGARDLESS of the target Domain (a sibling of the fixed edge-routing bug) -> a non-home Domain's
  admission/revocation mutates IN MEMORY but never persists to the Secret + never reaches its gateways (silent
  data loss; a guest gateway's revocation is lost). [fix-now, also true outside the UX surface]
- evie `BridgeServer.gatewayIds()` / `pushToGateway()` / `pushGatewayFrame()` hardwire `DEFAULT_DOMAIN_ID`, so
  console routing only reaches HOME-Domain gateways (a guest-Domain reply mis-routes / drops).
- Android console SEALING (`ConsoleClient.resolveGatewayId()`) + `ConsoleClient.send()` REQUIRE an admitted
  gateway -> a gateway-less user can perform NO sealed op (roster / link / confirm / share / send / respond /
  poll all throw "No Gateway admitted"). Hard User-First blocker.
- Android `linkedDomains` / `linkedPeerDomains` / `hostedTenants` keyed by `domainId`; `set_operator_name`
  per-Domain; discovery `operatorName` stamped per-GATEWAY (one name shared across all a gateway's Domains).

### B. Closed-enum folds (FOLD INTO UX - they activate the moment the surface adds presence/role values)
- (high) Android `MainActivity` `else -> "ended"` in THREE places (`presenceIndicator` / `SessionCard` /
  `presenceColor`) silently maps any new `TeamInfo.status` to "ended".
- (high) `mcp/bridge/bridgeSend.ts` `formatResult` has NO final `else` over the ResponseStatus chain.
- `FriendOnboarding.hostedState` + `bridgeDiscover` default an unknown status without an explicit branch.

### C. Renames (FOLD INTO UX - the design pass already mandates these)
- Retire the "Federation" screen title, the "PEERS" / "MY NETWORK" / "GUEST NETWORKS" headers, the Settings
  "Peers" label, and the whose-network labels. "Peer" as a NOUN is a category error (Peer = a LINKED network;
  the roster includes unlinked) - reword. `operatorName` has 3 rename surfaces with inconsistent terminology;
  member/operator -> ADMIN/USER. "home" (`DEFAULT_DOMAIN_ID`) reads like "a house" but means "the operator's
  Domain" - rename candidate, do it WITH refactor A (same conflation). Scrub stale Federation/PEERS comments.

### D. Framework-first abstractions (the boilerplate hit 3x this session)
- (fold into UX) A `SignedScheme<T>` abstraction: a signed scheme is NINE hand-authored pieces today (schema +
  signing-bytes + sign/verify + Kotlin twin + vector + codegen ROOT + 2 tests + manifest). Add a preimage
  field-ORDER validation (the order is load-bearing but unchecked) and Kotlin-twin generation; let codegen
  DISCOVER + auto-register signed schemes + auto-nest into ConsoleOp.
- (fold into UX) Standardize the wire Result to `{ok, error?, data?}` (today some results put the payload
  optional-on-reject - RosterResult.members, EnrollHandshakeResult.peer* - some always-present, some skip error).
- (cleanup) PoP unification (`registerSigningBytes` + `rosterRequestSigningBytes` are the same shape).
  Replay-guard unification (THREE seen-nonce+TTL impls: gateway `ReplayGuard`, evie's registration cache,
  `BridgeService.rosterNonces`).

### E. The synced-leaf footgun (FIX-NOW, INDEPENDENT - a real trap hit twice this session)
`biome lint:fix` reformats the SOURCE after the `check-sync-hash --write` restamp, so a `cp` done before the
format leaves the evie/nyaaskills copy stale (fails their CI). FIX: a `scripts/sync-leaf.ts` doing
format -> restamp -> cp ATOMICALLY (the copy target is already in each file header: "MUST re-copy on change:
cp ..."), plus a CLAUDE.md warning. Also: adding a NESTED-ONLY schema to the codegen ROOTS is non-obvious (had
to add `SignedXDomainUntrustSchema` as a bare root) - document it or add an explicit emit-this-nested affordance.

### F. Dead/retired code (the FINAL cleanup-pass material - owner is wiping evie, NO migration code)
- Retired enroll-owner / authorize-console QR payload types (schema-persisted but unredeemable; the owner root
  is host-rooted now) + the retired `enroll_redeem` EnrollOp (evie rejects it, no app path) + the commented-out
  `FederationEnrollOwnerAction`. The DETACHED `evie_*` tool proxy (`mcp/evie/evieTools.ts`, zero imports) + the
  `POST /evie/tool-call` route (never called). Stale "arbiter" references in the OTHER plan files (code renamed).

### G. Leave / laundry (low value, do NOT block on)
- The opaque-reject convention is consistent enough without a shared helper. The 6-corpus vector fragmentation
  is acceptable. The PoP freshness windows differ slightly (`REGISTER_MAX_SKEW` vs `ROSTER_MAX_SKEW`) - harmless.

>> UX-LAP PLAN IMPACT: lap-3's UX work now leads with **refactor A** (owner-keyed identity, decoupled from the
home/Domain id) as Phase-4 slice 0 - the trust badges, kebab, arm-trust, and share control all sit on it. B + C
fold into the screens as built. D folds in where it touches the new signed schemes / result shapes; the rest
(E, F, the cleanup half of D) is the final cleanup pass. The Phase 1-4 roadmap below predates this scouting; A
supersedes the "Phase 3 ForeignOwnerKeyring" framing by making owner-keying the spine, not an add-on.

## Enroll-ceremony architecture (lap 2 - SHIPPED, reduced)

Lap 2 is complete + fully audited (see Build progress). The FLOW-1 in-person enroll ceremony is evie-RESIDENT:
a fresh enrollee has no gateway, so the commit-reveal mutual 6-digit compare is brokered AT evie by a DUMB
BROKER (`EnrollHandshakeCoordinator`) that relays commit then reveal frames keyed by an unguessable
handshakeId and computes NO SAS (the phones do; the pin rides the QR out of band). Each phone verifies the
peer's reveal opens its commitment, computes the owner-anchored `ENROLL_SAS_V1` LOCALLY, glance-compares, and
on a mutual [Yes] each owner signs a cross-Domain link EDGE - the trust output is the EXISTING edges, NOT a new
admission and NOT a gateway peer (the enrollee is gateway-less). The verbose design + red-team analysis lived
here; reduced once shipped (full text in git history).

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

## Analysis (lap 3 - SUPERSEDED by the Design pass + Final scouting, reduced)

The deep multi-repo analysis that fed the lap-3 design. Load-bearing invariants that survive: isolated-by-default
is STRUCTURAL at evie (`handleListGateways` returns only the caller's OWN-Domain gateways); a guest/tenant is
its OWN Domain rooted at its OWN owner key; the roster is a genuine cross-Domain NAME disclosure needing a
net-new evie aggregation (BUILT this session - see Build progress). The hard blockers it raised (console-only
members visible-only first; "Peer" is a wording category error; the unsigned-name compromise) were resolved by
Q3=B + Q4=A (below) and the Final scouting's refactor A (owner-keyed identity). Full text in git history.

## Questionaire (lap 3 - decisions captured below + in Build progress, reduced)

The owner decisions that shaped the UX (live in the Design pass + Decision update; full prose in git history):
- **Q1=A FULL ROSTER:** every member is visible by name to every other member, non-transitive, scoped to the
  members on your evie (you + your hosted guests). [BUILT - the roster.]
- **Q2=B + no-prompt:** tapping Trust ARMS your side + posts a pending trust-back; the target sees their row
  HIGHLIGHTED on the Trust screen (NO push / unsolicited ping), taps it back to arm, then the mutual 6-digit
  SAS compare runs on both. A pending-trust state stored server-side (evie), TTL'd + rate-limited; a roster tap
  exposes NO gatewayId / mints NO token.
- **Q3=B BUILD THE TRUST FOUNDATION NOW:** trust is a persistent friend edge between PEOPLE, recorded even when
  a member is console-only (it yields a friends list until they add a gateway).
- **Q4=A RE-ANCHOR trust on OWNER identity:** the SAS pins the two OWNER keys; the trust edge is owner-to-owner
  (the enroll ceremony already does this - the Final scouting's refactor A finishes it across the subsystem).

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

## Red-team (lap 1) - 67 findings, folded in (reduced)

The first design red-team: 67 confirmed findings across 7 root-cause themes. Every adopted refinement was
folded into the Plan phases + the Design pass; the resolved owner forks live in Decided-so-far + the Design
pass. Verdict: the design is sound; the build proceeded on it. Full corpus in git history.

## Red-team (lap 2) - the v2 refinements verified (reduced)

Verified the v2 plan refinements; 6 blockers resolved + folded into the phases (notably the consent rails moved
to evie Phase 2, and the 6-digit SAS treated as a wire change end to end). Full detail in git history.

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

## Red-team (lap 3) - the design pass vetted, forks resolved (reduced)

A 9-angle red-team of the post-lap-2 design pass (the 6-digit code, two-flow trust, admin-only rename, no
alias): SOUND in intent, owner-accepted, overturns no owner decision. The reconciliation fixes are folded into
the build: the 6-digit code is a WIRE change end to end (SAS_MODULUS 10^6 / SAS_DIGITS 6 in both runtimes -
DONE lap 1); the fingerprint stays 16 chars / 4 groups (signed into provision-op preimages, do NOT truncate);
the residual is ~1-in-10^6 per ceremony (single-flight); the SAS is symmetric so paste-block-own is a no-op;
QR auto-dismiss rides a short foreground timer, not the nonce TTL. Both owner forks RESOLVED this session. Full
corpus in git history.

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
