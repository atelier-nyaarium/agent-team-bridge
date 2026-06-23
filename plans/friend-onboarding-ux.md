# Friend cross-Domain onboarding redesign

## Questionaire

Vision so far (from the user):
- The friend does NOT manually create an owner key; the app auto-generates one silently on first start.
- Admin (operator + evie) creates the friend's Domain, then from that Domain entry generates the
  friend's provisioning QR, then runs the enrollment for them.
- The friend has NO gateway until AFTER the tenant-add completes (gateway bringup is a later,
  friend-side step).
- Supersedes the original "friend shows owner-key QR -> you Host" flow
  (cross-domain-federation.md S2, lines 307-328), which assumed the friend set up + showed their owner
  key before you could host. Also: `provision_tenant` / "Host a network" / the owner-key QR are
  DESIGNED but NOT BUILT (verified: no `provision_tenant` in evie or the app, no host-a-network UI).

**Q1. Who owns the friend's Domain root key?** -> **A: the FRIEND owns it.** The app auto-generates
the owner key silently; admin creates a PENDING tenant (domainId + label, NO root); the friend's app
submits its owner pubkey on first connect, which roots the Domain (a first-root). Admin never holds the
friend's key. (Rec A chosen: matches "the app generates the owner key on their phone" and keeps the
host-but-cannot-forge privacy posture; the only change vs the old plan is the root lands on the friend's
first connect instead of the admin scanning the key up front.)
- IMPLICATION: `provision_tenant` changes from the planned `{domainId, ownerSignPub, label}` to a PENDING
  `{domainId, label}` (no root); a NEW first-connect rooting path is needed (the friend's app submits its
  owner pubkey, evie first-roots the pending Domain at it - a first-root, never a re-root).

**Q2. Provisioning-QR redemption model?** -> **A: one-time bearer QR.** It carries the console-bridge
transport creds for the pending Domain; the FIRST phone to scan + connect roots it at its auto-generated
owner key, then the QR is spent (one-time, with a generous TTL ~1 day). Trust = you sent it to the right
person; isolation-by-default + the later Link/SAS are the real trust boundary. (Rec A chosen.)

**Q3. Gateway bringup + scope?** -> Admin guards ONLY the initial Domain/evie setup (the tenant add + the
phone provisioning QR). Once the friend's phone is in evie and controls the app, their GATEWAYS are
THEIRS - admin has NO sway, NOT policed (their own Claude subscription). The friend provisions gateways
via the EXISTING self-provision code paths, same as the operator configuring their own gateway today
(their phone, as their Domain owner, admits their own gateways). User: "We don't see each other after
initial domain tenant adds." So the gateway bringup is OUT of scope - it reuses the existing per-Domain
self-provision flow unchanged.

**SCOPE of this redesign** = (1) admin-side PENDING-tenant creation + (2) the silent-key + one-time-QR
phone onboarding that first-roots the friend's Domain. Everything after (gateways, devcontainers) is the
friend's own, existing code paths.

**Q4. Fresh-open UX (never provisioned)?** -> **B + keep it general.** ONE neutral fresh-open screen,
"Scan your setup code" up front (Scan QR / Paste / Open file), NO path labels ("redeem friend" /
"self-setup"). The SAME scan/import handles BOTH an operator provisioning blob AND a friend invite; the
app distinguishes from the blob on connect - an already-rooted Domain just provisions the console, a
pending tenant gets first-rooted at the silently-generated owner key. The user never picks a path. The
`provisioning.sh` instructions move to a TUCKED, text-only help screen behind a small "Setting up a
host" link (the operator finds it there; a friend with an invite never sees it). Reuses the existing
ProvisionScreen scan/import plumbing; the changes are: the neutral framing, the silent owner key (drop
the owner-key prompt), rooting-on-redeem of a pending tenant, and adding Paste + Open-file inputs.
(Current fresh open = ProvisionScreen: QR scan + run-provision-console.sh instructions + an
injected-blob path.)

**Q5. domainId + naming + the profile screen?** -> domainId = random hex/numeric, OPAQUE, never shown
(pure plumbing). The friendly NAME = the OPERATOR/NETWORK display name (one per owner/Domain), what Peers
see the network as. Admin PRE-SETS it when creating the guest's pending tenant (shows in the pending
row); the friend EDITS it from their PROFILE once in. Admin UI: a "Networks you host" list on the
Federation screen (separate from Peers - hosting != linking): [+ Add a network] -> label -> pending
tenant -> tap the entry -> [Generate invite QR] (+ Copy / Save-as-file, one-time, generous TTL) ->
states awaiting-setup -> offline -> (Link / Remove).
- PROFILE/naming model: TODAY "This device name" EXISTS + is editable (`deviceName`, per-console,
  `setDeviceName`). NEW: add "Operator name" (the owner's friendly NETWORK display name) to the profile -
  currently MY NETWORK only shows the opaque id + owner fingerprint, no editable friendly name. So the
  profile = Operator name (network, one per owner) + This device name (per install). The SAME profile
  serves the operator and the friend (both own their own networks).
- NOTE (threat model, for audit laps): COOPERATIVE / trusted-friends only - "I would never allow a
  stranger in. Like a team, where we opt to share insight on our codebases." So seeing everyone's
  (operator) names is fine; no identity hiding is needed. The trust boundary is who you link/share with,
  not name privacy.
- NOTE (migration): on the initial manual migration the existing owner's Operator name = "Nyaarium";
  otherwise the existing setup transitions transparently (the operator's own Domain becomes its own
  tenant; they gain the operator name + the host-a-friend UI, no re-provision).

**Q6. How does a linked friend's name display?** -> **A: their self-set operator name, propagated.** It
rides the cross-Domain link/discovery; you see "Carol" because Carol named her network that. The
owner-key fingerprint is the real identity, the name is a label. Spoofing is a non-issue: a duplicate
operator name is immediately obvious (two same-named rows -> you notice a friend is missing), and the
model assumes no attacker. (The link/discovery currently shows a local label - plan's original design -
so A means the operator name now rides the link, a small addition.)

## Plan (rough - for refinement)

Supersedes the original "Host a network = scan the friend's owner-key QR" flow (cross-domain-federation.md
S2). The friend never shows a key; the operator hosts a PENDING tenant and the friend's silent key roots
it on first connect.

**Backend (evie + gateway):**
1. `provision_tenant` (NEW, operator-signed, evie) creates a PENDING tenant: `{ domainId (random
   hex/numeric), operatorName }`, NO ownerSignPub, NO root. Plus `remove_tenant`. (Reuse the planned
   `PROVISION_TENANT_V1` operator-signature gate + skew + nonce-dedup; drop the ownerSignPub field.)
2. First-connect rooting (NEW): a console connecting with a pending-Domain transport submits its
   auto-generated owner pubkey; evie FIRST-ROOTS the pending Domain at it (idempotent; refuse a re-root
   at a different owner). The one-time invite QR carries the pending-Domain console-bridge transport
   (generous TTL, spent on first successful root).
3. Operator name lives on the Domain (evie) and PROPAGATES to Peers over the cross-Domain link/discovery
   (rides the link artifact / the discovery roster), replacing the local-alias display.

**App (Android):**
4. Silent owner-key generation on first start (no manual Owner setup / no "Show owner key").
5. Neutral fresh-open (rework ProvisionScreen): "Scan your setup code" + Scan QR / Paste / Open file,
   blob-driven - an already-rooted Domain provisions the console, a pending tenant first-roots at the
   silent key. The `provision-console.sh` steps move to a TUCKED text-only "Setting up a host" manual.
6. Profile screen: ADD "Operator name" (editable network display name) above the existing "This device
   name".
7. Admin "Networks you host" list on the Federation screen (separate from Peers): [+ Add a network] ->
   operatorName label -> `provision_tenant`; tap entry -> [Generate invite QR] (+ Copy / Save-as-file,
   one-time, TTL); states awaiting-setup -> offline -> (Link / Remove via `remove_tenant`).
8. Peers/discovery display the propagated operator name.

**Migration:** the operator's own Domain becomes its own tenant; set their Operator name to "Nyaarium";
otherwise transparent (no re-provision; they just gain the operator name + the host-a-friend UI).

**Threat model:** cooperative/trusted-friends only; names are shared (team-style), the trust boundary is
who you link/share with.

## Open refinements (cycle - to audit)

**R1. The operator path UNIFIES with the friend path (forced by the silent key).** Today the operator
reads their owner key off the Owner-setup screen and pastes it into `provision-console.sh`. With the key
generated silently on the phone, there is nothing to paste - so the operator's own onboarding becomes the
SAME as a friend's: `provision-console.sh` creates a PENDING Domain + emits the transport blob, and the
operator's phone first-roots it on scan. The manual owner-key step is removed entirely; operator and
friend share ONE root-on-connect mechanism. (The EXISTING operator install is already rooted - migration
is additive, no re-root. R1 is for fresh operator installs + all friends.)

**R2. Pending-tenant lifecycle (undecided).** (a) Unredeemed cleanup: does a never-redeemed pending
tenant auto-sweep after the QR TTL, or linger as "awaiting setup" until Removed? (b) QR regenerate: can
you mint a fresh one-time QR for the same pending tenant if the first expires/leaks? (c) Redeem race:
two phones scan the same QR - first-to-root wins, second gets "already claimed."

**R3. Operator-name propagation mechanics (undecided).** The name lives on the Domain at evie. How does
it reach Peers - on the discovery roster (evie carries the label; evie stays content-blind but now sees a
display name) or inside the signed link artifact? Is it mutable post-link (rename propagates) or pinned
at link time?

**R4. Lost-phone / re-key recovery.** Re-root is refused (Q1), so a friend who loses their phone cannot
re-root the same Domain. Recovery = operator `remove_tenant` + a fresh pending tenant (the friend
re-onboards from scratch). Confirm this is the only recovery and document it.

**R5. Fresh-open blob discrimination + provision-console.sh.** The app generates the silent owner key on
first start regardless; on scan it connects and the CONNECT RESULT says pending (-> submit owner pubkey,
first-root) vs already-rooted (-> just provision the console). `provision-console.sh` is reworked to
create a pending Domain + emit the transport, with NO owner-key prompt.

## Audit resolutions (refinement lap 1)

A plan-audit fan-out (11 agents, 76 findings) split into: ~40 "not built yet" (the IMPLEMENTATION SCOPE
this plan already owns - `provision_tenant`, the first-root op, the host-a-friend UI, the operatorName
fields - NOT design flaws), a set of CONFIRMATIONS, and the real design gaps resolved/surfaced below.

**Confirmed (design holds, no change):**
- The silent owner key is ALREADY implemented: `FederationManager.ownerIdentity()` generates + persists it
  on first access (encrypted-only). R5's "silent key on first start" needs no new app work.
- Mailbox isolation holds: the console inbox is keyed by `ownerKeyId(ownerSignPub)`; a friend's owner key
  differs from the operator's, so there is no cross-Domain mailbox sharing - the single-home-root console
  invariant (Phase B) is NOT violated.
- No regression to Phases C-F (linking / SAS / sharing / revocation) or the deferred gateway bringup.
- Hosting != linking stays: `provision_tenant` does NOT auto-submit a link edge; a host is isolated until a
  separate SAS Link.

**G1. First-root AUTH bootstrap (the load-bearing gap).** `consoleSealer`/`Allowlist` refuse EVERY console
op until the Domain is rooted (`ownerSignPub != null`), so a pending Domain's first connect cannot
authenticate to submit its owner pubkey. RESOLUTION - a narrow PENDING_ENROLL path:
- New console op `first_root { domainId, ownerSignPub, ownerBoxPub, nonce, issuedAt }`, SELF-signed by the
  console's fresh owner key. (Every signed op here also carries `issuedAt` + `nonce` for freshness/replay,
  matching the existing ADMISSION_V1 / registration-proof pattern.)
- `consoleSealer.open`: when `allowlist.ownerSignPub == null`, accept a self-signed frame for ONLY the
  `first_root` op (verify the sig against the frame's own signerSignPub + the one-time QR nonce); reject
  every other op with "Domain not yet rooted". After rooting, the normal admission-gated path resumes.
- New evie op `first_root_domain`: roots the pending Domain at the submitted key. Idempotent on the same
  key; refuse a re-root at a different key.
- evie `shouldVivifyCoordinator` + `getDomainSnapshot` must allow PENDING (unrooted, persisted) Domains
  (today they gate on `ownerSignPub`), else a pending Domain is unreachable.
- The register/connect result gains `domainStatus: "pending" | "rooted"` (new `ConsoleRegisterResult`
  field, codegen'd + cross-runtime-vectored) so the app knows to first-root vs just-provision.

**G2. One-time QR = atomic redemption.** The nonce lives in evie's Secret on the pending-Domain record
(issuedAt + TTL, server-checked). `first_root_domain` checks the nonce UNSPENT first, then roots + marks
it spent in ONE CAS Secret write (the Phase A resourceVersion precondition): two concurrent redeemers ->
exactly one wins, the loser gets "already claimed". Resolves the redeem race (R2c).

**G5. Migration, made concrete.** `KubeSecretStore.migrateSecret` sets `domains.home.operatorName =
"Nyaarium"` when undefined (the one-time backfill). `bootstrap-domain.ts` is EXTENDED (preserve
operatorName across the home-slice RMW), not strictly "retired" - fix that wording in
cross-domain-federation.md. The existing operator gains the host-a-friend UI when THIS feature ships.

**G6. provision.ts becomes a state machine.** Drop the owner-key paste. Fresh setup -> create a PENDING
Domain (no root) + emit the transport; the operator's phone first-roots on scan (R1). Re-provision of an
already-rooted home Domain -> skip bootstrap, emit the blob only. Branch on whether the home Domain
exists/is-rooted in the Secret.

**G9. Wording:** the vision's "we do the enrollment for them" -> "we arrange for them to be enrolled" (Q1
already clarifies the friend's app auto-enrolls; the admin only pre-stages the tenant + QR).

**UX build checklist (Phase-F build, not design blockers):** expired-QR message ("ask your host for a new
code"), already-claimed message, no-network vs bad-blob distinction, install-before-QR ("waiting for a
setup code"), empty-network-after-root (-> the tucked "Setting up a host" manual), an owner-key
FINGERPRINT in the profile for first-root troubleshooting.

### Resolved decisions

- **D1 (operator-name propagation) -> evie STORES + serves the name.** operatorName lives on evie's Domain
  record; it is returned on the register snapshot + the discovery roster, so Peers see it. A rename is a
  new OWNER-SIGNED console op (`SET_OPERATOR_NAME_V1`, versioned signing bytes) that evie CAS-merges onto
  the Domain and then fans a `domain_update`, so a rename DISPATCHES live to linked Peers (no re-link).
  DOCUMENTED content-blindness deviation: evie now holds a human display LABEL (it already knows the opaque
  domainId + keys; under the cooperative/no-strangers threat model a label adds no meaningful exposure).
  This is why D1-A beats riding the link artifact (which would pin the name at link time and need a
  signing-bytes change + new Kotlin vectors).
- **D2 (pending-tenant lifecycle) -> AUTO-SWEEP + regenerate.** An unredeemed pending tenant auto-removes at
  the QR TTL (~1 day) so no orphan rootless Domains accumulate; while alive it shows "awaiting setup" in the
  host list (Removable early). QR REGENERATE is allowed: minting a fresh nonce on the entry invalidates the
  prior one (for an expired/leaked QR), no remove + re-add needed.
- **D3 (fresh operator's name) -> provision.sh PROMPTS for it.** A fresh operator setup asks for the
  operator name (you type "Nyaarium") so the name exists from first setup, same as labeling a guest. The
  one-time migration backfills "Nyaarium" for the already-rooted existing operator.

Plan is refinement-complete. The novel first-root PENDING_ENROLL path (G1) + the atomic redemption (G2) are
security-sensitive and get adversarially RE-VERIFIED as code in the audited-implementation cycle's
red-team-fan-out when this is built (more meaningful against real code than a second prose audit).

## Implementation phases

Dependency-ordered (wire shapes first, app last). Each phase is one cycle lap. The crypto/admission/
enrollment leaves are SYNCED to evie-bot (restamp + cp), so Phase 1 lands the wire shapes in both repos
before the backends consume them.

## Phase 1 - Shared protocol + crypto
The wire vocabulary, in `src/shared/` (codegen'd to Kotlin, vectored cross-runtime, synced to evie):
- New ops + signing bytes: `provision_tenant` / `remove_tenant` (operator-signed, `PROVISION_TENANT_V1` /
  `REMOVE_TENANT_V1`), `first_root` console op (`FIRST_ROOT_V1`, self-signed by the fresh owner key, carries
  the QR nonce), `set_operator_name` (owner-signed, `SET_OPERATOR_NAME_V1`).
- Schema fields: pending-tenant record (operatorName, nonce, issuedAt, ttl, rooted), `domainStatus:
  "pending" | "rooted"` on `ConsoleRegisterResult`, `operatorName` on the Domain + `TeamInfo` discovery
  roster.
- Codegen `Protocol.kt`; add cross-runtime vectors for the new signing bytes (node + Kotlin byte-equal).
- Restamp sync-hashes + cp the touched leaves to evie-bot.

## Phase 2 - evie backend
`EnrollmentCoordinator` + `BridgeServer` (evie-bot): pending-tenant state (operatorName/nonce/TTL/rooted),
the `provision_tenant` / `remove_tenant` / `first_root_domain` / `set_operator_name` handlers, ATOMIC CAS
redemption (nonce-unspent-check + root + spend in one resourceVersion write), `shouldVivifyCoordinator` +
`getDomainSnapshot` for PENDING (unrooted) Domains, the `operatorName` on the discovery roster + `domain_update`
fan-out on rename, and the migration backfill (`migrateSecret` sets `home.operatorName = "Nyaarium"`).

## Phase 3 - Gateway
switchboard `gateway/`: the `consoleSealer` PENDING_ENROLL path (accept a self-signed frame for ONLY
`first_root` when `ownerSignPub == null`, nonce-gated), the `first_root` console op handler + `domainStatus`
on register, and operatorName propagation through `discover` + the `set_operator_name` relay.

## Phase 4 - Provisioning scripts
`scripts/`: `provision.ts` becomes a fresh-vs-reprovision state machine (drop the owner-key paste; fresh ->
create a PENDING Domain + prompt the operator name + emit transport; re-provision -> emit blob only).
`bootstrap-domain.ts` extended to preserve `operatorName` across the home-slice RMW.

## Phase 5 - Android app
`android/`: the neutral "Scan your setup code" fresh-open (QR / paste / file, blob-driven) + the tucked
host-setup manual, the first-root flow (silent key already exists; submit owner pubkey on `domainStatus:
pending`), the Profile "Operator name" field, the "Networks you host" admin UI (create pending tenant ->
generate one-time QR -> states / Link / Remove), propagated operator-name in the Peers display, and the UX
error/empty states (expired/claimed QR, no-network, install-before-QR, empty-network-after-root).
