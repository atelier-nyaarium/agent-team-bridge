# Host-agent rename (`gateway` -> `host-agent`)

The home-retire + naming + fail-closed-identity refactor (Phases 0-5) is SHIPPED and green; this
plan is now the vetting + refinement of its final, separate phase: renaming the host-orchestrator
identity `gateway` so it stops colliding with the Docker Gateway server. Clean-break still applies
(the owner wipes evie + re-provisions from scratch; no migration / back-compat / coexistence code).

## Shipped (Phases 0-5) - summary

The literal `home` / `DEFAULT_DOMAIN_ID` Domain id is retired for a random hex id; the overloaded
`operator` is split by sense; identity loading fails closed. Green across all three runtimes
(switchboard gateway, evie-bot, Android); the exact `"home"` literal greps nowhere as a Domain id,
and `isPrimary` / `operatorName` / `operatorDomainId` / `operatorSignPub` / `SET_OPERATOR_NAME` are
gone.

**The enduring model** (carried into Phase 6):
- A **person** = one **Domain** (their trust identity / owner key) who stands up their own
  **Gateways** (machines) under it. `home` died because it conflated Domain and Gateway.
- The **admin** is the evie-runner who provisions other people's Domains; their Domain is the one
  flagged `isAdminDomain` on evie's `EnrollmentState`, resolved by `KubeSecretStore.adminDomainId()`
  (fail-closed `string | null`). A guest owns a Domain + its Gateways but is not the admin.
- The console addresses **Gateways** (no domainId on the wire); evie scopes the console relay + the
  register bootstrap carve-out to the `isAdminDomain` marker.
- Naming splits: the display NAME (any user's label) is `displayName`; the provisioner ROLE is
  `admin*` (`adminDomainId`, `adminSignPub`, `runGuardedAdminOp`); the admin-Domain marker is
  `isAdminDomain`. Signing-bytes are value-positional, so field renames are byte-stable; only a
  changed `*_V1` constant string re-cuts vectors.

**Commit anchors** (local `home-retire-refactor` branch, both repos, nothing pushed):
- Phase 0 admin marker: evie `018b6c8`, sw `4350c7a` (+ `888b5eb`)
- Phase 1 home-retire: evie `019ed18`, sw `316e83d`; Android `cf0731d`
- Phase 2 rename (operatorName->displayName, operator->admin, isPrimary->isAdminDomain): evie
  `b975262`/`be10077`/`5b3e7e8`/`f9f3eea`/`09a6aed`, sw `99bab5f`/`fab3dd7`/`769e034`/`0db29dc`/`0f96c82`
- Phase 3 vector re-cut + smell sweep: sw `aed8407`/`4d670d9`/`39b6e73`, evie `906bb99`
- Phase 4 fail-closed identity: sw `37559fe`
- Audit fixes: sw `c9adb1a`/`8dd4615`/`01741e2`/`ab2d8cd`, evie `dfa1056`/`9d9a529`

**Owner-driven, not done in code** (the Phase 5 deploy tail): the atomic clean-break wipe + rollout
(push evie -> push switchboard -> rebuild gateway -> re-provision -> flash the APK), plus the
semantic acceptance test (empty `displayName` roster row shows "(unnamed)", not the hex id) and the
on-device fresh-provision round-trip. Optionally bump `FEDERATION_PROTOCOL_VERSION` +
`CONSOLE_PROTOCOL_VERSION` so an old runtime fails fast.

**Open questions deferred from the refactor** (resolve as they touch Phase 6 or separately):
- The Phase-2 "Your Name" PHONE import gate (QR-scan disabled until a non-empty name, carried into
  first-root) was never built and appears superseded by the host `provision.ts` "prompts for the
  display name" model. Confirm whether the phone-side required-name gate is still wanted.

## Phase 6 - rename the host-agent identity `gateway` -> `host-agent` (the work to refine)

The host orchestrator is hardcoded as the team name `"gateway"` (`mcp/index.ts` `projectName`,
reserved in `websocket.ts` `RESERVED_TEAM_NAMES`, mapped to `kind: "gateway"` by `consoleHandler`),
which collides with the Docker Gateway server (also "Gateway"). Two different things share one name.

Rename only the host-AGENT identity name + its wire `kind` enum value to `host-agent` across:
- the gateway: `mcp/index.ts` (`projectName`), `websocket.ts` (`from` / `RESERVED_TEAM_NAMES`),
  `consoleHandler` (the `kind: "gateway"` mapping + `resolveTmuxTarget`), `routes`, `hostRelay`
- the wire: `schemas.ts` `TeamInfo` kind enum value + codegen `Protocol.kt`
- the app: every `kind == "gateway"` check + the `GatewayHeader` / host grouping

The Docker **Gateway server keeps its name** - only the host-agent renames.

UNVETTED: this phase needs its own gap-audit + red-team pass before implementing (cross-runtime wire
enum + the console terminal-view target resolution are the risk areas). The refinement below sharpens
the scope, the name choice, and the wire-compatibility story before any code.

## Minor (separate, low)

evie `CursorMergePullRequestAction.checkGHCLI` (CLASS 2) returns a hardcoded "GitHub CLI not found"
discarding `gh` stderr - unrelated cursor feature; fix the narrow stderr-surfacing if/when that area
is touched.
