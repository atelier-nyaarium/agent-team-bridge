# Agents

Cross-team communication and devcontainer coordination. This file is a map, not history.

## Layout

- `src/main-mcp.ts` / `main-gateway.ts` / `main-host-daemon.ts` / `main-federation.ts` - four entry points
- `src/gateway/` - Docker-side HTTP and WS router
- `src/gateway/composeGateway.ts` - the whole gateway graph behind `GatewayDeps`, with `close()`; `index.ts` is the Bun process adapter
- `src/gateway/router/registerAuth.ts` / `valueResult.ts` - the `gateway_register` frame and the `value_result` settlement, pure
- `src/gateway/wake.ts` - container/session wake decisions
- `src/gateway/sessionAuthority.ts` - sole owner of credential-field access; residue-tested
- `src/gateway/presence.ts` / `readAnchors.ts` / `hostOpCoordinator.ts` - presence, read anchors, host RPC correlation
- `src/gateway/router/boardClient.ts` - Router-held task board client
- `src/gateway/boardAwareness.ts` - board awareness recipients and net-change classification
- `src/gateway/awarenessBank.ts` - subscriber state, deadlines, and liveness reads
- `src/gateway/daemonCapabilities.ts` - daemon capability answer
- `src/gateway/federation/contentKeyStore.ts` - gateway keyring, sole rule owner, sole writer of `content-keys.json`
- `src/gateway/federation/bootstrapInstall.ts` - staged bootstrap install and re-enrollment merge
- `src/gateway/codexAgentService.ts` / `codexRelay.ts` / `codexRoute.ts` - Codex catalog, relay folding, authenticated route
- `src/gateway/router/` - Router WS client; `pinnedSocket.ts` owns certificate pinning
- `src/gateway/router/inboxDeliveryPump.ts` / `inboxClaims.ts` / `sessionRegistryReporter.ts` - inbox drain with durable claims, and session registry reporting
- `src/gateway/router/presenceReporter.ts` / `presenceProtocol.ts` - presence pump and pure protocol; `applyAnswer` cannot reach the sender, so answers do not start frames
- `src/gateway/router/shareAttestor.ts` - share liveness attestation, coalesced
- `src/gateway/router/boardClient.ts` - sole sealer of board text and sole local-key mapper; CAS writes
- `src/gateway/router/blobUploader.ts` - blob copy to the Router cache or reference-held store; unwired, and the Router refuses both upload frames
- `src/gateway/console/` - Android OwnerOp dispatch and capability store
- `src/gateway/consolePushOps.ts` - phone-bound rows, `deliverToOwner`, and durable `OwnerRowOutbox`
- S8 retained endpoints: `/capabilities`, `/discover`, `/task-board`
- `android/.../ChatRepository.kt` - console process singleton, OwnerOp client, and home Gateway state
- `android/.../Message.kt` / `MessageFile.kt` / `MessageText.kt` / `Draft.kt` / `ThreadOps.kt` / `ReadAnchor.kt` / `ChatState.kt` / `ConnError.kt` / `FederationTypes.kt` / `ScheduledSend.kt` - repository value types and pure helpers
- `android/.../ChatPersistence.kt` - JSON codec between repository state and AppStateStore
- `android/.../PollDrain.kt` - owner-inbox tick, four plane cursors, and drain-gate subscribers
- `android/.../DrainGate.kt` / `DrainHost.kt` / `SessionHost.kt` / `PresenceHost.kt` - the re-entrant drain gate and one host interface per ops class, each with its repository adapter beside it
- `android/.../ReportReadCompose.kt` / `ScheduledSendCompose.kt` / `CapabilitiesCompose.kt` - pure phone composers
- `android/.../PlaybackOps.kt` / `PlaybackReadModels.kt` - playback serialization and lock-free read models
- `android/.../BoardOps.kt` - repository board operations
- `android/.../AttachmentOps.kt` - attachment fetch-and-sweep state
- `android/.../ScheduledSendOps.kt` - scheduled sends and single fire mutex
- `android/.../GoalOps.kt` / `Goal.kt` - armed goals and `/goal` line production
- `android/.../PresenceOps.kt` - team presence and read-anchor reporting
- `android/.../SessionOps.kt` - terminal and session controls
- `android/.../ChatRepositorySend.kt` / `ChatRepositoryThreads.kt` / `ChatRepositoryDomainLink.kt` / `ChatRepositoryStts.kt` / `ChatRepositoryDrafts.kt` - stateless repository extensions
- `android/.../RouterReach.kt` / `ConsoleRouterTransport.kt` / `ConsoleSocketMode` - Router addresses, the OwnerOp post with reach failover and pinning, socket mode
- `android/.../OwnerFacts.kt` / `GatewayEnrollment.kt` / `EnrollCeremonyOps.kt` / `DeviceApprovalOps.kt` / `DomainAdminOps.kt` / `TrustOps.kt` - federation delegates
- `android/.../SasExchange.kt` / `EnrollCeremony.kt` - shared SAS exchange and commitment core for FLOW-1 and FLOW-2
- `android/.../crypto/ContentKeyring.kt` - phone keyring, classify then commit
- `android/.../crypto/ContentAadKinds.kt` - sole AAD kind builders, twins of `content-envelope.ts`; `aad-kinds-residue.test.ts` pins both to one vector each
- `android/.../MainActivity.kt` - `Repo`, activity, and `App` navigation shell
- `android/.../SessionsScreen.kt` / `SettingsScreen.kt` / `ThreadScreen.kt` / `Onboarding.kt` / `SessionDialogs.kt` / `ReorderableTabRow.kt` / `TabDragMath.kt` / `TimeText.kt` - screen siblings and tab geometry
- `android/.../RendererPoolBindings.kt` / `AppOverlays.kt` / `LinkMenu.kt` - WebView pool, overlays, and link actions
- `android/.../SettingsSections.kt` / `SettingsSystem.kt` / `SettingsVoice.kt` - settings leaf screens
- `android/.../MainTabsScreen.kt` / `SessionsHeaders.kt` / `SessionCard.kt` / `SessionCardPreview.kt` / `SessionsEmptyState.kt` - sessions tab shell, cards, rules, and empty-state machine
- `android/.../board/` - board reducers and durable `BoardManager`
- `android/.../board/BoardSealing.kt` / `BoardRender.kt` / `BoardIntent.kt` / `BoardOptimistic.kt` / `BoardRouterWriter.kt` - board text sealing, render with cached fallback, edits held as intent, optimistic apply, and the CAS drain
- `android/.../ConsoleTransportCoordinator.kt` / `ConsoleSocketDriver.kt` - one Router consumer across two transports, and generation-fenced frame routing
- `android/.../Federation.kt` / `FederationManager.kt` / `CrossDomainLink.kt` / `ConsoleClientCrossDomain.kt` / `CrossDomainPresenceUi.kt` - cross-Gateway routing, identity, allowlist, sealing, replay, and presence
- `src/mcp/` - Claude Code tools
- `src/mcp/bridge/` / `channel/` / `references/` / `board/` / `designer/` / `connector/` - bridge, channel, reference, board, designer, and connector tools
- `src/mcp/devcontainer/` - host daemon plumbing and per-session tools
- `src/mcp/devcontainer/hostResolve.ts` - pure host/workdir/watch-target resolution and tmux command construction
- `src/mcp/devcontainer/windowsSpawn.ts` - Windows PowerShell probing, WSL path translation, and native directory listing
- `src/mcp/devcontainer/codexTargets.ts` - one supervised Codex App Server per execution target
- `src/mcp/devcontainer/codexAppServer.ts` - JSONL transport and fail-closed App Server client
- `src/mcp/devcontainer/codexThreadLifecycle.ts` - per-thread queues, settled-turn archival, bounded retirement
- `src/mcp/devcontainer/codexTurnTracker.ts` - turn output; sole `answerOf` reader
- `src/mcp/devcontainer/codexLiveTurns.ts` - live-turn bindings, clocks, and warnings
- `src/mcp/devcontainer/agentDaemonCore.ts` - shared daemon registry, generation fence, serialization, numbering, and outbox
- `src/mcp/devcontainer/codexDaemonService.ts` / `copilotDaemonService.ts` - daemon relay services
- `src/mcp/local/` - daemonless agent backend
- `src/mcp/agentDispatch.ts` - agent tool serving seam
- `src/mcp/codex/codexTools.ts` - five Codex tools and per-invocation replay ids
- `src/mcp/capabilities.ts` / `capabilitiesTool.ts` - capability gating and guidance
- `src/federation-server/` - live self-hosted federation Router
- `src/federation-server/routerServer.ts` - public `handle(Request)` over `preflight` and `dispatch`; sole `serve()` adapter; residue-tested
- `src/federation-server/fileSecretStore.ts` - durable federation state and bounded atomic CAS
- `src/federation-server/owner/` - per-owner state layer: fsync'd journal, CAS records, per-address rows, quarantine, lock, Domain quota
- `src/federation-server/inbox/` - inbox service, op ledger, consumer and session registries, gateway incarnation, OwnerOp intake, blob fetch route
- `src/federation-server/blobs/` - Router blob cache with leases and the reference-held store
- `src/federation-server/ownerServices.ts` / `ownerServiceHooks.ts` - the owner-state services behind one hook surface: OwnerOp kinds, gateway frames, register and drop listeners
- `src/federation-server/presence/` - presence rows per gateway incarnation, resync, roster, owner and friend projections
- `src/federation-server/share/` - share records, generations, attestations, sweep, unlink; the peer-row gate
- `src/federation-server/board/` - board records with sealed text, authority and cascade on the clear envelope, observation rows
- `src/federation-server/scheduled/` - scheduled sends: versioned records, timers, fire through the op ledger, result rows
- `src/federation-server/tier1/` - capability fold and read anchors
- `src/federation-server/migration/` - leases, serve gate, and cursor translation
- `src/shared/board-authority.ts` / `board-cascade.ts` / `board-structure.ts` / `board-observations.ts` - pure board rules shared by the gateway and the Router
- `src/shared/share-rules.ts` / `presence-projection.ts` / `presence-identity.ts` / `read-anchor-rules.ts` / `capability-fold.ts` - pure state rules shared by the gateway and the Router
  - **A mailbox epoch is a random tag, never a counter:** `mintEpoch` draws it. Compare epochs for
    EQUALITY only. Sequence orders rows within an epoch. Across epochs, the later report wins. The
    receiver stamps `at`; it decides cross-epoch merges. `ReadAnchor.kt` is the phone twin and
    resolves by row position.
- `src/federation-server/gatewayBridge.ts` / `gatewayTransport.ts` - registration and relay routing; four trust callbacks required
- `src/federation-server/consoleSurface.ts` / `publicApproval.ts` - token-gated operations and token-exempt nonce routes
- `src/federation-server/routerTls.ts` - persistent self-signed certificate; rotation re-provisions clients
- `src/federation-server/*Coordinator.ts` - in-memory flow windows; restart loses and re-arms them
- `src/shared/agent-binary.ts` - uncached backend CLI presence check
- `src/shared/capabilities.ts` - capability ids, guidance, daemon declarations, and bundle folding
- `src/shared/schemas.ts` / `schemas*.ts` - sole Zod wire truth; `.meta({id})` names generated Kotlin classes
- `src/shared/schemasWireFixture.ts` - shared wire fixture schema for both runtimes
- `src/shared/sealed-blob.ts` - per-chunk blob AEAD, twinned by `crypto/SealedBlob.kt` over a shared fixture corpus
- `src/shared/content-envelope.ts` - content key derivation, content envelope, key envelope, join signing bytes
  - **Board text binds its entry id into the AAD kind:** `boardTextAadKind` is the sole builder. A
    bare board kind does not typecheck. `BoardSealing.aad` is its Kotlin twin and must match byte for
    byte. The revision is absent. An untouched title or body keeps its envelope across edits. A device
    missing the epoch cannot re-seal it.
- `src/shared/schemasContentKey.ts` - content key wire shapes
- `src/shared/codex-agent.ts` / `codexAgent*.ts` - Codex delegation wire truth; excluded from Kotlin codegen
- `src/shared/channel-file.ts` - declared ChannelFile metadata; receivers do not infer it from bytes or position
- `src/shared/session-id.ts` - sole address grammar owner
- `src/shared/host-spawn.ts` - sole host-shell spawn-segment and command owner
- `src/shared/crypto.ts` / `admission.ts` / `router-protocol.ts` / `federation-lifecycle.ts` - federation trust wire vocabulary
- `src/shared/notice.ts` - shared notice tiers
- `src/shared/wire-vocabulary.ts` - sole TS declaration of Router paths, the console header, dispatched owner-op kinds, signing tags, nonce lengths; generated into `Protocol.Wire`; residue-fenced on both runtimes
- `src/shared/fixture-identity.ts` - the committed test signing keys; shipping entry points refuse them without `ALLOW_FIXTURE_IDENTITY=1`
- `src/shared/atomic-write.ts` - sole write-then-rename and temp-suffix owner; residue-tested
- `src/shared/durable-store.ts` - atomic snapshots and per-file quarantine boundaries
- `src/shared/session-store.ts` - authoritative gateway sessions keyed by `spawn.id`
- `src/shared/session-sanitize.ts` / `session-tokens.ts` - normalization, session ids, and bind tokens
- `src/shared/board-rank.ts` - sibling ordering and asserted fractional ranks
- `src/shared/agent-screen.ts` / `pane-trim.ts` - pure tmux-pane reads with Kotlin twins and shared fixtures
  - **A rule is a RUN, not a LINE, and `afterRuleRun` owns it:** `-J` welds rows. Windows panes weld composer rules to adjacent rows. Readers use `footerRegion`.
  - **Two rule notions are distinct:** `TOOLBAR_RUN_RE` is U+2500 only; `ANY_RULE_RUN_RE` spans U+2500-U+259F.
  - **`limitNotice` searches in two passes:** whole-line matches precede welded-rule matches.
  - **The composer glyph has two members:** Linux uses U+276F; Windows uses U+003E. Whitespace is explicit because JS and JVM `\s` differ for U+00A0.
  - **The last-two-lines fallback is uniform:** readers scope it to the final region.
- `src/shared/schemasConsoleOp.ts` - OwnerOp schema, `DELIVERY_OP_KINDS`, and `VALUE_OP_KINDS`
- `src/shared/pending-job-store.ts` / `plane-registry.ts` / `reconnect.ts` / `process-guards.ts` - shared jobs, planes, reconnect, and process guards
- `android/` - Gradle/Kotlin console app; `proto/Protocol.kt` generated
- `scripts/` - build, Kotlin codegen, leaf sync, setup, federation start, residue checks, and voice import
- `scripts/lib/routerStart.ts` - sole Router `.env` and startup owner
- `scripts/lib/verifyChecks.ts` - setup verification checks
- `android/.../SelfMigration.kt` / `CursorTranslationOps.kt` - phone self-migration and consumer cursor translation
- `android/.../ConsoleSocketClient.kt` - `ConsoleSocketMode`
- **Migration window reader:** `readRouterMigrationWindow`. A present null epoch means an unreadable file
- `tests/fixtures/` - shared golden wire and signing fixtures; manifests drive both runtimes
- `tests/fixtures/identity/set.json` - the one fixed identity set every harness and fixture generator reads; `scripts/gen-identity-set.ts` mints it
- `tests/fixtures/wire/ts/` / `wire/kotlin/` - minted wire fixtures, each runtime's real composers under the set; `scripts/gen-wire-fixtures.ts` and `WireFixtureGenerator.kt` write them, `check:fixtures` and `kotlin-gate.sh` diff them
- `src/testing/` - the federation harness, `fixtureWorld.ts`, real Router and gateway graph in-process, fake host and session sockets, the TS phone driver, the console socket; `docs/testing.md`
- `scripts/check-boot-runtime.ts` - the real entry points under Bun, one console op through a fake host
- `skills/crosstalk/SKILL.md` - agent-facing tool reference

## Architecture

**`main-mcp.ts`** MCP plugin, user process.
**`main-gateway.ts`** Docker gateway and central router.
**`main-host-daemon.ts`** host `host` WS slot, devcontainer wake, session spawn, terminal view.
**`main-federation.ts`** self-hosted federation relay.

| Port | Service |
|---|---|
| 20000 | Gateway HTTP and WS, loopback only |
| 20001 | Federation Router TLS |
| 20002 | MCP connector WS |
| 20003 | Enrollment TLS, one-time nonce |

How each subsystem works lives in `docs/`:

| File | Covers |
|---|---|
| `docs/architecture.md` | Addressing, host spawn points, sessions and wake, identity binding, state planes |
| `docs/federation.md` | Router, reach failover, TLS pinning, trust |
| `docs/console.md` | Console OwnerOp client, terminal view, armed goals, capability union, Android app |
| `docs/agents.md` | Codex and Copilot delegation, local agent mode |
| `docs/task-board.md` | Board, attachments, awareness |
| `docs/references.md` | `ref://` grammar and matchers |
| `docs/testing.md` | The federation harness, the minted wire fixtures, the identity set, the gates |
| `docs/environment.md` | Every environment variable |

## Development

### Commands

- `bun run lint` - Biome and `tsc`.
- `bun run test [path]` - Vitest.
- `bun run gen:fixtures` - regenerate the TS wire fixtures.
- `bun run check:fixtures` - regenerate the TS wire fixtures and diff.
- `bun run build patch|minor|major` - release build and commit.
- `bun run build --build-only` - bundle without versioning.
- `bun scripts/codegen-kotlin.ts` - regenerate Kotlin protocol types.
- `bun scripts/check-module-residue.ts` - verify `node_modules` against `bun.lock`.
- `bun scripts/import-stts-voices.ts` - regenerate the committed TTS catalog.
- `bun scripts/sync-leaf.ts <path>` or `--all` - synchronize a leaf.

### Push straight to `main`

Commit and push to `main`. Do not open a branch or a PR for ordinary work, and do not leave one
open: an unmerged PR is work the owner will forget.

Nothing gates a push but the local gates, so run them first. CI has no checks on this repo.

Run `gitFetch` and `gitPull` before every follow-up edit after a push. A non-empty
`git log main..origin/main` is a hard stop. Scripted edits must assert their match before writing.

`gitPushNewBranch` resets local `main` to `origin/main`, taking the commit with it, so the work then
lives only on the branch until the PR merges.

### Verify locally before pushing, especially Android

CI does not compile Kotlin before merge. Run:

```bash
./scripts/kotlin-gate.sh
```

Resolves the repo root and sources the SDK env itself, so it runs from any directory.

Regenerate Kotlin wire fixtures with `./gradlew :app:generateWireFixtures` from `android/`.

`testDebugUnitTest` is un-minified. Both debug and release are R8-minified, so verify reflective
Android and JavaScript bridge entry points with `assembleRelease` or on-device. The
`@JavascriptInterface` keep rule in `app/proguard-rules.pro` is load-bearing.

The sibling **evie-bot** repo must be checked inside its devcontainer:

```bash
bun run lint && bun run test
```

### Debug APK to the phone

The phone runs the CI build, signed with the stable key kept in `~/android-dev/secrets/`. `env.sh`
exports that key as the `ANDROID_KEYSTORE_*` variables the Gradle signing config reads, so a local
debug build installs straight over it. Without those exports the build signs with the default debug
key and the phone refuses the install. The version code must exceed the installed one.

```bash
source ~/android-dev/env.sh
INSTALLED=$(adb shell dumpsys package com.atelier_nyaarium.switchboard | grep -o 'versionCode=[0-9]*' | cut -d= -f2)
cd android && ANDROID_VERSION_CODE=$((INSTALLED + 1)) ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/switchboard-debug.apk
```

The phone stays on wireless adb; `adb devices` lists it. No push or CI round trip is needed.

### Emulator build

Use the `emulator` variant for visual inspection without onboarding or a real Gateway:

```bash
source ~/android-dev/env.sh
cd android && ./gradlew :app:assembleEmulator
adb install -r app/build/outputs/apk/emulator/switchboard-emulator.apk
adb shell pm grant com.atelier_nyaarium.switchboard.sandbox android.permission.POST_NOTIFICATIONS
adb shell am start -n com.atelier_nyaarium.switchboard.sandbox/com.atelier_nyaarium.switchboard.MainActivity
adb exec-out screencap -p > /tmp/shot.png
```

It installs beside the real app. Emulator seeding bypasses mailbox draining, so handler-created
state must be seeded directly. Run `adb emu kill` when finished.

### Dependencies

Exact pins only. After a manifest change:

```bash
rm -rf node_modules && bun install --frozen-lockfile
bun scripts/check-module-residue.ts
```

Bun leaves unsanctioned nested `node_modules` copies that can shadow the lockfile version.

### Synced leaves

| Source | Copy |
|--------|------|
| `src/shared/notice.ts` | `nyaaskills/src/shared/notice.ts` |

CI enforces the `SYNC-HASH` and the copy. Always use `sync-leaf.ts`: format, restamp, then copy.

### Code style

Biome: tabs, double quotes, semicolons, 120-character width.

**Do not sanitize invisible characters in display strings:** `oneLine` collapses ASCII whitespace,
which is the whole of it. No category strip, no bidi rule, no Unicode whitespace set.

### Testing

Vitest runs under Node. The gateway, Router, and daemon run under Bun. `ws` and WebSocket behavior
therefore differ. `bun run check:pinning` is the shipping-runtime gate. `bun run check:boot` is the
shipping-composition gate: it boots the real Router and gateway under Bun and runs one console op
through a fake host. The in-process harness and the fixture corpora are in `docs/testing.md`.

### Debugging the console on-device

Debug APK logs flush to the Router's `/ingest`; release does not. Logs are not private. Never log
bearer credentials, invite nonces, or minted secrets.

```bash
docker logs switchboard-federation --since 15m 2>&1 | grep '\[console-ingest\]'
```

### Restart ritual

`./start-all.sh` is `./down.sh`'s counterpart, starting all three in order. Each component script
stays independently usable; a Gateway-only machine runs `./start-gateway.sh` alone.

```bash
./start-all.sh
```

`start-federation.sh` rebuilds the Router image on every start.
`start-host-daemon.sh` restarts the daemon. Declining a restart leaves the running build serving.
`./setup.sh --verify` checks Router reachability and Gateway registration.

The Router certificate is not rotatable without re-provisioning enrolled Gateways and phones.
Clock drift breaks signed proofs and invite expiry.

## Deploying

### The four components update on SEPARATE triggers

| Component | Updates when |
|-----------|--------------|
| MCP plugin | marketplace pull or session restart under autoUpdate |
| Gateway | manual restart |
| Host daemon | `./start-host-daemon.sh` |
| Console | app update |

New wire fields OPTIONAL at the gateway and tolerated by both peers. Deploy gateway first, then push the version bump. The plugin can update before the other components.

That order covers fields the gateway EMITS. A change to what the Router ANSWERS deploys the Router first, since a gateway reads the answer it is given.

### Plugin

1. Commit source work.
2. Run `bun run build patch|minor|major`.
3. Push.
4. Reload target containers with `reload_plugins`.

The build derives versions, bundles `dist/`, and commits the release. Do not hand-edit version fields. Bun 1.4.0 or newer required.

### The lexicon submodule

`lexicon/` supplies the client at build and test time. `postinstall` links its packages into `node_modules/@nyaa-lexicon/`; runtime uses the bundled client.

- Fresh clone: `git submodule update --init` before `bun install`.
- Pin moves require a committed submodule change before release.
- Never install inside `lexicon/`. Nested `node_modules` shadow root dependency pins and produce duplicate packages.
- A real `node_modules/@nyaa-lexicon` directory is invalid. It must link into `lexicon/`.

### Installing

```bash
claude plugin marketplace add atelier-nyaarium/claude-marketplace
claude plugin install switchboard@atelier-nyaarium
```

### Federation

The gateway-to-Router WS is admission-only. No bearer fallback.

Run `./setup.sh` first. Admin Provision starts the Router, writes `.env`, and emits a direct transport blob containing the Router URL, `/health` fingerprint, and app token. An unreadable Router state must abort provisioning. An empty read can stage a new Domain over an existing rooted one.

Gateway Setup displays the admit payload and waits on the same screen for the phone's sealed bundle. `prompt()` blocks polling, so `readKeyWhile` uses raw mode and restores cooked mode on every exit. The screen prints the SAS from the admit payload. The countdown starts when `armGateway` returns, before health and payload waits. No LAN block means paste is the only enrollment route.

Purge Gateway removes only gateway state and gateway-owned `.env` keys. Purge Federation removes this owner's Domain slice first, then performs the gateway purge and removes the Domain id and setup code. The Domain id may come from `.env` or the Router's admin-Domain mark.

**Purge Gateway does not revoke the Gateway:** Only the phone holds the signing key. Use Revoke in the app.

**`.env` is shared by the gateway and Router:** Purges must preserve the file.

**The phone drops a revoked Gateway's board column:** `BoardManager.retainGateways` makes unreferenced attachment buckets collectible.

**The phone's half of Purge Federation is Forget this Domain:** Revoke and Delete is app-only because it purges the Domain server-side.

`scripts/lib/routerState.ts` keeps Bun `$` templates on one line. Bun treats a backslash-newline as an argument split, not continuation.
