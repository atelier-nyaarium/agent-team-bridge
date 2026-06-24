# Peer UX unification (SHIPPED + live-validated)

**Status:** complete end to end across all three runtimes (evie + switchboard + Android), built to the design
mockups, deployed to main, and VALIDATED ON-DEVICE this session - a full fresh provision exercised first-root
-> gateway admit -> console admit -> connect, plus the trust / share / untrust surfaces. All gates green
(switchboard lint + tests + no codegen drift; Android testDebugUnitTest + assembleRelease R8; evie lint + 243
bridge tests). The verbose per-slice build log and the lap-1/2/3 audit corpora (align / red-team / framework)
were reduced into this summary; the full trail lives in git history (the lap commits + the prior plan revision).

## What shipped

- **Enroll ceremony (FLOW-1, in-person)** - an admin enrolls a new user; both phones run an owner-anchored
  6-digit commit-reveal mutual compare. The QR authenticates admin->user; the compare authenticates user->admin
  (replaces the old silent auto-trust). Trust output = the cross-Domain link edges, recorded even for a
  gateway-less user (routed to the edge's own first-rooted Domain coordinator - the User-First invariant).
- **FLOW-2 roster trust (user-to-user, remote)** - a Trust button on an untrusted roster row arms a rendezvous;
  the target's row HIGHLIGHTS (a `trustPending` poll, no push); both run the same 6-digit compare (reusing
  `enrollSas` with sorted-owner-key roles + the rendezvousId pin); a mutual [Yes] records the owner-to-owner
  friend edge. evie is the dumb `TrustRendezvousCoordinator`, indexed by target owner.
- **Cross-tenant roster** - membership-gated (a console admitted in ANY Domain sees every rooted Domain);
  topology-stripped rows `{ownerSignPub, operatorName, online}` only; opaque-reject on non-membership.
- **Discriminated share target** - Private / Everyone-I-trust / Specific. "Everyone I trust" resolves LIVE at
  the gateway via an `isLinked` predicate, so it tracks the trust set and can NEVER reach an unlinked Domain
  (the safety invariant, tested).
- **Owner-keyed untrust** - withdraws trust in a PERSON: drops the local friend graph, the gateway peer + share
  state (`CrossDomainPeers.removeByOwner` across all their Domains), AND the Router-side relay link edges.
- **The Users surface as the home** - a YOU section (name + 4-group fingerprint), a PEOPLE section, the per-row
  kebab (Manage shares -> Sharing, Untrust), Trusted badge, "Trust"/"Trust back", "N shared sessions" count,
  and an admin "Enroll a user" button. The old Federation hub + per-peer detail screens are retired.
- **Refactor A** - an owner-keyed friend graph + `ownerSignPub` threaded through the Android `LinkedDomain` /
  `CrossDomainPeerEntry`, so the owner-keyed roster joins back to the linked Domains.
- **Crust fixes** - `scripts/sync-leaf.ts` (atomic format -> restamp -> cp for the synced leaves) and the
  `bridgeSend` closed-enum fall-through.
- **SAS width unified at 6 digits** across both runtimes (was 12 cross-domain / 4 flow-2).

## Key design decisions (kept for reference)

- **Two trust flows, NO unified SAS fork** - FLOW-1 (in-person glance) and FLOW-2 (remote typed) both reuse the
  one owner-anchored 6-digit derivation; no third hybrid scheme.
- **6-digit per-ceremony CODE vs 16-char IDENTITY fingerprint** - the CODE is a per-ceremony MITM check, safe
  to be short because commit-reveal + single-flight bound an active MITM to ONE blind online guess (~1-in-10^6).
  The `fingerprint()` (SHA-256 first 8 bytes, 16 chars / 4 groups) is the stable identity shown on the Users
  page and is EMBEDDED in signed provision-op preimages - do NOT truncate it (breaks cross-runtime signatures).
  The two use deliberately different alphabets (6-decimal vs 16-hex) so they are never conflated.
- **Share model** - "share with everyone I trust" is bounded to the trusted set (not a true public) and resolved
  live at the gateway, never a frozen list.
- **Terminology** - "Link" (verb) -> "Trust"; "Peer" (noun) reserved for an already-linked network.
- **Security** - the FLOW-1 mutual compare replaces auto-trust (evie is no longer trusted to carry the
  user->admin key unverified). Codes are traded out-of-band by nature (Switchboard has no in-app chat surface).
  QR auto-dismisses ~1 minute before the token timeout (a put-down phone never leaves a live enroll QR exposed).
- **Owner directives (standing)** - (1) NO migration / back-compat / coexistence code in anything new (the owner
  wiped evie from scratch; build for the END STATE only). (2) The final implement slice is a dedicated CODE
  CLEANUP pass over the touched surface.

## Deferred (tracked, none blocking)

- **LATENT BUG (worth fixing) - nonce-pinning.** `signProvisionTenant` / `signRemoveTenant` are idempotent at
  evie (dedup by operatorSignPub + nonce) but `ChatRepository` calls them with NO pinned nonce, so a
  network-hiccup retry mints a fresh nonce and creates a DUPLICATE tenant provision/remove instead of replaying.
  The enroll-edge path already pins; pin these two the same way.
- **Framework-first refactor laundry** - the rendezvous-broker seam (EnrollHandshakeCoordinator vs the gateway
  CrossDomainHandshakeCoordinator), a ceremony-context factory, evie `onEnrollOp` table-driven dispatch, and the
  holistic dual-ceremony-wizard UI scaffold (the crypto cores stay justifiably separate).
- **Security / robustness laundry** - a global per-(requester, receiver) attempt cap (the per-token cap resets
  on re-listen; locus = evie/console-bridge); `confirm()` consumes the pairing before validating (fails closed,
  poor recovery); a defensive SAS-width zod bound; injective/fixed-slot SAS-preimage hardening + a committed
  leading-zero vector.
- **Monotonic snapshot-VERSION gate** - belt-and-suspenders only; `applyDomainSync` / `Allowlist.applySnapshot`
  already UNION the server snapshot over local for admissions AND revocations, so the union is the real rollback
  defense. Skip unless a concrete gap the union misses is found.
- **Final code-cleanup pass** - rip out dangling/unused code + legacy landmines across the touched surface (the
  clean-break the wipe enables). NOTE: the `evie_*` tool proxy is intentionally KEPT (CLAUDE.md), and the
  owner-keyed XDomainUntrust tombstone primitive is tested-but-currently-unused (untrust uses per-Domain relay
  revocations instead) - confirm before removing either. Landmarks: `XDomainLink`, `enrollSas`,
  `cross_domain_unlink`/`cross_domain_untrust`, `crossDomainShareState`, `CrossDomainPeers.removeByOwner`.

## Post-merge field bugs (fresh-provision round-trip, 2026-06-24) - bug CLASSES to watch

The first real end-to-end fresh provision after the merge surfaced a cluster of bugs that text/grep + the
unit suites could never catch (they only appear in a live first-root -> admit -> connect chain). Recording
the CLASSES, not just the instances, because each is a pattern likely to recur elsewhere.

### CLASS 1 (HEADLINE) - Frozen wire-time capture vs per-op resolution of a REFRESHABLE dependency

- **Instance:** evie `BridgeService.onEnrollOp` resolved `submit_admission`/`submit_revocation` against
  `coordinator`, a reference captured ONCE at console-bridge wire-up (`const coordinator = coordinatorFor(
  DEFAULT_DOMAIN_ID)`). But `firstRootDomain` calls `refreshCoordinator(home)` = DROP + re-vivify, replacing
  the home coordinator object after a first-root. So the captured ref was a stale, pre-root coordinator with
  an EMPTY `ownerSignPub`; every correctly owner-signed admission then failed `verifyAdmission(signed, "")`
  as "admission not owner-signed". Symptom chain: "Couldn't add the Gateway" on Approve, then the console's
  OWN admission silently never landing -> stuck "Finishing up enrollment" / "Can't connect". `admissions[]`
  stayed empty even though the phone signed with the real (rooted) owner key.
- **Why it hid:** the SAME file ALREADY resolved fresh-per-op for the cases that had been bug-reported before
  - the xdomain_link edge ops (`coordinatorFor(edge.srcDomainId)`, the User-First fix) and the tenant-op
    operator pin (an explicit "resolved PER OP, a getter not a frozen value" comment). Admissions/revocations
    were the one survivor still reading the frozen capture. A refresh-after-boot is invisible until a Domain
    is rooted AFTER evie starts (exactly the fresh-operator phone flow), which no test exercised.
- **Fix:** `const target = this.coordinatorFor(edgeDomain ?? DEFAULT_DOMAIN_ID)` - resolve every enroll op
  through the live cache. evie commit 958dcfa / PR #1406. Instant unblock was a pod restart (re-captures the
  now-rooted home into a fresh boot-time coordinator).
- **The CLASS / audit rule:** any handler that captures a per-tenant / per-Domain / otherwise-REPLACEABLE
  dependency at construction/wire-up, when something (first-root, rename, re-stage, hot-reload) can DROP +
  re-create that object mid-process, will serve stale state forever after the refresh. Resolve refreshable
  dependencies FRESH per invocation (a getter / lookup), never freeze them in a closure. Grep target: a
  `const x = lookupFor(...)` captured in an outer scope and then read inside a long-lived handler, where some
  other code path calls `drop`/`refresh`/`delete` on that same registry. A unit test that exercises
  "refresh the dependency, THEN invoke the handler, assert it sees the new state" would have caught it
  (deferred: evie has no BridgeService-level wiring test; the bug lives in the closure, not the coordinator).

### CLASS 2 - A generic catch-all user message that HIDES a captured, more-specific cause

- **Instance:** `enrollGateway` returned a flat "Couldn't add the Gateway. Try again." while `submitOwnerFact`
  had already written the real evie reason ("Admit failed: admission not owner-signed") into `_state.error`.
  Field-debugging was blind until we surfaced the captured cause. Fix: return `_state.error` (switchboard
  bf328e9).
- **The CLASS:** when an inner layer captures a precise failure reason, the outer user-facing message must
  surface it, not overwrite it with a friendly generic. A generic-over-specific swallow turns a 1-minute
  on-device diagnosis into a multi-hour log archaeology.

### CLASS 3 - One shared UI status var for BOTH error + progress, cleared only on entry

- **Instance:** `AddGatewayScreen` kept a single `status` used for the scan-parse error AND the enroll
  progress; a prior failed scan's "That QR is not a Gateway enrollment code." leaked onto a later VALID
  scan's confirm screen because `status` was reset only at screen entry, not at each scan result. Fix: clear
  on every scan result (bf328e9).
- **The CLASS:** a status/error field reused across transitions must be reset at the START of each transition,
  not once at mount.

### CLASS 4 - A state classifier whose meaning SHIFTED when an upstream flow changed

- **Instance:** `FriendOnboarding.noGatewayState` routes `firstRooted=true` -> AWAITING_HOST ("You're all set
  up", help-only, NO admit action). It was written when only FRIENDS first-rooted. The provisioning-model
  change made the OPERATOR's own home first-root too, so the operator landed on the friend board with no path
  to admit their Gateway. Fix: give the board a real "Add a Gateway" action regardless (switchboard dd82a02).
- **The CLASS:** when an upstream flow starts producing a state that a downstream classifier assumed only one
  persona could reach, the classifier's branches silently mis-serve the new persona. Re-audit every consumer
  of a predicate (`firstRooted`, `noGateway`, ...) whenever the set of producers widens.

### Operational footgun (not a code bug, but cost real time) - silent owner-key regeneration

- The owner root key is generated SILENTLY on first app start and never surfaced. A fresh INSTALL / cleared
  data mints a NEW key, orphaning an already-rooted Domain (admissions then fail "not owner-signed" against
  the old root) - with no on-screen hint that the key changed. Recovery is wipe-the-Domain + re-provision, OR
  the existing owner-key backup/restore (Manage Gateways). Worth a future "your owner key changed; this Domain
  was rooted by a different key - restore your backup or re-provision" detector instead of a cryptic admit
  failure. (This session it was a RED HERRING: the YOU fingerprint matched the root, so the real cause was
  CLASS 1, not a key mismatch - which is exactly why surfacing the real reason, CLASS 2, matters.)
