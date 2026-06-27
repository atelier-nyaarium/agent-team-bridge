# Gateway vs Members/Users management UX

Designer project: `switchboard-peer-ux` (8d815705-fa46-4dc5-bd7d-c4007676ac8c) - https://claude.ai/design/p/8d815705-fa46-4dc5-bd7d-c4007676ac8c

## Problem (user-reported)

"'Add a gateway' takes you to the 'Manage Members' screen (that means manage users??) but the screen does have a button to add a Gateway anyways. You at some point regressed and blended the 2 flows of managing gateways and managing users."

## Current state (analysis)

Two genuinely distinct concept-spaces today:

- **Members** = local keyring. `ManageMembersScreen` (Management.kt:173, title "Manage Members") lists admitted `gateway` + `console` entries from `repo.admittedMembers()`, each with a fingerprint + Revoke. Footer button "Add Gateway" -> `AddGatewayScreen`. Empty state mislabels: "No gateways yet." "Who can reach my agents."
- **Users/People** = cross-Domain roster. `UsersScreen` (Users.kt:64, title "Users", section "PEOPLE") lists other owners from `repo.fetchRoster()`, with Trust / Trusted+Untrust / Manage shares (FLOW-2). "Who I trust + collaborate with."

The blend / bug:
- Home-board "Add a Gateway" buttons (MainActivity.kt:892/895/905) call `onManage` -> **ManageMembersScreen**, NOT `onAddGateway` -> AddGatewayScreen. So "Add a Gateway" dumps you on the members list; you must tap "Add Gateway" again to reach the scan. The code's own comments (lines 880, 898) claim it goes "straight to the Gateways screen" - the wiring drifted.
- `ManageMembersScreen` shows both gateways and consoles under "Members," and its empty text says "gateways" - so the name + content conflict, and "Members" reads as "users."

Entry points to ManageMembers today: SessionsScreen `onManage` (501), Settings "Manage Members" (1601), and the mis-routed board buttons.
Entry points to AddGateway today: ManageMembers footer (Management.kt:211), Users top-menu "Add gateway" (Users.kt:151).
Users/People reached via Settings -> Networks & Trust -> "Users" (1604, `onFederation`).

Other related screens: HostNetworksScreen ("Guest networks"), HostedTenantDetailScreen, AddNetworkScreen, LinkWizard, EnrollCeremonyScreen, SharingScreen, Settings hub (Profile/Voice/Networks & Trust/Security/System).

## Terminology in play

Gateway (a computer/host running agents) · Console (this phone / other phone installs) · Member (keyring = gateway+console) · User/People (cross-Domain owner/friend) · Network/Domain (an owner's root) · Guest network (a tenant you host) · Trust/Link (FLOW-2 cross-Domain edge) · Share (per-session access).

## Questionaire

**Q. "Add a Gateway" routing.** Decided: the board's "Add a Gateway" goes STRAIGHT to the scanner
(`AddGatewayScreen`), not the members list. The members list is a separate destination.

**Q. The bootstrap-help button wording.** The board's secondary action (opens `HostSetupHelpScreen`, the
text-only "run setup.sh on your computer" manual) is relabeled **"Running Gateway Setup"** (was a third
inconsistent wording: "Set up a computer" / "Setting up a host?" / screen title "Set up your own network").
Align the screen title to match when built.

**Q. Scanner bottom safe-area (cross-cutting).** Every QR SCANNER screen reserves bottom safe-area padding
so a pinned bottom control (the "Paste code" button) clears the OS gesture/nav bar - it must never sit under
it. Apply CONSISTENTLY to all scanner screens (AddGateway scan, the friend-enroll scan, the trust/link
compare scans). Build rule: `Modifier.navigationBarsPadding()` (or the WindowInsets equivalent) on the
scanner's bottom control, mirrored by the `.gnav` safe strip in the mockups.

**Q. Empty-board lede.** Simplified to **"The computer that runs your agents."** (was "A Gateway is a
computer that runs your agents. Add one to reach them. No computer yet? Set one up first.").

**Q. Where "share" lives (per-gateway?).** Sharing is per-SESSION, not per-gateway: `SharingScreen`
(Sharing.kt) + the share-control mockup are a SESSION list, each session set Private / Everyone-I-trust /
Specific people; only devcontainer + loose sessions are shareable. So a gateway can't BE the share unit.
PROPOSAL (shown in the "Gateway row menu" card): the per-machine kebab holds **Revoke** (its core) +
**Manage sharing** as a scoped shortcut into the per-session Sharing screen, filtered to that machine's
sessions. The canonical Sharing surface stays session-anchored (reachable session-side + per-user audit in
Users). PENDING user confirm: kebab = "Manage sharing" + "Revoke", or kebab = Revoke-only with sharing kept
purely session-level.

**Q. Does "THIS DEVICE" (the console) belong under Gateways?** No - your phone isn't a gateway; showing it
there re-blends the categories. REMOVED from the Gateways screen (now gateways-only). This device already
lives in EXISTING surfaces: Settings -> Profile shows "Device name" (+ "Your name", MainActivity.kt:1585),
and Owner Keys (Networks & Trust) + the Users "YOU" card show your identity/fingerprint. The code already
intends the split (MainActivity.kt:1598 "Two distinct concerns kept apart: managing gateways ... and
linking"). EDGE CASE: revoking OTHER enrolled phones (multi-console) -> a "Your devices" list under Profile
if/when multi-device is real; NOT Gateways. Single device is fully covered by Profile today.

**Q. Multi-device (CONFIRMED real).** Owner: "There will be more than 1 device. Multiple phones (or future
browser app) is a real possibility." So consoles are a managed set. Settles the hierarchy: NETWORK =
Gateways (computers) + Users (people); ACCOUNT = you + **Your devices** (your phones/browsers). Built the
"Your devices" surface (new card, group "Account · Peer UX"): Settings -> Profile -> "Your devices" (count)
-> a list of this phone ("THIS DEVICE", Active now, NOT removable) + other consoles (name, last-seen,
fingerprint, "Remove" = owner-signed console revocation) + a browser example (future) + "Add a device"
(the existing `authorize-console` enrollment type). The console member-list moves OUT of Gateways entirely
into this account surface; Gateways = gateways only. This is NOT a third network bucket - it's the standard
account "where you're signed in" pattern. PENDING user reaction to the card.

**Q. "Looking for people?" cross-link.** Removed from the Gateways screen (the owner found it noise).

**Q. "Clear & re-provision" should self-revoke at evie (DECIDED, build task).** Confirmed gap: `clearAll()`
(ChatRepository.kt:2306) is LOCAL-ONLY - cancels poll, `store.clearProvisioning()` (wipes
provisioning/identity/history locally), nulls clients, resets state. It makes NO evie call, so this
console's `kind:console` admission survives in evie's Domain keyring + every Gateway's mirrored allowlist
(orphaned device, still shown in "Your devices"). Make it owner-sign a revocation of its OWN console
admission and submit to evie (the `revokeMember(signPub)` path, ChatRepository.kt:929) BEFORE the local
wipe. Caveats: (1) best-effort - needs network; if offline, still wipe locally and warn "couldn't notify
your network; remove this device from another device"; (2) the local wipe destroys the key, so an
un-revoked orphan is INERT (no one holds the key) - this is hygiene + clean "Your devices" bookkeeping, not
an active-credential hole. SAME owner-signed-revocation mechanism backs "Your devices -> Remove" (revoke a
device you DON'T hold - that one IS the security action, since a lost device's key is intact).

IMPLICIT: bucket model A ("Gateways" + "Users") + the name "Gateways" - the owner has been refining the
Gateways screen without objecting to the name or asking for "Devices"/three buckets, so treat A as accepted
unless reopened.

## Plan

Mostly Android, but the audit surfaced TWO cross-repo pieces (Slice 5's delete-Domain op; Slice 4's "Add a
device"). Translate the locked Designer cards (groups "Gateways · Peer UX" + "Account · Peer UX") into Compose. Slices
are independently buildable; keep `:app:testDebugUnitTest` + `:app:assembleRelease` green at each.

Spine: a **Domain** = **Gateways** (computers) + **Users** (people); ACCOUNT = **Profile** holds you +
**Your devices**. The keyring still stores gateway+console members; the UI splits them by `kind`.

### Terminology (owner decision)
User-facing text says **"Domain"** everywhere - NEVER "Network" (it misreads as a wifi/work network:
"delete this network, not my home one"). Sweep the app + the mockups: "your network" -> "your Domain",
"Guest networks" -> "Guest Domains", the delete confirm, etc. **"Federation"** = the umbrella over ALL
Domains; keep it ONLY in the admin/`setup.sh` context (Purge Federation = the admin's top-level purge).

### Build order (lap-2: cross-repo gate)
Android-only slices ship FIRST + independently: **1 -> 2 -> 3 -> 7** (un-blend + scanner + biometric), then
**6** (terminology) last. The cross-repo features (**4 Add-a-device**, **5 Delete-Domain**) are HARD-BLOCKED
on synced-leaf schemas - they CANNOT go Android-first. Fixed order per feature (its "Slice 0"): define the
schema in `federation-lifecycle.ts` (synced) -> `bun scripts/sync-leaf.ts` -> `codegen-kotlin.ts`
(Protocol.kt) -> `cp` to evie -> evie handler -> BOTH repos `lint && test` -> THEN the Android UI. Slice 4
also needs Slice 1's `kind` filter first.

### Slice 1 - Gateways screen (rename + un-blend ManageMembers)
- `Management.kt`: `ManageMembersScreen` -> `GatewaysScreen`; title "Manage Members" -> "Gateways"; subtitle
  "Computers that run your agents."; empty state "No Gateways yet. Add one to get started."
- Filter `repo.admittedMembers()` to `kind == "gateway"`.
- DATA (audit): online/offline + the "N sessions" count are NOT on MemberInfo. Derive by grouping
  `state.teams` by `Team.gatewayId` (TeamAddress.parse; the mapping is clean) and JOIN with the gateway
  members.
- Per-gateway kebab: **Manage sharing** + **Revoke**. "Manage sharing" opens `SharingScreen` with a NEW
  optional `gatewayId` filter on `shareableSessions()` (feasible - shares key by session name and auto-scope
  when the list is filtered).
- Re-label entries: Settings "Manage Members" (MainActivity.kt:1601), SessionsScreen `onManage`, and the
  error-state button (917) -> "Gateways".

### Slice 2 - Board "Add a Gateway" routes straight to the scanner
- Thread an `onAddGateway` callback into the board composable (~MainActivity.kt:868); NoGatewayState buttons
  (892/895/905) call it instead of `onManage`.
- Bootstrap secondary button -> **"Running Gateway Setup"**; align `HostSetupHelpScreen` title to match.
- Empty-board lede -> "The computer that runs your agents."

### Slice 3 - Scanner bottom safe-area (CORRECTED scope)
- The friend-enroll / trust / link "compare" flows are TYPED 6-digit ceremonies, NOT QR scanners. There is
  ONE shared `QrScanScreen` (AddGateway + the provisioning scan); its Cancel/bottom control is the unpadded
  one. Add `Modifier.navigationBarsPadding()` to that single shared control.

### Slice 4 - Your devices (its OWN screen) + self-enroll
- New `YourDevicesScreen` as its OWN top-level screen (owner decision: NOT jammed into Profile). Reached
  from Settings as its own entry. List `kind == "console"` members: isSelf -> "THIS DEVICE" / Active now /
  NOT removable; others -> **Remove**. New `showYourDevices` nav state + BackHandler branch (~317-335).
- DATA: MemberInfo has only kind/gatewayId/signPub/boxPub/isSelf - no deviceName for OTHER consoles, no
  last-seen. Owner decision: ship MINIMAL (fingerprint + isSelf + this-device name; other devices a generic
  label, no last-seen). Roster+presence is a later add.
- **"Add a device" = USER SELF-ENROLL (owner decision: BUILD now).** The owner authorizes their OWN new
  device, no admin. Flow: held device shows a QR with ONLY public material (owner signPub/boxPub + domainId
  + a one-time nonce + the evie reach URL) - NEVER the SA token (audit security: a bearer cred in a
  shoulder-surfable QR). The new device scans, generates its console (sign+box) identity, POSTs its PUBLIC
  keys + nonce to a NEW evie `onConsoleApproval` intake. The held (owner-key) device queries pending
  approvals, shows the new key's fingerprint, and on Approve owner-signs the `kind:console` admission AND
  SEALS the evie transport to the NEW device's box key; the new device polls in its admission + sealed
  transport and operates. The SA token reaches the new device SEALED, not via the QR.
- SCHEMA (Slice 0 for this feature): a device-handoff envelope in `federation-lifecycle.ts` (synced) -
  `{ newSignPub, newBoxPub, nonce }` from the new device + an owner-signed approval carrying the admission +
  the sealed transport; plus `onConsoleApproval` + a pending-approvals query in evie's ConsoleBridgeServer.
  The admission signing path already exists.

### Slice 5 - "Revoke and Delete Domain" (REWORKED per owner decision)
- "Clear & re-provision" wipes the OWNER ROOT (PROVISIONING_KEYS includes KEY_OWNER_IDENTITY) and
  `ownerIdentity()` silently regenerates a new key -> it nukes the whole Domain + mints a different owner.
  clearAll() is also LOCAL-ONLY today (never told evie). Repurpose it:
- Rename **"Clear & re-provision" -> "Revoke and Delete Domain"**. HIDE for admin (`repo.isAdmin()`); admins
  use `setup.sh -> 0` (`purgeFederation` -> `removeDomain` at evie). SHOW for app-only USERS (friend-rooted
  owners, no setup.sh).
- A destructive **confirm dialog** FIRST (biometric-gated, Slice 7), stating clearly it PURGES this network
  from evie (not just this phone) and cannot be undone. TRANSACTION ordering (audit): owner-sign the delete
  op -> POST to evie -> AWAIT ack (timeout ~30s) -> on success OR timeout, THEN `clearAll()`. The sign
  happens in ChatRepository BEFORE clearAll so the owner key is still present if evie rejects; never leave a
  partial state (wiped-but-not-deleted / deleted-but-not-wiped). Offline -> still wipe + warn "couldn't
  reach the servers; ask the admin to purge it."
- SCHEMA (Slice 0 for this feature): a `delete_domain` `EnrollOp` variant + a `DELETE_DOMAIN_V1` signing-
  bytes helper (owner key + domainId + issuedAt + nonce, the existing newline-joined style) in
  `federation-lifecycle.ts` (synced). Evie handler verifies the signer IS the Domain's ROOTED owner (not a
  bystander) then drops the whole slice (admissions + revocations + links) from the Secret.
- Separate, smaller, Android-only: **"Your devices -> Remove"** = `revokeMember(consoleSignPub)` for ANOTHER
  console (Domain survives) - the existing mechanism.

### Slice 7 - Biometric gate on add + destructive actions (owner request)
- When `biometricLock` is enabled, require a `BiometricPrompt` re-auth IMMEDIATELY BEFORE each owner-key
  action, aborting the action (no signature) on cancel/fail: **Add a Gateway** (admit), **Add a device** ->
  the **Approve** step (signs the new console admission), **Revoke** (gateway), **Remove** (device),
  **Revoke and Delete Domain**. Factor as ONE wrapper - but the prompt needs a `FragmentActivity` (UI
  layer) while the owner-sign is suspend in ChatRepository, so add a `suspend promptBiometric(activity):
  Boolean` (`suspendCancellableCoroutine` over the existing callback-based `Biometric.promptUnlock`) and
  gate at the UI CALL SITE before invoking the repo's sign - not inside the repo. Infra already exists
  (Biometric.kt + LockScreen).
- Gate only when `biometricLock` is on (Security setting); if off, no extra prompt. BiometricPrompt falls
  back to device PIN. Reuses the existing biometric infra (the app-open LockScreen). Rationale: a grabbed
  unlocked phone must not add/remove/delete against your owner key.

### Out of scope
- Users / trust / sharing internals (only a scoped ENTRY into Sharing is added). NOTE: Slice 5 + the
  deferred "Add a device" DO need evie work (see open decisions); everything else is Android-only.

### Verify
- `:app:testDebugUnitTest` + `:app:assembleRelease` green. On-device: board "Add a Gateway" -> scan;
  Gateways shows gateways-only + kebab; Your devices list + Remove; Clear & re-provision drops the admission
  at evie (confirm from another device's keyring).

### Slice 6 - Terminology sweep
- "Manage Members" strings: ChatRepository ConnKind (~302-342, incl. "Add a Gateway from Manage Members"
  :323), ConsoleClient (~271). Re-point to "Gateways" / "Your devices".
- "Network" -> "Domain" everywhere user-facing (owner decision): board/empty-state copy, "Guest networks"
  -> "Guest Domains" (HostNetworks.kt), the setup.sh menu description (keep the "Purge Federation" label).
  "Federation" stays ONLY in admin/setup context.

### Decisions (resolved)
1. **"Revoke and Delete Domain":** BUILD the owner-signed delete-domain evie op (true purge) + a clear
   confirm that says it purges from evie. Cross-repo (evie + synced leaf + Android).
2. **"Add a device":** BUILD now as USER SELF-ENROLL (authorize-console; no admin). Biggest new feature this
   round. Cross-repo (Android generate/approve + scan/join; reuses the authorize-console schema, adds only
   the new-device->owner key-handoff envelope).
3. **Your devices:** its OWN screen (not in Profile). Ship MINIMAL device data (no roster/presence yet).
