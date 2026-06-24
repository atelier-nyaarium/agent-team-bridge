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

## Plan (breaking refactor - retire `home`, rename to profile, fail-closed identity)

**Open implementation sub-decision (flag during build):** after `== "home"` is gone, the app still
needs an "am I the operator (can host guests) vs a guest" signal that today rides on `confirmed ==
"home"` (isHomeOperator). Likely fix: a role flag on the provisioning blob (operator-setup vs
guest-invite) and/or evie marking the one operator/primary Domain - resolve in Phase 1.

- **Phase 1 - Domain ID: retire `home`, mint random ids.** Delete `DEFAULT_DOMAIN_ID`;
  `resolveLocalDomainId` requires `FEDERATION_DOMAIN_ID` (no fallback); provisioning
  (`provision.ts`/`bootstrap-domain.ts`) mints a random home Domain id like `newDomainId` and sets the
  gateway env to it. evie: every `DEFAULT_DOMAIN_ID` default resolves to the real rooted id from the
  Secret, not a constant. Android: `localDomainId()` returns null/empty when unconfirmed (drop the
  `?: "home"`); `renameAwaitsDiscovery = firstRooted && notConfirmed`; replace `isHomeOperator`'s
  `== "home"` with the operator-vs-guest signal above.
- **Phase 2 - `operatorName` -> `profileName` (the person).** Rename the wire field across the synced
  leaves (re-sync to evie) + `schemas.ts` + codegen + gateway + Android + evie + scripts + tests. The
  SIGNED bytes are value-positional (SET_OPERATOR_NAME_V1), so the field-name rename does not change
  the preimage - verify vectors hold. Roster/UI ALWAYS render `profileName`, never the Domain id.
- **Phase 3 - CLASS 5 fail-closed identity.** `ProvisioningStore` distinguishes present-but-corrupt
  from absent (no more decode-swallow to null indistinguishable from missing). `FederationManager`
  mints only when truly absent, fails closed on corrupt (surface recovery, never overwrite), + fp log
  on load/mint (gateway parity). Gateway `identity.ts` gains the orphan detector (admission present,
  no key match -> "identity regenerated, re-admit", distinct from un-enrolled).
- **Phase 4 - verify + ship.** All gates (switchboard lint+test, Android testDebugUnitTest +
  assembleRelease, evie lint+bridge, codegen no-drift, synced-leaf hashes) + the smell-check grep
  (`"home"` returns nothing as a domain id) + an on-device fresh-provision round-trip (breaking, so a
  re-provision is required).

**Minor (separate, low):** evie `CursorMergePullRequestAction.checkGHCLI` (CLASS 2) returns a
hardcoded "GitHub CLI not found" discarding `gh` stderr - unrelated cursor feature; fix the narrow
stderr-surfacing if/when that area is touched.
