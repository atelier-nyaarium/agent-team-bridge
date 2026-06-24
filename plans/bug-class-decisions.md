# Bug-class decisions (framework-first audit follow-up)

The bug-class audit (9 finders + adversarial verify across switchboard + evie + Android) confirmed
5 real instances. The 4 safe/obvious ones are fixed + pushed (commit 2e4dae9): CLASS 3  x2 status
leaks, CLASS 2 masked transport error, CLASS 5 cheap-half (gateway identity fingerprint on load).

Two findings were triaged NEEDS-DECISION. This file captures the questionaire on how each should
work + be solved.

## Decisions in scope

1. **CLASS 4 (MEDIUM, functional)** - `renameAwaitsDiscovery` (FriendOnboarding.kt:84) returns
   `firstRooted && localDomainId == "home"` to gate the network-name Save until discovery confirms
   the real domain. That was correct when only a FRIEND first-rooted (their "home" is a fallback
   that flips to a guest-XXXX id). The provisioning change made the OPERATOR's own home first-root
   too, so `firstRooted` is now true for the operator, whose real domain genuinely IS "home" and
   never flips - so the gate never lifts and the operator can never set their network name.
2. **CLASS 5 (MEDIUM, defensive) - the silent identity-key regeneration footgun**, spanning 3
   surfaces (the 3rd re-audit pinned the real mechanism):
   - **Android `ProvisioningStore` (the teeth, ProvisioningStore.kt:192/206)** - `loadOwnerIdentity()`
     / `loadIdentity()` swallow a DECODE failure to `null` via `runCatching{}.getOrNull()`, so a
     corrupt-but-present key reads identical to "no key". `FederationManager.ownerIdentity()` (63)
     then treats `null` as "mint fresh AND `saveOwnerIdentity` overwrite", so a transient keystore
     read-glitch (lock-screen change, restore-from-backup) silently re-mints AND DESTROYS the owner
     root, orphaning the mesh (applyDomainSync rejects every snapshot vs the new key). Decision:
     fail-closed (refuse to overwrite a present-but-undecodable owner root) vs regenerate.
   - **Android `FederationManager` (FederationManager.kt:63/69)** - mints with NO fingerprint logged,
     asymmetric with the gateway. Cheap half: log the owner/console fp on mint+load (debug).
   - **Gateway `identity.ts`** - the load-path fingerprint log SHIPPED in 2e4dae9; the orphan DETECTOR
     (admission present but no match for the current key -> distinct "identity regenerated, re-admit"
     message vs genuine un-enrolled) is the open decision.

**Status:** the autofix loop is COMPLETE - 3 audit passes, the 3rd came up clean (obvious bucket
empty). All safe/obvious fixes shipped (2e4dae9 + cb2c7d2). A 4th, low-severity CLASS 2 (evie
`CursorMergePullRequestAction.checkGHCLI` discards stderr behind a hardcoded "GitHub CLI not found",
unrelated feature) was confirmed in audit-2; noted, not pursued unless wanted.

## Questionaire

**Q1 - the rename gate behavior (CLASS 4).** How should the network-name Save gate behave?
Answer: **A** - the network name is per-operator (everyone names their own Domain); the rule is
uniform: unlock once your REAL Domain is confirmed. The operator's real Domain IS `home` (confirmed
the moment their session connects); a guest stays gated until discovery confirms THEIR Domain. Not
an admin special case.

**Q2 - the `== "home"` smell (framework-first, owner-raised).** Surfaced while resolving Q1: is
`home` a legacy artifact, is a network = the whole Domain, and should the `== "home"` check exist?
Grounding: a "network" = a Domain; `operatorName` is its display name; `home` is internal plumbing.
`DEFAULT_DOMAIN_ID = "home"` is a single-tenant-era convention (the gateway's absent-domainId
default). The real smell is `localDomainId()` (ChatRepository.kt:1019) doing `fromLocal ?: "home"`,
so `home` means BOTH the operator's real Domain AND "not confirmed yet" - the conflation behind the
CLASS 4 bug. `isHomeOperator()` (1030) already checks the un-fallback'd `confirmed` value correctly.
Options: A) patch the gate to check confirmed-vs-unknown; B) clean house - add explicit
`confirmedDomainId(): String?` and migrate consumers off the overloaded `localDomainId()` fallback,
keeping `home` as the id; C) deep rename retiring the magic `home` (big 3-runtime refactor).
Recommendation: B. **Answer: beyond C - a full RETIRE + RENAME (breaking update, owner-accepted
because provisioning/setup is now fixed; clean break, no migration code).** The Domain **ID**
becomes a random numeric/hex id like the guest ids + identities/fingerprints already are; `home` /
`DEFAULT_DOMAIN_ID` is retired across all three runtimes (evie + gateway + Android). The id is pure
machine plumbing, never shown to a human. Every `== "home"` discriminator becomes a real
"confirmed-vs-unknown" check.

**Q3 - profile name vs domain name (owner clarification).** The plan had conflated two things:
`operatorName` was treated as a NETWORK/DOMAIN display name, but the owner meant a PROFILE / USER
name. Decision: reframe `operatorName` as a **profile name** - the human's name ("Alice"),
owner-signed - and the roster ALWAYS renders the profile name, NEVER the (now-cryptic) domain id.
So Bob sees "Alice", not "QPS-20-1234". Open fork (asked): ONE name per person (profile only;
Domain has just the hex id) vs TWO names (profile + a separate per-network label). Recommendation:
one name. **Answer: ONE name (locked).** A person = owner key = one Domain = one profile name.
Confirmed an operator CANNOT own multiple Domains yet (one owner key owns its own home Domain only;
it HOSTS guest Domains but each guest owns theirs; the roster is 1:1 per rooted Domain). The profile
name keys off the PERSON (owner key), so it future-proofs even if multi-Domain-per-owner ever ships.

**This is now a breaking REFACTOR**, not just bug patches: retire `home` -> random Domain ids +
reframe `operatorName` -> profile name (always shown over the id).

**Q4 - the CLASS 5 identity footgun.** Today a PRESENT-but-undecodable owner key (keystore glitch:
lock-screen change, restore-from-backup) reads as null, so the app silently mints a new key AND
overwrites the corrupt slot, destroying the real key + orphaning the mesh with no warning. Options:
**A)** fail closed - present-but-corrupt must NOT regenerate/overwrite; stop, keep the bytes, surface
"restore your backup or re-provision"; mint only when truly EMPTY; + fp log on load/mint (gateway
parity) + the "key regenerated, re-admit" detector. **B)** regenerate-but-warn (still destroys the
old key). Recommendation: A. **Answer: A (fail closed).** A present-but-undecodable key never
silently regenerates or overwrites; mint only when truly EMPTY; surface recovery (restore backup /
re-provision); + fp logging parity + the orphan detector.

**Acceptance test (owner):** after the `home` retire, **`"home"` must not grep anywhere as a domain
id** - `DEFAULT_DOMAIN_ID` deleted, no `== "home"`, no `?: "home"` fallback, test fixtures off the
literal. The smell is eradicated, not patched.

## Blast radius (grounding for the plan)

- `DEFAULT_DOMAIN_ID` = "home": **94 occurrences / 15 files** across all 3 runtimes + scripts + tests.
  Source: `src/shared/domain-id.ts:10`; evie def `EnrollmentCoordinator.ts:105`; Android const
  `FriendOnboarding.kt:76`. Gateway default: `resolveLocalDomainId` = `FEDERATION_DOMAIN_ID || DEFAULT`.
- The `"home"` fallback/sentinel: `localDomainId() = fromLocal ?: "home"` (ChatRepository.kt:1019) is
  the conflation; many TEST fixtures use `makeDomain("home", ...)` / `domainId:"home"` (must move off
  the literal for the smell check).
- `operatorName`: **~40 files** - a WIRE field in the synced leaves (`enrollment.ts`,
  `evie-protocol.ts`, `admission.ts`), `schemas.ts`, codegen `Protocol.kt`, the gateway, Android,
  evie, scripts, tests. Rename to `profileName` is breaking + re-syncs the leaves + regenerates codegen.

## Gap audit (refinement lap 1) - 39 confirmed gaps (3 blocker / 18 high / 15 medium / 3 low)

A 10-dimension code-verified fan-out found the plan-as-written would ship a BROKEN console. The
dominant theme: `"home"` is not merely an "absent-domainId default" - it is the LOAD-BEARING binding
by which the console (which sends NO domainId on the wire; it addresses gateways) reaches its
operator's mesh. Retiring it for a random id, with no replacement, breaks every console op. The
restructured plan below closes all 39; the full ranked list is in the gap-audit output.

## KEY DESIGN DECISION (the blocker - confirm before Phase 1): the operator-home ANCHOR

evie's console routing (`BridgeServer.homeFallbackConnection`/`pushToGateway`/`pushGatewayFrame`/
`gatewayIds`/`isConnected`, all `gatewayConnections.get(DEFAULT_DOMAIN_ID)`) + the enroll-op path
(`coordinatorFor(DEFAULT_DOMAIN_ID)`, `flushDomain`/`broadcastDomainUpdate(DEFAULT_DOMAIN_ID)`) +
the register security gate (`BridgeServer.ts:477 domainId !== DEFAULT_DOMAIN_ID`) all use the literal
`"home"` to mean "the operator's own Domain." The evie Secret has NO operator/primary marker today.
Two ways to replace it:
- **(A, recommended)** Add a persisted `operatorDomainId` / `isPrimary` marker to the evie Secret
  (bump schema v2 -> v3), written at first-root; re-key every console-routing + enroll-op + register
  read off it. Console wire stays domainId-free (Q3 locks one-operator/one-home, so a single primary
  is adequate). Smaller wire surface.
- **(B)** Bind the console's `conversationId` -> its home domainId at provisioning and have the console
  send the home domainId on every relay; evie routes by it. More explicit, changes the console wire.

**CONFIRMED: A (owner).** The operator-home reference is stored on the Domain's store - the evie
Secret operator/primary marker.

## Plan (restructured: breaking refactor, ONE atomic cutover)

- **Phase 0 - the operator-home anchor (the blocker). DONE (evie `018b6c8`, switchboard `4350c7a`).**
  The operator home slice is flagged `isPrimary` on `EnrollmentState` (set host-side in
  `bootstrap-domain.ts`, preserved through `firstRoot`); `KubeSecretStore.operatorDomainId()` resolves
  it; the 5 console-routing methods + the enroll-op `coordinatorFor`/`flushDomain`/`broadcastDomainUpdate`
  + the register gate re-key onto it through a single `operatorDomain()` resolver (one `?? DEFAULT`
  fallback site). Audit hardening: `operatorDomainId()` fails closed on >1 primary, `persistDomain`
  preserves the marker across a coordinator overwrite, `provision_tenant`/`remove_tenant` refuse the
  primary domain by the marker. No `v3` schema bump (the field is optional, so a v2 blob deserializes
  unchanged). DEFERRED to Phase 1: the `role: operator|guest` flag on `ProvisioningSchema` (rides with
  the Android `isHomeOperator` re-key). Closed: blockers 1-3, highs 4/5/9/10, mediums 22/26.
- **Phase 1 - Domain ID: retire `home` -> random hex, with plumbing + persistence.** Delete
  `DEFAULT_DOMAIN_ID`; `resolveLocalDomainId` requires `FEDERATION_DOMAIN_ID` (no fallback); decide
  `sanitizeDomainId` empty-input behavior (reject vs a non-`home` sentinel) and keep the switchboard +
  evie twins byte-identical. `provision.ts`/`gateway-setup.ts` mint a random home id (`newDomainId`
  style), root it in the evie Secret, write `FEDERATION_DOMAIN_ID` into the gateway `.env`, ADD a
  `FEDERATION_DOMAIN_ID` passthrough to `docker-compose.yml` (else it does not survive restart), and
  restart the gateway. Android: `localDomainId()` -> `confirmedDomainId(): String?` (null until a
  local session confirms); migrate ALL signing + routing call sites onto it (not just the rename gate:
  `signSetOperatorName`, `submitXdomainLink` link/revoke, `EnrollParty`/`trustParty`), disabling those
  UI surfaces until confirmed; `renameAwaitsDiscovery = firstRooted && confirmedDomainId == null`;
  `isHomeOperator` -> the Phase-0 role/marker. Define the wire `domainId` posture (make required vs a
  defined absent behavior in `GatewayRegisterParams`/`GatewayRelayRoute`/relay frames). Retire evie's
  v1->v2 `home` migration + the `operatorName` backfill (clean-break). When the home id becomes random,
  key `composeFederationJson`'s home replacement + the `carryOtherDomain` skip on the operator-home id
  (not the `home` literal) so exactly ONE slice stays `isPrimary` (a second primary is otherwise
  reachable), and make the operator-domain resolution fail-closed END TO END once the `?? DEFAULT`
  fallback is gone (an ambiguous/absent marker routes the console NOWHERE rather than to a stale
  default). Closes: highs 6/7/11/19/20, mediums 24/28/31, low 39.
- **Phase 2 - `operatorName` -> `profileName` (the person) + empty fallback.** Rename the wire field
  across `schemas.ts` + the 3 synced leaves (re-sync via `sync-leaf.ts`) + codegen `Protocol.kt` +
  gateway + Android + evie + scripts + tests. Note BOTH `setOperatorNameSigningBytes` AND
  `provisionTenantSigningBytes` are value-positional over the field, so the preimage bytes are
  unchanged BUT the fixture JSON keys + the Kotlin readers re-cut (provision-ops vectors). **Profile name is REQUIRED at provisioning (owner decision):**
  the app's import screen gains a "Your Name" field, and the QR-scan + paste-clipboard actions are
  DISABLED until it is non-empty; the entered name is carried into first-root and owner-signed as the
  profile name, so a person is never nameless. Applies to operator AND guest (each names themselves on
  their own device). This MOVES name entry to the phone, so the host-side `provision.ts --setup`
  operator-name prompt is dropped (provision stages no name). The host-side launcher
  `provision-console.sh` is RENAMED to `setup-evie-admin.sh` (owner: admin/operator setup ONLY -
  guests come via the app invite), updating every reference (CLAUDE.md, script self-refs,
  `scripts/provision.ts` usage strings, `start-*.sh`). The "(unnamed)" placeholder stays ONLY
  as a defensive backstop (legacy/edge), routed through every person-name render (ChatRepository.kt:886
  + the 3 id-leak sites), NEVER the Domain id. ALSO (owner ask): the conversation thread labels the
  user's OWN rows "you" (ThreadRenderer.kt:213, `from = if (m.fromMe) "you" else ...`); thread the
  local `profileName` into the renderer (a `selfName` field on ThreadRenderer, set from repo state via
  `ThreadWebView`) so own rows show the person's name, falling back to "you" only when empty. The other
  party's `m.from` (the host/session name) stays. Closes: high 14, mediums 25/29, lows 37/38.
- **Phase 3 - re-cut the `home`-bearing SIGNING vector corpora (Phase 1's hidden cost).** THREE
  cross-runtime signed/hashed corpora embed `domainId:"home"` in the preimage (xdomain-link, enroll-sas,
  cross-domain-sas) + the protocol golden fixtures: the VALUE changes, so the bytes change and the
  vectors regenerate on BOTH runtimes (TS fixtures + Android `testDebugUnitTest` decoders). Rewrite
  `domain-id.test.ts` ("defaults to home" -> "throws/empties when FEDERATION_DOMAIN_ID unset"). Closes:
  high 13, medium 23.
- **Phase 4 - CLASS 5 fail-closed identity, with caller handling.** `ProvisioningStore.loadIdentity`/
  `loadOwnerIdentity` return a tri-state (Loaded/Corrupt/Absent), not decode-swallow-to-null.
  `FederationManager` mints only on Absent, fails closed on Corrupt (never overwrite) + fp log
  load/mint. EXEMPT `importOwnerBackup` from the no-overwrite rule (restore is the sanctioned
  recovery). Make the Compose composition-time key readers (OwnerKeysCard/Users/Sharing/ManageScreen)
  non-throwing (nullable accessor / runCatching) - a throw in composition crashes. Add a corrupt-key
  branch to `ConsoleClient.requireConsoleIdentity` (the live sign/seal path reads the store directly)
  + `classifyConnError` -> `ConnKind.TERMINAL` "key unreadable - restore backup / re-provision".
  Gateway `identity.ts` orphan detector (admission present, no key match -> "regenerated, re-admit").
  Closes: high 18, mediums 32/33/34/36.
- **Phase 5 - ONE atomic deploy + verify.** Phases 0-4 are ONE atomic breaking release across 4
  artifacts (evie image, gateway container, APK, provision script) - they CANNOT land independently
  (medium 35). Sequenced clean-break wipe FIRST (delete the whole `evie-federation` Secret, each
  gateway `federation-allowlist.json`, the phone identity). Rollout order: push evie (await Push(main)
  rollout) -> push switchboard (main-push.yml builds the APK) -> rebuild gateway -> re-provision ->
  MANUALLY flash `switchboard-release.apk` onto every console (the in-app updater is opt-in + only
  sees the new versionCode after re-provision). Optionally bump `FEDERATION_PROTOCOL_VERSION` +
  `CONSOLE_PROTOCOL_VERSION` so an old runtime fails fast, not silently. Gates: all 3 runtimes +
  codegen no-drift + synced-leaf hashes + the smell-check grep (`"home"` not a domain id) + a SEMANTIC
  acceptance test (a roster row with empty profileName shows "(unnamed)", not the hex id - the literal
  grep gives a FALSE green on the leak) + on-device fresh-provision round-trip. Closes: highs 15/16/17/21,
  mediums 27/30.

**Minor (separate, low):** evie `CursorMergePullRequestAction.checkGHCLI` (CLASS 2) returns a
hardcoded "GitHub CLI not found" discarding `gh` stderr - unrelated cursor feature; fix the narrow
stderr-surfacing if/when that area is touched.
