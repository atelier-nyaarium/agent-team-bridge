# Network addressing: one grammar, one codec

Status: planned (not started). Owner-ratified design. Clean break, no back-compat. Refined through
two plan-refinement laps (30 audited concerns folded, ~20 dismissed as noise).

## Why

Addressing today is a three-delimiter soup. A full channel session id is
`conv:<conversationId>:<gatewayId>/<project>.<session>` with three separators and three parse rules
(`:` lastIndexOf, `/` first-indexOf, `.` lastIndexOf). That forces the dot-allowing
`SHELL_SAFE_NAME_RE` vs strict `TMUX_NAME_RE`, the catalog-first disambiguation hack, the
`isComposite` dot-heuristic, a bare-vs-qualified display duality, and a shadow grammar in
`console-protocol.ts`. Domain is not in the address; it rides as a sidecar field. We adopt one
network-style path and complete the value-object boundary so a change of this degree is a few hits in
one module.

## Constraints (owner directives)

- ONE phone, ONE machine. Personal single-owner system, very early in development.
- NO back-compat. No dual-parse, no migration window, no shim, no legacy parsers. Old persisted state
  is wiped on upgrade.
- Crypto leaves (`crypto.slugField`, the admission/SAS/link/transport vectors, byte-synced to evie)
  are out of scope and untouched; they use atomic slug fields and are insulated by structure.

## The grammar (ratified)

Qualified address, most-significant first: `domain.gateway.spawn.session`
(e.g. `a95dd4e979aa3be5.sakura.nyaadot.ik-tracking`).

- **One delimiter:** `ADDRESS_SEP = "."`, the only structural separator in any address/wire/store/
  thread key. Delete the `conv:`/`notice:` prefixes, `GATEWAY_QUALIFIER_SEP`, `SESSION_SEP`.
- **One slug validator:** `SLUG_RE = /^[a-z0-9][a-z0-9-]*$/`, `MAX_SLUG_LEN = 64`, `isSlug`/
  `assertSlug` (the existing `TMUX_NAME_RE`, promoted). `host-op.ts`, `schemas.ts`, `gateway-id.ts`,
  `domain-id.ts` all import it; validation runs inside the value-object constructors. Domain ids are
  lowercase hex, a strict subset. Dots/symbols are forbidden in spawn-point and gateway names.

### Two forms: the local team field and the qualified Address

- **Local team field** (registered, and in `TmuxTarget`): 1 segment = spawn-point, 2 = chat.
- **Qualified Address** (cross-gateway / board): 3 = remote spawn-point, 4 = remote chat.
- **Arity is the sole discriminator:** 1 local spawn / 2 local chat / 3 remote spawn / 4 remote chat,
  all distinct, dispatch injective. Deletes `isComposite` and the catalog dot-disambiguation.
- **Load-bearing invariant (enforced, not assumed):** an arity-1 name is produced ONLY by the catalog
  scanner and the reserved `host` slot; every CHAT registrant mints a composite. See Phase 0 (the mint
  must be unconditional - a bare `PROJECT_NAME` set via image ENV is a second bare-chat source).
- **Reserved `host`:** bare `host` (arity 1) IS the host spawn-point; its daemon registration stays
  authenticated/hidden via `RESERVED_TEAM_NAMES` + `HOST_WS_TOKEN`, not grammar-classified.

### Value objects (the sole grammar owner)

- `Address { domain, gateway, spawn, session }` (arity 4), `canonical = join(".")`; `spawnPoint`
  projection. `SpawnPoint { domain, gateway, spawn }` (arity 3), non-addressable (send fails fast).
- **Keep a local team-field codec INTERNAL to `session-id.ts`** (do not delete
  `composeSessionName`/`DEFAULT_SESSION`), but REWRITE it onto `ADDRESS_SEP` as a pure arity-2 split
  (drop the `lastIndexOf` dotted-project handling and the catalog-first comment; the dotless-slug rule
  means a local team field has exactly zero or one separator). It maps a bare spawn-point to
  `(spawn, DEFAULT_SESSION="claude")` as a wake/UI default only.
- **Factories (only place shorthand expands):** `Address.of(...)` strict; `Address.local(localDomain,
  localGateway, spawn, session)`; `Address.remote(domain, gateway, spawn, session)`; and ONE
  dispatcher `Address.parseTarget(wire, localDomain, localGateway): Address | SpawnPoint` -> split,
  count, `SpawnPoint` for {1,3}, `Address` for {2,4}, else throw. Send/console paths branch on the
  returned type for the friendly spawn-point fail-fast.
- **Local-collapse (decided):** the GATEWAY post-parse-collapses an arity-4 Address whose
  `(domain, gateway) == (localDomain, localGateway)` to a local chat. Implement by extending the
  existing cross-gateway send guard (`routes.ts:592-593`) from gateway-only to `(domain, gateway)`:
  route cross-gateway only when `(parsed.domain, parsed.gateway) != (localDomain, localGateway)`. The
  gateway must not assume the console pre-collapsed.
- **Arming-mode null domain:** `localDomainId` is `string | null` and stays null until enrollment, but
  every Address needs a domain segment. Reserve the sentinel slug `local` for the domain when
  `localDomainId` is null (it never collides with a hex domain id), OR require an enrolled domain
  before any persistent key forms and document arming-mode crosstalk as non-persisted. Phase 1 picks
  the sentinel (simpler) and states it.
- Injective by construction: dotless segments make `split` lossless, fixed arity makes positions
  unambiguous; no asymmetric splits, no third-colon guard.

### The conversation axis is a struct field, never a path segment

`SessionKey = { kind: "conv"; conversationId; address: Address } | { kind: "notice"; sender: Address }`
(one union; the notice case is the `kind:"notice"` arm, not a separate `NoticeKey` type). The gateway
holds `SessionKey`/`Address` objects and fuses to a string ONLY at the Map boundary.

- `conversationId` is a dotless slug, cap **128** (settle on one cap). All live producers comply.
- **Store key (one producer, store edge only) + inverse:**
  - conv: `["conv", conversationId, domain, gateway, spawn, session].join(".")` (6 segments)
  - notice: `["notice", domain, gateway, spawn, session].join(".")` (5 segments; the notice sender is
    a full arity-4 Address because `notify_human` is always called by a session-bearing agent)
  - `parseStoreKey`: split, position-0 tag selects the variant, fixed arity per variant; a crafted
    multi-segment id fails the arity check. This fused string is the opaque wire `session_id` the
    agent/console echoes verbatim; the agent never parses it.

## The non-negotiable security rule

Domain is a path segment for ROUTING and DISPLAY only, never a trust input.

- Cross-Domain trust gates (`gatewayRelay` response_push/collision, `pending-job-store`
  crossDomainBinding) read the seal-verified `srcDomainId` ONLY. A domain parsed off a wire string is
  never trusted for authorization, and `crossDomainBinding` is never re-derived from `parseStoreKey`.
- `dstDomainId` is sourced from TRUSTED state: the seal-verified `srcDomainId` on a destination job
  (`gatewayRelay.ts:142`), and the `crossDomainPeers`-resolved `targetDomain` on the origin anchor
  (`routes.ts:388-392`). Never from the wire address string. `friendDomainId` likewise.
- `SealTarget` stays an atomic `{domainId, gatewayId}` struct, derived from the Address ONCE at the
  seal boundary; a dotted string never reaches crypto.

## Display labels (separate from keys)

The thread/store KEY is the one canonical `Address.key`; the human DISPLAY label is separate and never
reaches `.canonical`. Add `Address` display accessors (TS + Kotlin twin). Default tab/title label =
the `session` segment; on collision among open tabs, escalate to the shortest unique suffix
(`session` -> `spawn.session` -> `gateway.spawn.session` -> full). The board nests
`domain -> gateway -> spawn -> session`, own-domain/own-gateway levels collapsed in the view only.
(These two surfaces are distinct: the flat tab/title rule vs the board tree.)

## Framework-first: complete the value-object boundary (the spine)

The boundary exists in `session-id.ts` but is ~70% and leaks. Make it absolute:

- **The rule (scoped):** no code outside `session-id.ts` (TS) / `proto/SessionId.kt` (Kotlin) may
  split/concat/slice/`substringAfter` on a delimiter when handling an ADDRESS/wire/store/thread key;
  produce only via `.canonical`/`.key`, consume only via a parser. Carve-out (foreign grammars, NOT
  addresses): the tmux `.0` pane suffix, k8s service-proxy URLs, base64url, and the internal cache
  keys `dedupKey` (`conv:opId`) / `targetKey` (`kind:name:session`) / `seenPeerGateways`
  (`domainId/gatewayId`). Document each as non-address.
- **Close the leaks:** delete the `console-protocol.ts` shadow grammar; repoint the five
  `parseQualifiedTeam` sites; fix `MainActivity.kt:1544` `substringAfter('/')` to a value-object
  accessor; change `crossDomainHandshake.parseListeningToken` to a `:`-delimited token
  (`gatewayId:base64url`) or struct fields.
- **The value object IS the map key:** `PendingJobStore` keys by `SessionKey`, flattens only at the
  Map boundary; `crossDomainBinding` keeps `dstDomainId = entry.dstDomainId` and `keyGateway` = the
  Address gateway segment.
- One slug primitive everywhere, validated inside constructors. Cross-runtime equivalence is a
  first-class contract (regen Protocol.kt + hand-twin + vectors in lockstep, gated by the LOCAL
  Android build since CI skips Kotlin pre-merge).

## Phases

### Phase 0 (S) - De-risk before the swap (no grammar change)
- Constrain `conversationId` to a dotless slug (cap 128, a dedicated regex refine, NOT `assertSlug`
  whose cap is 64) at ALL entry points: `SendRequestSchema.fromConversationId`,
  `ConsoleOpEnvelopeSchema.conversationId`, `WsRegisterSchema.conversationId`,
  `ProvisioningSchema.conversationId`, and `ReturnRouteSchema.srcConversationId`. Pure tightening.
- Make every chat registration composite, UNCONDITIONALLY: change `team-name.ts` + `mcp/index.ts` so
  a Claude registers a 2-segment name even when `PROJECT_NAME` is set to a bare catalog project
  (normalize `project` -> `project.<hex>` or `project + DEFAULT_SESSION`), not only the unset case.
  A bare 1-segment name must never be a chat. (Belt: deliver-if-online before the arity fail-fast so a
  live bare-registered peer is still reachable during rollout.)
- Add an `isSlug` guard to the catalog scanner (`hostDaemon.scanDevcontainerProjects`): a non-slug dir
  is skipped with a loud warning. Document dotless-slug dir naming (`my-app`, not `my.app`).
- Make the host a real re-wake target: add a `kind:"host"` branch to `doWakeTeam` (gateway) +
  `handleWake` (daemon) that resolves a host `TmuxTarget` (bare `tmux`, no container, `--resume` via
  `buildLaunchCommand`). Today the wake path is devcontainer-only, so a minted `host.<hex>` (and any
  board-spawned `host.<session>`) lists as asleep but cannot re-wake. This is also required for the
  "host is a symmetric spawn-point" claim. (Alternative if deferred: exclude host-spawn sessions from
  `sessionResume` so they never list as wakeable.)

### Phase 1 (XL) - The unified codec, cross-runtime + cross-process atomic
One commit (TS + Kotlin twin + codegen + vectors + the state wipes + the three-place version bump),
because the gateway and app speak the grammar to each other with no back-compat.
- Rewrite `session-id.ts` as the sole grammar owner: `SLUG_RE`/`isSlug`/`assertSlug`, `ADDRESS_SEP`,
  `Address[4]` + `SpawnPoint[3]` + the rewritten internal local team-field codec,
  `Address.of/local/remote` + `parseTarget`, `SessionKey` union, store-key producer + `parseStoreKey`,
  the local-collapse and arming-mode-`local`-sentinel rules. Domain in the Address is routing/display
  only.
- Repoint every TS caller: delete the `console-protocol.ts` shadow grammar; repoint `parseQualifiedTeam`
  sites; key `PendingJobStore` by `SessionKey`; rewire `routes`/`index`/`websocket`/`gatewayRelay`/
  `hostDaemon`. `host-op.ts` slug regexes -> imported `isSlug` (`ALLOWED_KEYS` stays); add
  `tmuxCore.ts` + `reloadPlugins.ts` (`assertTmuxName` -> `assertSlug`). `gateway-id`/`domain-id`
  sanitizers end with `assertSlug`, drop the separator guard. REPOINT the `websocket.ts` register
  write-guards from `isComposite` to arity dispatch (the `knownTeamPaths.set`/`recordSessionResume`
  writes stay).
- Cross-gateway key uses the DESTINATION's domain via `Address.remote(targetDomainId(targetGateway,
  targetDomain) ?? localDomainId, ...)` - the SAME authoritative resolution as the `dstDomainId`
  anchor, never the raw console `targetDomain` hint, so key-domain / SealTarget / dstDomainId stay
  byte-identical.
- Keep all trust gates on the seal-verified `srcDomainId`; `SealTarget` atomic; the inbound
  forge-guard at `routes.ts:691` STAYS (removal is Phase 2). Regression: with the binding FOUND under
  the genuine store key, a `response_push` whose seal-verified `srcDomainId != entry.dstDomainId` is
  denied EVEN WHEN its `srcGateway` matches the key's gateway segment (the existing Fix-1
  gateway-id-collision case), and a matching `srcDomainId` is delivered; the wire domain segment never
  changes the decision.
- Raise `federation-protocol.ts` `srcSession`/`session_id`/`from`/`to` caps to cover the worst-case
  conv key: `4 ("conv") + 128 (conv) + 4*64 (slugs) + 5 (dots) ~= 393`, so set `>= 400` and match it
  in codegen/Kotlin. (Delete the impossible "cap conversationId to 36" mitigation - 4 slugs alone are
  256.) Add the file to the edit list.
- Android, SAME APK: rewrite the `SessionId.kt` twin; add a persisted schema-version sentinel in
  `AppStateStore` that, BEFORE the first load-path parse, does
  `remove(KEY_THREADS, KEY_LABELS, KEY_DRAFTS, KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED)`
  (NOT `openTabs`, which is in-memory only). Delete `canonicalThreadKey`/`recanonicalizeAllKeys`/
  `ThreadKeyRepairTest` and the `flatLoose` board branch. Repoint ALL `isComposite` call sites to
  arity dispatch / a value-object accessor, not just the board: `MainActivity.kt:333,343,554` (the
  working-chip pokes + `terminalEligible`) and `ChatRepository.kt:2606`. Switch board nesting + tab
  labels to the display accessors.
- Gateway state wipe, one-shot: write a schema-version sentinel file in `DATA_DIR`; on mismatch,
  AFTER `federationDir`/`localDomainId` resolve (`index.ts` ~line 97) and BEFORE the restore block
  (line 142), wipe `pending-jobs.json` / `mailboxes.json` / `session-resume.json` and the single
  `federationDir/cross-domain-share-state.json` file (never its directory; `cross-domain-peers.json`,
  the keypair, allowlist, transport, `domain-id`, and `replay-guard.json` survive). Runs once.
- Regen ALL cross-runtime artifacts in this commit: `proto/Protocol.kt` (emit `ADDRESS_SEP` + the
  `conv`/`notice` tags + `SLUG_RE`/`MAX_SLUG_LEN`; repoint `codegen-kotlin.ts` imports to
  `session-id.js`), `tests/fixtures/session-id/vectors.json` (+ the `_signing-vectors-manifest.json`
  session-id corpus), the `tests/fixtures/protocol/*.json` golden session_id/team values, plus the
  Kotlin `SessionIdVectorsTest.kt` and `ChatStateSessionsTest.kt`.
- Gates: `bun run lint && bun run test`, then `android ./gradlew :app:testDebugUnitTest` AND
  `:app:assembleRelease` locally before push.
- **Cutover (one maintenance window; crosstalk DOWN during it, accepted):** the three-place version
  bump (`plugin.json`/`package.json`/MCP-server version) is IN this commit, so the single merge ships
  grammar + bump; then `./down.sh && ./start-gateway.sh` (rebuild runs the one-shot wipe) +
  `./start-host-daemon.sh`; install the new APK; `reload_plugins` on host + containers.

### Phase 2 (M) - Security pass: retire the redundant forge-guard
After Phase 1 is proven and gated on a security review.
- Target: the inbound `dstDomainId` forge-guard at `routes.ts:691`. The review must prove redundancy
  against the `response_push` keyGateway + `dstDomainId` comparison INCLUDING the local-caller-forge
  and friend-gateway-id==localGatewayId collision edges before removal; otherwise keep it.
- Converge ONLY the outbound, console-supplied `targetDomainId` routing hint onto the Address
  (it routes through `sealTargetFor`, validated against `crossDomainPeers`). `JobEntry.dstDomainId`
  and `friendDomainId` stay separate seal-sourced fields, NOT folded into the Address.
- Keep the forged-domain regression test green.

### Phase 3 (M) - Optional: fully struct-typed wire on respond/poll
Follow-up. Carry `{conversationId, Address}` as explicit wire fields on `respond`/`poll`/
`channel_reply` so the store key is composed identically on both sides and never round-trips from
untrusted input. The constrained-conversationId + fixed-arity grammar already makes the opaque echo
injective, so this is the cleanest-seam belt-and-suspenders, deferred to keep Phase 1 from bloating.

## Deletes / repoints (the decrust payoff)

Delete outright:
- `session-id.ts`: prefix/qualifier constants -> one `ADDRESS_SEP` + `conv`/`notice` tags;
  `isComposite`; the indexOf splits + third-colon guard; the `NoticeId` class (-> `SessionKey` notice
  variant). (KEEP and REWRITE `composeSessionName`/`parseSessionName`/`DEFAULT_SESSION` as the
  arity-2 internal local codec.)
- `console-protocol.ts:134-179`: the whole shadow grammar + re-exports.
- `host-op.ts:46-64`: `TMUX_NAME_RE`/`SHELL_SAFE_NAME_RE` + helpers -> single imported `isSlug`.
- `index.ts`: the past-due `DATA_DIR` migration block (slot becomes the one-shot wipe; mind the
  `federationDir` declaration order); the catalog dot rationale.
- `pending-job-store.ts`: the flatten-then-reparse round-trip -> key by the value object.
- Android `ChatRepository.kt`: `canonicalThreadKey` + `recanonicalizeAllKeys` + sites; the
  bare-vs-qualified display duality -> one canonical key + display accessors + the schema-version wipe.
- Android `MainActivity.kt`: the `flatLoose` board branch (board heuristics -> arity dispatch).
- Tests: `src/__tests__/gateway-naming.test.ts` and `ThreadKeyRepairTest.kt` (whole files);
  `session-id.test.ts` rewritten; the fixtures regenerated.

Repoint / port, do NOT remove (load-bearing):
- `websocket.ts` register write-guards: `isComposite` -> arity dispatch; the writes stay.
- `consoleHandler.ts` `parseQualifiedTeam` sites -> value-object accessors / `parseTarget`.
- `schemas.ts` register `team` regex -> split-and-`isSlug`-per-segment refine, arity {1,2}.
- `gateway-id.ts`/`domain-id.ts` sanitizers -> keep, end with `assertSlug`, drop the separator guard.
- `tmuxCore.ts`/`reloadPlugins.ts` `assertTmuxName` -> `assertSlug`.
- `MainActivity.kt:1544` `substringAfter('/')`, and the `isComposite` sites at `:333,343,554` +
  `ChatRepository.kt:2606` -> arity dispatch / accessors.
- `src/__tests__/federation.test.ts` and `src/__tests__/pending-job-store.test.ts`: port every
  old-grammar session-id literal to the new store-key grammar and KEEP all four forge-guard cases
  (gateway-id-collision deny, legit allow, local-job hard-deny, local-send-cannot-stamp-binding).

## Risks (top, with mitigations)

- HIGH - bare ad-hoc/host or set-bare-`PROJECT_NAME` chats break "arity-1 = spawn-point". Mitigation:
  unconditional composite mint in Phase 0 + deliver-if-online before arity fail-fast; accept/reject
  vectors.
- HIGH - domain-in-path trusted by an authz gate reopens the reply-forge hole. Mitigation: forge-guard
  stays in Phase 1 with the binding-found regression test; `dstDomainId`/`friendDomainId` stay
  seal/peer-sourced; guard removal deferred to the reviewed Phase 2.
- HIGH - a `conversationId` with `.` mis-parses the 6-segment key. Mitigation: Phase 0 slug-constrains
  all entry points incl `srcConversationId`; `parseStoreKey` arity is the backstop.
- HIGH - a dotted address reaching crypto breaks the byte-synced Kotlin vectors only on main.
  Mitigation: parse to an atomic `SealTarget` once at the edge; run the evie gate.
- HIGH - Android wipe + `canonicalThreadKey` deletion must be IN Phase 1 (else the new APK boots
  against unparseable keys / fails to compile). Mitigation: folded into Phase 1, wipe before first
  parse.
- HIGH - gateway wipe without a one-shot gate wipes delivery state every restart. Mitigation: a
  `DATA_DIR` schema-version sentinel, placed after `federationDir` resolves and before restore.
- HIGH - cross-domain reply drops if the key carries the origin's domain. Mitigation:
  `Address.remote(resolved targetDomainId, ...)` in `sendCrossGateway`.
- MEDIUM - minted `host.<hex>` lists asleep but cannot re-wake (devcontainer-only wake). Mitigation:
  the Phase 0 `kind:"host"` wake branch (or exclude host-spawn from `sessionResume`).
- MEDIUM - arming-mode `localDomainId==null` cannot form a domain-bearing key. Mitigation: the `local`
  sentinel domain slug.
- MEDIUM - `federation-protocol.ts` caps too small for full dotted keys. Mitigation: raise to >= 400.
- MEDIUM - pure arity dispatch loses "this-gateway-qualified resolves locally." Mitigation: gateway
  post-parse local-collapse on `(domain, gateway)`.
- MEDIUM - `cross-domain-share-state.json` embeds the old grammar; omit from the wipe and shares
  resolve against stale keys. Mitigation: file-specific delete under the one-shot sentinel.
- MEDIUM - the hand-twin + codegen + protocol/session-id fixtures drift undetected (CI skips Kotlin on
  PRs). Mitigation: regen all in the same atomic commit; run the local Android build.
- MEDIUM - APK update does not clear app data. Mitigation: the Phase 1 schema-version wipe sentinel
  (precise key list above).
- MEDIUM - strict dotless slug breaks real dir names. Mitigation: Phase 0 skip-and-warn; document
  dotless-slug naming.
- LOW - `parseListeningToken`'s `.`-token is ambiguous with a 2-segment chat. Mitigation: `:` token or
  struct fields; the framework no-split carve-out list.
- LOW - wiping `session-resume.json` drops asleep sessions; wiping `pending-jobs.json` 404s in-flight
  replies. Mitigation: accepted per clean-break; live tmux self-heals; note in release.
