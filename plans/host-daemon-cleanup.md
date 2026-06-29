# Host daemon cleanup, robustness, and de-duplication

The host-daemon peek-crash fix shipped (PR #81); the debug-log scaffolding and the host-disconnect
wake-stall (`wakeCoordinator.failAll`, PR #92) are already done. This plan collects the crust that
sweep turned up, refined by a 10-dimension code audit (every claim verified against the tree).
Locations are `file : scope : name` (no line numbers).

Phases run cheapest-and-safest first; each is independently shippable and green
(`bun run lint && bun run test`). No phase touches Android/Kotlin or codegen'd schemas (audit
confirmed), so no Android gate. Deploy per phase: gateway code needs `./start-gateway.sh`;
MCP-plugin code needs `reload_plugins`.

## Phase 1 - Dead code removal (no behavior change). Deploy: gateway rebuild + reload_plugins.

- `src/mcp/devcontainer/helpers.ts : ensureContainerUp` (sync) - zero callers; a ~45-line near-dup of `ensureContainerUpAsync` (the only live variant). Remove. (reload_plugins)
- `src/mcp/devcontainer/hostDaemon.ts : stopHostWakeListener` - exported, never called (not even in `main-host-daemon.ts`). Remove. (reload_plugins)
- `src/gateway/routes.ts : send : unreachable CLI-mode return` - keep the LIVE `channelOnly` guard (used by `consoleHandler` + `gatewayRelay`); remove ONLY the vestigial `return jsonResponse({ error: "CLI-mode agents are no longer supported." }, 400)`, unreachable because `ConnectionModeSchema` is single-value `'channel'`. It is one line, not "branches". (gateway)

## Phase 1b - RESPONSE_TIMEOUT_MS: incomplete wiring, not dead code (decide). Deploy: gateway.

Audit reclassification: `RESPONSE_TIMEOUT_MS` is read (`index.ts`) and threaded into config but NEVER
consumed. `PendingJobStore` is constructed with its hardcoded 600s default, and the gateway delivers
via `poll` with NO timeout enforcement (a `waitForResult` timeout path exists but only tests call
it). So this is a latent gap, not merely unused config. Decide:
- (a) Wire it: `new PendingJobStore(RESPONSE_TIMEOUT_MS)` so the env actually configures the TTL; or
- (b) Remove the env read + config field if poll-only with the 600s default is the intended design.

## Phase 2 - Quick security + docs. Deploy: gateway (SSRF), none (doc).

- `src/gateway/connectorProxy.ts : setupProxy` - the `{project}` segment is dialed as `ws://${project}:20002/ws` with no validation (an SSRF / arbitrary-egress primitive: `/connector/127.0.0.1/ws` dials anything). AUDIT CORRECTION: do NOT validate with `assertSlug`/`isTmuxName` - they reject legitimate dotted project dirs (`my.app`). Validate against the catalog (`isCatalogProject`, gateway/index.ts) at the `server.upgrade` site before `setupProxy`, so only known projects are dialable - the security-sound choice (charset-only `SHELL_SAFE_NAME_RE` still allows an internal-network scan). This is input validation, complementary to (not a replacement for) the GATEWAY_TOKEN auth gate in the postponed `gateway-auth-surface.md`.
- `CLAUDE.md : Key Paths : provision.ts` - references a non-existent `scripts/provision.ts`; `scripts/setup.ts` composes the three provisioning modules directly. Reword.

## Phase 3 - Robustness (needs care). Deploy: gateway.

- `src/gateway/index.ts : doWakeTeam : wake_result success:true ignored` - the gateway acts only on a failed `wake_result` plus the woken container's registration; `success:true` is a deliberate no-op, so a container that starts but never registers (Claude crashed on boot) burns the full `WAKE_TIMEOUT_MS` (10 min) despite a positive ack. AUDIT-CONFIRMED mechanism: do NOT resolve the wake on the ack alone - the team is not deliverable until it registers AND its channel listener boots (the send path sleeps ~3s then `registry.get`). Use a TWO-TIER timeout: on `success:true`, arm a SHORT registration window (~30s); if no register lands, fail fast ("started but not responding") instead of 10 min. Needs `WakeCoordinator` to track an "ack-received" state. Also thread `WAKE_TIMEOUT_MS` through config (unused after `doWakeTeam` today), and note 10 min outlives evie's ~55s opId hold.
- `src/shared/durable-store.ts : DurableStore : save` - an empty catch swallows ALL write errors; a persistent failure (full / read-only disk: ENOSPC/EROFS/EACCES) is invisible. Add a dedup-keyed `console.error('[durability] save failed', ...)` so a repeating error does not spam, WITHOUT changing the never-crash contract. Optionally suppress first-boot ENOENT.

## Phase 4 - Targeted de-duplication (audit-narrowed). Deploy: gateway.

AUDIT CORRECTION: the original "extract a shared `keyedSingleFlight` (4x) + correlator (3x)" is mostly
over-abstraction. The four "single-flight" sites differ structurally (`hostOpRunner` = inflight +
TTL-result cache + concurrency cap; `tmuxCore.sendChains` is SERIALIZATION-by-chaining, not dedup;
`consoleHandler.opCache` is LRU; `gateway/index.inflightWakes` is ~15 lines used once), and the waiter
sites differ too (`WakeCoordinator` is MULTI-waiter per key; the others single). A unifying helper
would need 5+ params and rival the originals; the "prevent the crash by construction" claim is
speculative. So drop the mega-extraction and keep only the clear wins:
- `src/gateway/evie/evieClient.ts : scheduleReconnect` - fixed 5s, no backoff. Switch to the shared `shared/reconnect.ts` `createReconnector` (used by hostDaemon + bridge/helpers). One-line, low-risk.
- `src/gateway/console/consoleHandler.ts : friendlyPeekError` - classifies by substring-matching tmux/docker stderr. Add a structured error-kind on the host-op layer (`shared/host-op.ts`) so classification does not depend on stderr wording (also helps the Android twin).
- `src/mcp/devcontainer/setEffortLevel.ts` + `compactSession.ts` - `execSync("bash -c ... base64 -d")` tmux drivers that bypass tmuxCore's safe no-shell `sendText`/`sendKey`. Route through tmuxCore.
- DROPPED: the `keyedSingleFlight` + pending-call mega-extraction. The sites are semantically distinct; tailoring each to its constraint is clearer than a leaky shared abstraction. Leave `inflightWakes` inline.

## Phase 5 - Fragile TUI automation (mostly upstream; revisit). Deploy: reload_plugins.

- `src/mcp/devcontainer/reloadPlugins.ts : buildScript` - ACTIVELY drives the Claude Code TUI: fixed sleeps, greps for the `❯` glyph + menu strings, hardcoded key nav; breaks on any UI change. Genuinely upstream-fragile; the real fix is a Claude Code `--update-plugins`/`--reconnect-mcp` flag. Until then it is a known-fragility script to hand-update on TUI changes.
- `src/mcp/devcontainer/tmuxCore.ts : awaitReady / STARTUP_PROMPT_RE` - clears startup menus by matching English strings. AUDIT CORRECTION: the real strings are "I am using this for local development", "Is this a project you created", "trust this folder", "Try the new fullscreen renderer" (the earlier "Choose the text style" / "Loading development channels" were wrong). NOTE: the core readiness check (`isAgentReady` = `COMPOSER_RE /^❯/`) is glyph-based and column-anchored, so it is STABLE; only the startup-menu clearing is string-fragile. A structured readiness signal from Claude Code would help `awaitReady` but not `buildScript` (which needs active control) - distinct problems.

## Open root cause (track, not yet scheduled). Deploy: reload_plugins.

- `src/mcp/devcontainer/hostDaemon.ts : buildLaunchCommand` - the in-container agent launches as a single `bash -c '...source ~/.bashrc...; exec claude...'`; if any step fails instantly (bashrc error, claude off PATH, bad cwd) the tmux session dies. Dead-launch DETECTION ships (`launchAlive` -> `wake_result success:false`, after ~8 probes / ~8s). Hardening is tractable but partial: pre-flight checks (bashrc readable, `which claude`, devcontainer cwd exists) catch the common static cases early; runtime failures still need the dead-launch fallback. The single `bash -c` is intentional (the env must be shared with `exec claude`; a multi-step spawn breaks env inheritance), so prefer pre-flight + stderr capture over splitting it. Devcontainer launches lack the host's `exec bash` fallback, so a crash leaves no diagnostic pane - consider adding one.
