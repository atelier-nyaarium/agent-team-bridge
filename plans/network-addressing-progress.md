# Network-addressing migration: implementation progress

## STATUS: Phase 0 + Phase 1 COMPLETE (committed, push held)

Commits: 51e6a73 plan · 7214eff Phase 0 · ffbb500 value objects · 5f8382d TS flip · c87a9a8
wipe/mint/resume · b4d4945 Android · f4ae894 caps · 41c170b red-team fixes. Both runtimes green
(TS lint + 733 tests; Android :app:testDebugUnitTest + :app:assembleRelease). Red-teamed: canonical
invariant + TS<->Kotlin equivalence hold.

NEXT (owner): the cutover - push, `./down.sh && ./start-gateway.sh && ./start-host-daemon.sh`,
install the APK, reload_plugins, then validate. AFTER that: Phase 2 (security review + retire the
forge-guard at routes.ts:691 - DO NOT do this pre-deploy). Phase 3 (struct wire) optional.

Deferred LOW (post-cutover cleanup): regenerate tests/fixtures/protocol/*.json old-grammar
session_ids (they decode fine today); the wipe-sentinel cross-dir edge under a custom FEDERATION_DIR;
add cross-runtime length-boundary vectors to vectors.json; the full host re-wake branch (currently
the simpler resume-exclusion). The old-grammar literals in code COMMENTS (gatewayRelay:182,
federation-protocol:21, team-name:14, ChatRepository:446) are cosmetic.

---


Resumable checklist for the Phase 1 atomic flip (see `network-addressing.md` for the design).
Driven by the `audited-implementation` cycle on `network-addressing.md`. On resume: re-read the plan,
`git log --oneline` for landed slices, `git diff` for in-progress edits, `bunx tsc --noEmit` for the
remaining repoint sites.

## Done
- [x] Plan committed (`51e6a73`)
- [x] Phase 0: conversationId slug-constrained at all 5 entry points (`7214eff`)
- [x] Slice 1a: new `Address`/`SpawnPoint`/`SessionKey` codec added to `session-id.ts`, additive +
      tested (`ffbb500`)

## Phase 1 atomic flip (one final commit once all green)

Legacy grammar to remove once callers move: `TeamAddress`, `SessionId`, `NoticeId`, the prefix/qualifier
constants, `parseSessionName`/`composeSessionName`/`isComposite` (rewrite as arity-2 local codec +
arity helper), and the `console-protocol.ts` shadow grammar.

TS repoint surface (14 files, ~116 refs):
- [ ] `src/shared/session-id.ts` - rewrite the local team codec onto `ADDRESS_SEP` (arity-2 split,
      drop the lastIndexOf/catalog logic); add an arity helper to replace `isComposite`; delete the
      legacy classes + constants once consumers move.
- [ ] `src/shared/host-op.ts` - `TMUX_NAME_RE`/`SHELL_SAFE_NAME_RE` -> import `isSlug` from session-id
      (keep `ALLOWED_KEYS`).
- [ ] `src/shared/console-protocol.ts` - delete the shadow grammar + re-exports.
- [ ] `src/shared/gateway-id.ts` / `domain-id.ts` - end sanitizers with `assertSlug`, drop the
      separator guard.
- [ ] `src/shared/owner-id.ts` - check (owner-id hex segment usage).
- [x] `src/shared/pending-job-store.ts` - DONE (uncommitted). Added `jobAddress(id)` =
      `parseStoreKey(id)` conv -> `Address`; repointed the share-match (`expireBySession`,
      `hasLiveCrossDomainThread`) onto `jobAddress(id)?.canonical` and the forge-guard `keyGateway`
      onto `jobAddress(id)?.gateway`. Dropped the now-unused `localGatewayId` param from
      `expireBySession`/`crossDomainBinding`/`hasLiveCrossDomainThread` (the new store key is fully
      qualified, no local resolution). CALLERS TO FIX: `index.ts:680,747,788`; tests
      `federation.test.ts` + `pending-job-store.test.ts` (drop the arg + port the old-grammar key
      literals like `conv:victim:alice-gw/lib` -> `conv.<conv>.<domain>.<gw>.<spawn>.<session>`).
- [ ] `src/gateway/routes.ts` - send/respond/wake/discover; `storeKey`/`parseStoreKey`;
      `Address.remote(resolved targetDomainId)`; gateway local-collapse on (domain,gateway); keep the
      forge-guard.
- [ ] `src/gateway/index.ts` - catalog + the one-shot wipe sentinel (after federationDir resolves,
      before restore); delete the past-due DATA_DIR migration block.
- [ ] `src/gateway/websocket.ts` - register write-guards `isComposite` -> arity; keep
      `knownTeamPaths.set`/`recordSessionResume`.
- [ ] `src/gateway/console/consoleHandler.ts` - `parseQualifiedTeam` sites -> `parseTarget`;
      `resolveTmuxTarget` simplifies (no catalog dot-disambiguation).
- [ ] `src/gateway/federation/gatewayRelay.ts` - returnRoute/relay address handling.
- [ ] `src/gateway/federation/crossDomainShareState.ts` - share key by the new canonical.
- [ ] `src/mcp/bridge/bridgeDiscover.ts` - `TeamAddress.remote(t.host,...)` -> value-object accessor.
- [ ] `src/mcp/devcontainer/hostDaemon.ts` - `parseSessionName`/`composeSessionName`; host wake branch.
- [ ] `src/mcp/team-name.ts` + `src/mcp/index.ts` - UNCONDITIONAL composite mint (a bare/unset
      `PROJECT_NAME` -> `project.<hex>`); deliver-if-online before the arity fail-fast.
- [ ] `src/shared/federation-protocol.ts` - raise `srcSession`/`session_id`/`from`/`to` caps to >=400.
- [ ] host wake: `kind:"host"` branch in `doWakeTeam` (gateway) + `handleWake` (daemon), bare tmux,
      `--resume` (or exclude host-spawn from `sessionResume`).

Cross-runtime (same commit):
- [ ] `scripts/codegen-kotlin.ts` - emit `ADDRESS_SEP` + `conv`/`notice` tags + `SLUG_RE`; repoint
      imports to `session-id.js`.
- [ ] regen `proto/Protocol.kt`.
- [ ] `android/.../proto/SessionId.kt` - rewrite twin to Address/SpawnPoint/SessionKey + arity.
- [ ] `android/.../ChatRepository.kt` - delete `canonicalThreadKey`/`recanonicalizeAllKeys`;
      schema-version wipe sentinel (before first parse: `remove(KEY_THREADS, KEY_LABELS, KEY_DRAFTS,
      KEY_SYNC_EPOCH, KEY_SYNC_ACKED, KEY_SYNC_DROPPED)`); repoint `isComposite`; display accessors.
- [ ] `android/.../MainActivity.kt` - `isComposite` sites (333,343,554), board nesting, tab labels;
      `substringAfter('/')` -> accessor; `ChatRepository.kt:2606`.
- [ ] `tests/fixtures/session-id/vectors.json` + `_signing-vectors-manifest.json` corpus regen.
- [ ] `tests/fixtures/protocol/*.json` golden session_id/team values regen.
- [ ] rewrite `src/__tests__/session-id.test.ts`; delete `gateway-naming.test.ts` +
      `ThreadKeyRepairTest.kt`; rewrite `SessionIdVectorsTest.kt`; add `ChatStateSessionsTest.kt`.
- [ ] gateway one-shot wipe of `cross-domain-share-state.json` (single file) under the sentinel.

Gates before the commit: `bun run lint && bun run test`; `cd android && ./gradlew :app:testDebugUnitTest`
AND `:app:assembleRelease`. Port `federation.test.ts` + `pending-job-store.test.ts` forge-guard cases.

## Update: entire non-test TS source flipped + GREEN (uncommitted WIP)

`bunx tsc --noEmit` is 0 errors across all of `src/` (non-test). Done this push (all uncommitted):
session-id.ts (legacy TeamAddress/SessionId/NoticeId + old constants DELETED; local codec kept,
rewritten onto ADDRESS_SEP; CONV_TAG/NOTICE_TAG exported), routes.ts (full repoint: storeKey/
parseStoreKey, parseTarget + spawn-point fail-fast, Address.remote with resolved domain, gateway
local-collapse, localAddress helper), pending-job-store.ts, gatewayRelay.ts (localDomainId threaded,
localShareTarget), index.ts (relay + console deps get localDomainId; dropped-arg callers fixed),
bridgeDiscover.ts (domain.gateway.spawn.session display), consoleHandler.ts (parseTarget everywhere,
localAddress, resolveTmuxTarget simplified), console-protocol.ts (shadow grammar DELETED),
gateway-id.ts / domain-id.ts (assertSlug), codegen-kotlin.ts (emits ADDRESS_SEP/CONV_TAG/NOTICE_TAG/
SLUG_PATTERN/MAX_*), Protocol.kt REGENERATED. Test deps fixed: console-handler.test.ts +
relay-pump.test.ts (localDomainId added); gateway-naming.test.ts DELETED.

INVARIANT held: routes.localAddress == gatewayRelay.localShareTarget == consoleHandler.localAddress ==
pending-job-store.jobAddress(id).canonical, all `domain.gateway.spawn.session`. The origin builds the
remote key with the RESOLVED targetDomainId (== the destination's localDomainId), so cross-domain
share keys + the forge-guard stay byte-identical.

## Remaining to GREEN (the red is now ONLY tests + Kotlin/Android)

1. `src/__tests__/federation.test.ts` (SECURITY SUITE - careful): add `localDomainId` to each
   createGatewayRelayHandler dep; drop the localGatewayId arg from crossDomainBinding/expireBySession/
   hasLiveCrossDomainThread; re-model every scenario onto COMPOSITE session names (old bare "api"/"lib"
   are now arity-1 spawn-points) and rewrite every key literal `conv:c1:bob-gw/lib` ->
   `conv.c1.<domain>.bob-gw.<spawn>.<session>`, share keys `hostb/lib` -> `<domain>.hostb.<spawn>.<sess>`.
   KEEP all four forge-guard cases asserting the same behavior. Remove the SessionId/TeamAddress import.
2. `src/__tests__/session-id.test.ts` + `tests/fixtures/session-id/vectors.json`: rewrite the vectors
   for Address/SpawnPoint/parseTarget/storeKey/parseStoreKey + the local codec; this suite + the Kotlin
   SessionIdVectorsTest.kt both read vectors.json.
3. Then `bun run lint && bun run test` GREEN -> commit the TS-side milestone.
4. Kotlin twin `android/.../proto/SessionId.kt` rewrite (Address/SpawnPoint/SessionKey + arity, using
   the generated Protocol.kt constants); `ChatRepository.kt` (drop canonicalThreadKey/recanonicalize,
   schema-version wipe, isComposite -> arity, display accessors); `MainActivity.kt` (isComposite sites
   333/343/554, board nesting, tab labels, substringAfter('/')); `ChatStateSessionsTest.kt`; rewrite
   `SessionIdVectorsTest.kt`; `tests/fixtures/protocol/*.json` golden session_ids.
5. Gateway one-shot wipe sentinel in index.ts (+ cross-domain-share-state.json) - still TODO.
6. mcp/team-name.ts + mcp/index.ts unconditional composite mint - still TODO.
7. Android gates: `./gradlew :app:testDebugUnitTest` + `:app:assembleRelease`.

## Resume notes (earlier; superseded by the Update above)

The tree is RED mid-flip (expected). Last GREEN commit: `a99a2e8`. Uncommitted edits so far:
`session-id.ts` (slice 1a already committed in `ffbb500`; nothing new uncommitted there) and
`pending-job-store.ts` (above). `git diff` shows the in-progress edits.

Next, in order:
1. `routes.ts` - the central producer/consumer. Replace `SessionId.channel(cid, addr).key` ->
   `storeKey({kind:"conv", conversationId, address})`; `SessionId.parse(id).key` ->
   re-canonicalize via `parseStoreKey`; `NoticeId.of(...).key` -> notice `storeKey`;
   `TeamAddress.parse(to)` -> `parseTarget(to, localDomainId, localGatewayId)` (branch
   Address vs SpawnPoint for the fail-fast); cross-gateway uses
   `Address.remote(targetDomainId(targetGateway,targetDomain) ?? localDomainId, ...)`; add the
   gateway local-collapse (route cross-gateway only when (domain,gateway) != local). KEEP the
   forge-guard at `routes.ts:691`.
2. CROSS-DOMAIN SHARE KEYING (security-critical, trace carefully - do NOT rush):
   - `gatewayRelay.ts:89,158` build `sessionTarget` via `TeamAddress.local(localGatewayId,name)`.
     Under the new grammar the share key is the full `Address.canonical`
     (`localDomain.localGateway.spawn.session`). Thread `localDomainId` into
     `GatewayRelayHandlerDeps` and build `Address.local(localDomainId, localGatewayId, ...parse
     bareName...)`. The friend's `op.to` is the local team field (spawn / spawn.session).
   - `crossDomainShareState.ts` keys shares by the canonical session target - must use the SAME
     new `Address.canonical`. Confirm `routes`/`index` `touchShares`/`isSharedTo` all agree.
   - INVARIANT: the share key, the `gatewayRelay` gate, and `pending-job-store.jobAddress` must
     produce byte-identical canonical strings, or shares silently stop matching.
3. `websocket.ts` register write-guards `isComposite` -> arity (keep the resume/known-path writes).
4. `index.ts` - the 3 pending-job-store callers (drop `localGatewayId`); catalog; the one-shot wipe
   sentinel (after federationDir resolves ~L97, before restore ~L142) incl `cross-domain-share-state.json`.
5. `consoleHandler.ts` `parseQualifiedTeam`/`resolveTmuxTarget`; `bridgeDiscover.ts`; `hostDaemon.ts`.
6. `mcp/team-name.ts` + `mcp/index.ts` unconditional composite mint; host wake branch.
7. `host-op.ts`/`gateway-id.ts`/`domain-id.ts`/`owner-id.ts` slug consolidation.
8. `federation-protocol.ts` caps >=400; `console-protocol.ts` shadow delete; DELETE legacy classes.
9. Rewrite TS tests (session-id/gateway-naming/federation/pending-job-store); `bun run lint && test`.
10. codegen + Protocol.kt + SessionId.kt twin + vectors + protocol fixtures + Android wipe/UI; Android gates.
