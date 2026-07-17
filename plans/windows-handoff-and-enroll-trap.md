# Windows handoff + guest enrollment bug (trap, fix, instrument)

Three-part effort: (1) apply the Windows compatibility fix from the handoff, (2) root-cause the
"Admit failed: admission not owner-signed" guest enrollment failure, (3) instrument evie-bot and
the Android app so this class of bug is observable instead of silent.

## Questionaire

**1. Who hit the bug?**

The handoff (zip, 2026-07-13, DESKTOP-OA8ON9U) is from a FRIEND: she is a guest tenant on the
owner's evie, installing Switchboard on her own Windows machine. The owner (this repo's user) is
the evie k8s admin, on Linux. The owner enrolled her as a user (tenant); her phone first-rooted
her Domain successfully. She then attempted to add her OWN Gateway from the Windows box and the
phone's Approve failed with "Admit failed: admission not owner signed". Her profile screen also
would not let her rename ("Loading your Domain...", rename greyed out).

Owner's initial hypothesis: "She hit issues because she doesn't have the master keys of
kubeconfig, and Switchboard was not correctly designed to mint limited role configs to users."

**Analysis findings (pre-Q2):**

- Kubeconfig hypothesis refuted in code: `setup.ts`'s `setupGateway` (menu 1, the path she ran)
  never calls `ensureAdminKubernetes`; only Admin Provision (menu 2), `--gateway-transport`, and
  `--verify` need `SWITCHBOARD_KUBECONFIG`. A guest gateway is creds-less by design: the phone
  pulls the gateway-bridge transport from evie via `TRANSPORT_REQUEST_V1` after proving Domain
  ownership.
- Root cause candidate found by code reading, in evie-bot `app/services/BridgeService.ts`
  (`onEnrollOp`, ~line 234): `submit_admission` / `submit_revocation` are ALWAYS routed to
  `this.adminDomain()`'s coordinator. A guest's admission is signed by HER owner key but verified
  against the ADMIN Domain's root key, so `verifyAdmission` fails and
  `EnrollmentCoordinator.admit()` (line 223) returns exactly "admission not owner-signed".
- Same bug class was previously found and fixed for `submit_xdomain_link` / `revoke_xdomain_link`
  (routed to the edge's own `srcDomainId`) and `delete_domain` (routed straight to TenantAdmin);
  the code comment above the dispatch documents that history. Admissions/revocations never got the
  same fix. It never surfaced before because the admin's own Domain IS `adminDomain()` - routing
  is accidentally correct in the single-tenant case.
- Fix shape available in-tree: resolve the target Domain by the op's claimed
  `signed.ownerSignPub` over `secretStore.listDomains()` (the same rooted-owner enumeration
  `handleTransport` already does), then `coordinatorFor(domainId)` (already vivifies lazily for
  any rooted Domain). Safe: routing by claimed key is authenticated by `verifyAdmission` at the
  destination - a forged claim fails the signature check there.
- Collateral confirmed: her CONSOLE admission (`submitConsoleAdmission`, submitted on every
  connect before register) has been failing the same way, silently (visible only in
  logcat/DebugLog on a release build). Self-heals: the app re-submits on every `connect()` until
  `consoleAdmitted` latches, so once evie is fixed her console admission lands on next app open,
  and the gateway Approve is user-retriable.
- The profile rename block is downstream, not separate: `renameAwaitsDiscovery` gates on
  `confirmedDomainId == null`, which reads off a live local gateway session - none exists until
  her gateway enrolls. Resolves itself once enrollment works.
- The handoff's own "evie reset the Domain" theory is unsupported: nothing needed to reset; her
  first-root path (`firstRootDomain`, routed by explicit `pendingTenant.domainId`) worked fine
  and its latch is legitimately true.
- Instrumentation survey (evie + app): the ENTIRE evie enroll path (`EnrollmentCoordinator`,
  `TenantAdmin`, `dispatchEnrollOp`, `handleEnrollOp`, `KubeSecretStore.init`/`saveDomain`)
  carries ZERO logging - a rejected admission never reaches pod stdout, a fresh-minted/reset
  Secret leaves no trace, and no log line records a Domain root transition. Sibling code has an
  ad-hoc `[BridgeServer]`-style tag convention to match. On Android, `DebugLog` covers Connect /
  FirstRoot / Enroll tags already, but `installApprovedDevice` (the add-a-device path that also
  sets `firstRooted=true`) has no coverage at all.

**2. Trap/confirm strategy?**

Answer: C, fix-first. "We will go for fixing what we think the issue is. and then just instrument
what we aren't sure on. Emu of a 2nd actor sounds difficult." The friend's single retry after
deploy is the confirmation; no emulator repro.

The user also confirmed the framework-first read: the routing divergence is the incomplete-pattern
violation ("dupes code that diverged"), so the fix extracts ONE routing decision rather than
patching another branch.

## Plan

1. **Windows fix**: apply `changes.diff` from the handoff, branch + PR. Optional follow-up: audit
   the remaining `.ps1`-launched scripts for the same Linux-isms.
2. **evie fix**: `resolveEnrollRoute` - one exhaustive op-to-Domain routing decision in
   EnrollmentCoordinator.ts. Admissions/revocations resolve by the Domain their claimed
   `ownerSignPub` roots (destination coordinator re-verifies, so the lookup steers, never
   authenticates); unknown signer opaque-rejects with the same wording as a bad signature.
3. **evie instrumentation**: `[EnrollOp]` outcome lines (kind, routed Domain, signer fingerprint,
   rejection reason), `[TenantAdmin]` first-root REAL-branch lines (wire reject stays opaque),
   `[KubeSecretStore]` Secret loaded-vs-fresh-minted tombstone. Fingerprints only.
4. **Android instrumentation**: DebugLog on `installApprovedDevice` (the one other firstRooted
   setter, previously untraced), owner-key fingerprints on the FirstRoot rooting line and the
   console-admission submit line (comparable against evie's `[EnrollOp]`/`[TenantAdmin]` lines,
   same `fingerprint()` format both sides).
5. **Her recovery**: nothing needed on her side after the evie fix deploys - console admission
   self-heals on next app open; she retries Add Gateway (with the Windows fix pulled) and rename
   unblocks once her gateway is up.

## Execution log

- Windows fix: switchboard PR #142, merged (2a90553 on main).
- evie fix + instrumentation: evie-bot PR #1415 (`enroll-domain-routing`, commits 74d52df +
  9061365), auto-merge armed. Gate: lint clean, bun 261 pass (new `resolveEnrollRoute` suite pins
  guest-vs-admin routing and the exact field failure), vitest 307 pass (node 22).
- Android instrumentation: ChatRepository.kt DebugLog additions, `:app:testDebugUnitTest` green.
- Remaining: evie CI merge + rollout, then the friend's retry (pull switchboard main on her
  Windows box, reopen app, Setup Gateway + Approve). The `.ps1` launcher audit stays open.
