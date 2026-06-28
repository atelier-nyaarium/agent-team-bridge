# Network-addressing migration: implementation progress

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
- [ ] `src/shared/pending-job-store.ts` - key by `SessionKey` (flatten at the Map boundary only);
      keep `dstDomainId`/`crossDomainBinding` seal-sourced.
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
