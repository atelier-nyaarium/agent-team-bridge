# Agents

Cross-team communication and devcontainer coordination for Claude agent teams. Teams register with a
Gateway over WebSocket; Gateways federate through evie-bot (a content-blind router in k8s) to reach
other machines and the native Android console.

This file is a MAP, not a history. Keep entries to a sentence. Anything derivable by reading the
code does not belong here; rationale lives in `git log`.

## Layout

- `src/main-mcp.ts` / `main-gateway.ts` / `main-host-daemon.ts` - the three entry points
- `src/gateway/` - the Docker-side HTTP + WS router (`index.ts`, `routes.ts`, `websocket.ts`)
  - `wake.ts` - on-demand container/session startup; `decideWakeCreate` is the pure, unit-testable
    create-vs-reattach-vs-refuse decision
  - `sessionAuthority.ts` - the SOLE owner of "what must a caller prove to act as X". A residue test
    fails the build if any other module reads the credential fields
  - `presence.ts` / `readAnchors.ts` / `hostOpCoordinator.ts` - presence plane, cross-device read
    anchors, host RPC correlation
  - `evie/` - WS client to evie-bot over the k8s API service-proxy
  - `console/` - gateway side of the Android channel: op dispatch, the `ConsolePeer` virtual peer,
    the capability store, the relay pump, the durable op store
  - `federation/` - cross-Gateway routing (`gatewayRelay.ts`), identity, allowlist, sealer, replay
    guard, cross-Domain presence
- `src/mcp/` - the tools registered into Claude Code
  - `bridge/` - `crosstalk_send` / `_discover` / `_wait`, plus shared reply helpers and the
    escaped-newline lint
  - `channel/` - `channel_reply`, `channel_reply_structured`, `notify_human`, channel push
  - `references/` - `ref://` resolution: lexer, grammar, tree-sitter resolver, artifact builder
  - `designer/` / `connector/` - designer cards; game-client connector
  - `devcontainer/` - host daemon plumbing (`hostDaemon.ts`, `hostOpRunner.ts`, `tmuxCore.ts`) plus
    the per-session tools every peer registers
  - `capabilities.ts` - the bounded read of the gateway's capability union, done before the McpServer
    exists so it can gate tool registration
- `src/shared/` - wire truth and utilities used by both sides
  - `schemas.ts` - THE single zod truth for every wire shape. Every schema carries `.meta({id})`,
    which is its generated Kotlin class name
  - `channel-file.ts` - the ChannelFile wire shape, zod-only and NOT a leaf (evie never reads it);
    its own module because schemas.ts and federation-protocol.ts both consume it and would cycle.
    A file DECLARES what it is here (`role`, plus the ref and design-card facts a receiver would
    otherwise have to open the bytes to learn); no receiver may re-derive that from content,
    filename, array position, or message direction
  - `session-id.ts` - the SOLE owner of the address grammar (see Addressing below)
  - `crypto.ts` / `admission.ts` / `federation-lifecycle.ts` / `evie-protocol.ts` - the synced leaves
  - `notice.ts` - the four notice tiers both reply tools and the console wire share
  - `durable-store.ts` - atomic JSON snapshots, plus the per-file restore boundaries that quarantine
    a poisoned file instead of letting it take down every other consumer's state
  - `session-store.ts` - the gateway's authoritative session records, keyed by `spawn.id`
  - `device-mailbox.ts` / `pending-job-store.ts` / `plane-registry.ts` / `reconnect.ts` /
    `process-guards.ts`
- `android/` - the console app (Gradle/Kotlin). `proto/Protocol.kt` is generated, not hand-written
- `scripts/` - `bump-version.ts`, `codegen-kotlin.ts`, `sync-leaf.ts`, `setup.ts` (the admin menu),
  `check-module-residue.ts`, `import-stts-voices.ts`, `build-grammars.ts`
- `tests/fixtures/` - golden wire fixtures and signing vectors read by BOTH vitest and the Kotlin
  tests. `_manifest.json` and `_signing-vectors-manifest.json` are the inventories both runtimes
  iterate, so a new corpus cannot be read by only one side
- `skills/crosstalk/SKILL.md` - the agent-facing tool reference

## Architecture

**MCP plugin** (`main-mcp.ts`) runs in the user's process, loaded via `.mcp.json`.
**Gateway** (`main-gateway.ts`) runs in Docker as one machine's central router.
**Host daemon** (`main-host-daemon.ts`) runs headless on the host and owns the reserved `host` WS
slot: devcontainer wake, session spawn, and the console terminal view. It carries no Claude session.

| Port  | Service                           |
|-------|-----------------------------------|
| 20000 | Gateway (HTTP + WS)               |
| 20001 | Evie bridge server (tool call WS) |
| 20002 | MCP connector (game client WS)    |

### Channel conversations

Every connection is channel mode; the old CLI dispatch path is gone. Each MCP process mints one
stable `conversation_id` at startup and keeps it across reconnects.

- The job key is `storeKey({kind:"conv", conversationId, address})`, so every send between the same
  (sender, target) pair lands in one entry and callers never manage session_ids.
- Channel entries are `persistent: true` and never TTL-swept. Transient ones expire at 600s.
- `channel_reply` may be called any number of times on a session_id. There is no finality.
- Replies push to the specific sender sub-session, so parallel windows do not cross streams.

### Addressing

`shared/session-id.ts` is the one producer of every session/team key: one separator (`.`), one slug
validator, the `Address` value object (`domain.gateway.spawn.session`), `SpawnPoint` (3 segments,
non-addressable), and `parseTarget` arity dispatch. A store key and a lookup key are the same value
by construction. The Kotlin twin is `android/.../proto/SessionId.kt`, held equivalent by
`tests/fixtures/session-id/vectors.json`.

The gateway keys teams by bare local fields internally and qualifies to a full `Address` only at the
wire edge. Domain id is the `local` sentinel until enrollment. A bare `project` is a spawn-point
(catalog membership decides this, NOT the dot test, so `my.app` is still a project); a send to one
fails fast.

### Sessions and wake

Devcontainer sessions are `project.session` loose peers. The daemon launches one by overriding
`PROJECT_NAME=<project.session>` so the in-container MCP registers under the composite name, which
completes the wake. `SessionStore` is the durable known-session list: a re-wake reattaches live tmux,
else `claude --resume`s the transcript, else launches fresh.

- A send to an asleep composite with a record reattaches it.
- A send to a composite with NO record requires `displayLabel`; it mints an opaque id, so the woken
  session lands at the minted address, never the typed one. Without the label the send fails fast.
- The host machine is a symmetric spawn-point: same `create_session` / `forget` / resume path, but
  starts in `~/projects/<label>` via `resolveHostWorkdir`.
- The daemon's own `host-daemon` session is reserved and refused at every sink.

### Session identity binding

A `SessionRecord` may carry a `bindToken`, minted at dispatch and delivered only through the
daemon's launch command. The MCP presents it at register and as `x-session-token` on every HTTP
call. This closes cross-PROJECT impersonation. Same-project panes share a uid and stay mutually
impersonable by OS construction: an accepted permanent residual, not a gap.

`gateway/sessionAuthority.ts` answers three distinct questions, and collapsing them re-introduces
paid-for bugs:

- `toClaim(teamKey)` - name-keyed, the only place inert-awareness lives. A reattach discards the
  launch command, so a binding stays inert until a register actually presents it.
- `toAnswerFor(ws)` - socket-keyed, deliberately not record-derived: a `claude --resume` alias serves
  a bound record under its own unbound name with no token.
- `toActFor(teamKey)` - the composition, live-first with a record fallback.

UNBOUND is a VALUE a resolver returns, never an absence a caller falls into. That is what stops a
gate from manufacturing an accidental permit.

### Federation and trust

evie is a content-blind router. Gateways register a gateway id on connect; a Gateway reaches another
via evie's `gateway_relay`, routed by `dstGateway` alone and correlated by `relayId`. Payloads are
E2E sealed, so evie can neither read nor forge them. Discovery fans out `list_teams` over evie's
presence roster and merges locally; evie aggregates nothing.

Trust roots in a single owner device. Membership is an allowlist of owner-signed admissions mirrored
on evie AND every Gateway, so a revocation bites while evie is unreachable.

- **Crypto** (`shared/crypto.ts`): Ed25519 signing pair + X25519 box pair, raw 32-byte keys base64.
  Seal is ephemeral X25519 ECDH into HKDF-SHA256 into AES-256-GCM, signed by the sender's static key.
  **AES-256-GCM not ChaCha20**, because Bun lacks the latter.
- **Never sign raw JSON.** Signing bytes are versioned newline-joined encodings (`ADMISSION_V1\n...`)
  reproduced byte-exact on node, Bun, and Android. Cross-platform vectors pin Kotlin against node.
- **Registration gate:** `gateway_register` carries signPub/boxPub, the owner-signed admission, and a
  fresh possession proof. There is no bearer fallback.
- **Arming mode:** a gateway with no Domain id boots standalone, serving `/health` and `/enroll` with
  no evie client. The bridge activates only when both a `transport.json` and a Domain id resolve, so
  a missing Domain arms for enrollment rather than failing closed.
- **Enrollment:** the owner root key is generated silently on the phone and never leaves it. A fresh
  setup stages a PENDING tenant Domain and emits a transport-only 0600 blob carrying
  `pendingTenant{domainId, nonce}`; the phone self-signs a `FIRST_ROOT_V1` and roots it evie-direct
  in one atomic CAS write, so a redeem race has exactly one winner.
- **Replay:** `ReplayGuard` checks AFTER the signature verifies.
- **Trust-on-first-enroll:** the first owner-signed snapshot roots a gateway; a later snapshot rooted
  at a different owner key is ignored. There is no silent re-root.

The console-to-gateway path is sealed the same way: the console seals each op into a
`ConsoleRelayFrame` signed by its enrolled key, and the gateway verifies the signer against an
owner-signed `kind:console` admission before dispatch. Only a pre-seal failure returns cleartext, so
the console can prompt enrollment. Still open on this track: evie self-provisioning the console-bridge
k8s objects, and retiring `CONSOLE_BRIDGE_TOKEN`.

### Versioned state planes

The console's poll response piggybacks versioned server-state snapshots instead of the console
re-pulling on its own timer. `shared/plane-registry.ts` is the one framework: a mutator only calls
`markDirty()`, and the registry owns version identity, hash-gated bump detection, the race-free
`waitForBump` held-poll primitive, per-plane exception isolation, and a 60s tripwire that self-heals
a mutation that forgot to mark.

Planes today: **presence** (single writer over every presence-affecting field), **linked-peers**,
**read-anchors** (one plane PER OWNER, so a wire-assembly bug cannot leak across owners), and
**cross-domain-presence** (N planes, one per linked Domain, shipping only the changed subset).

**Wire rule:** per-plane fields are flat, hand-named, optional. NEVER a generic map and never a
decode-side discriminated union, because Kotlin codegen has no typed map and silently drops a union
root. An absent known-version means "ship nothing"; an empty array means "ship current truth".

### Console bridge (Android)

The console is a poll-based client, not a live socket: evie relays opaque `console_relay` frames and
the gateway answers each with a `console_relay_reply`. It is keyed by its per-install
`conversationId`; the Device Name is only a display label. `ConsolePeer` inserts into the team and
conversation registries like a real peer, so wake, persistent conversations, and push delivery are
reused unchanged; its `send()` appends to a `DeviceMailbox` that the `poll` op drains.

- **Ops:** register, list_teams, send, respond, poll, plus peek / tmux_send / create_session /
  rename_session / reload_plugins / forget / close_session.
- **Idempotency:** mutating ops dedup per `(conversationId, opId)` in an in-memory `opCache`; reads
  run fresh. `send`/`respond` additionally sit on `DurableOpStore`, so a restart mid-send cannot
  re-deliver a message the client already believes sent.
- **Mailbox:** bounded (entry cap with a cumulative `dropped` signal, 1h idle TTL, LRU device cap).
  Each instance carries an epoch, and `poll` is epoch-gated so a stale cursor cannot ack away a new
  instance's entries. Eviction prefers `"peer"` entries over real unread mail.
- **Agent-to-agent mirroring:** `mirrorPeer` appends a display-only `kind: "peer"` copy for each
  local participant. Never fires for a console sender/target, and never load-bearing.
- **Plugin actions:** a generic `kind: "plugin_action"` entry lets a tool drive a device-side plugin
  with no new wire type per action. `threadAddr` derives solely from the request's own `from`.
- **Multi-gateway delivery:** the console polls one route Gateway, so `fanOutConsolePush` relays
  content composed on another same-Domain Gateway. The landing side never re-fans-out (origin-only,
  so nothing gossip-loops), is same-Domain-only with no exceptions, and dedups per `dedupeKey`.

### Console terminal view

`peek` captures the ANSI pane, `tmux_send` injects literal text or a whitelisted control key,
`create_session` starts or reattaches a named tmux session, `reload_plugins` drives the update
sequence. These reach the host through a `host_op` RPC over the host WebSocket, correlated by
`reqId`, and run through `hostOpRunner.ts` (peek single-flight, cadence floor, concurrency cap,
dedup on the mutating ops).

- `tmuxCore.ts` is spawn argv, no shell. Every session LOOKUP uses tmux's `-t =<name>` exact-match
  form, so `story` can never match `story-2`.
- While a pane does not exist yet, `peekWithFallback` tails `docker logs` instead of erroring. The
  console-facing result mirrors the tag as FLAT optional `kind` + `text` fields, never a zod
  discriminated union.
- The wake path reports a FAILED wake when a fresh pane never captures, so `/send` fails fast on a
  dead launch instead of stalling.
- Auth: the reserved `host` slot is gated by `HOST_WS_TOKEN`, so a LAN peer cannot squat it and
  capture keystrokes.

### Artifact references (`ref://`)

An agent writes a markdown link to `ref://path:Scope:Name#matcher`; the MCP resolves it with
tree-sitter and attaches one file snapshot per referenced file. Lives in `mcp/references/`.

- **A snapshot declares itself.** Each carries `role: "ref-snapshot"` plus a `ref` block naming its
  source path, the canonical keys it backs, and (in snippet mode) its slicing as `(startLine,
  lineCount)` pairs. There is no manifest file and no reserved filename: a receiver classifies from
  the file entry it is already holding, so nothing has to be read, timed, or kept unclaimable.
- **The snapshot's bytes ARE its segments joined by newline**, which is why line counts alone
  partition it. `artifactBuilder`'s join and `RefPayload.payloadFor`'s slicing are inverses; break
  one and the viewer renders the wrong lines under the right header.
- **Grammars are COMMITTED wasm** under `grammars/`, built by `scripts/build-grammars.ts` from pinned
  npm sources. Never harvest a package's own prebuilt wasm: the 0.26 runtime will not load one built
  by an older CLI. Rerun the script and commit after changing a pin.
- **The canonical key is the contract.** It splits on structural separators BEFORE percent-decoding,
  and must be idempotent, since the MCP writes it and the console recomputes it from a tapped link.
- **Detection borrows the console's own vendored markdown parser**, so both sides agree by identity
  on what is a link. `linkify: false` is load-bearing.
- **Paths are shell-style:** bare is project-relative, `/` is filesystem root, `~/` is home.
- **The file tier fails loudly; RESOLUTION always degrades.** A moved line ships with a banner,
  because refusing to send over a stale pointer is worse than opening roughly in the right place.
- **Teaching lives in the plugin's own manifest** (`agent_instructions`), which the capability union
  carries into the MCP instructions. `skills/crosstalk/SKILL.md` has the short version.

### Capability union

A session's tools are gated on what the owner's consoles can actually render. Consoles report loaded
plugins at register, the gateway unions them in a durable `CapabilityStore` (14-day TTL, 500-device
cap), and a starting MCP reads the union over `GET /capabilities` before the McpServer exists.

- An ABSENT `enabledPlugins` means the device said nothing and its prior report stands; an EMPTY
  array is an affirmative "nothing enabled". Zero live records serves `known: false`.
- Nothing is assumed when the gateway cannot answer. The fallback is the last answer that actually
  arrived and nothing else. `GATED_CAPABILITY_IDS` is the single list the gates derive from, held
  against the shipped manifests by a fixture test.
- A running session never changes its tools; a toggle is picked up at the next session start.

### Android app

- **Plugin framework** (`android/.../plugins/`): `Plugins` is the process singleton over a
  compile-time `PluginCatalog`; each extension point is a `PluginRegistry<T>` that auto-tags claims
  by plugin, so disabling one sweeps its claims. Dispatch goes through `forEachCaught` / `anyCaught`
  / `firstNotNullCaught`, so a throwing claim is logged and skipped. `threadDockSlots` is the
  exception (Compose values cannot cross a non-inline lambda).
- **Inbound pipeline:** subscribers fire synchronously inside the mailbox drain, before
  `mailboxSync.commit`, so they inherit the cursor's exactly-once. Deliberately not a `SharedFlow`.
  **A handler gets NO bytes**: a delivered message names its files and the blob plane fetches them
  afterwards, so anything a handler decides must come from wire fields alone. That is also what
  keeps a handler's single write ahead of any user action, so nothing it writes can be resurrected.
- **Designer plugin:** docks a `design-card` file from its declared title/group/dimensions the
  moment the message lands, and resolves the bytes at RENDER from the live row (content-keyed, so an
  older revision cannot lend its bytes). A card therefore exists before its bytes and says whether
  it is downloading or gave up. Backed by its own per-team `DesignStore`.
- **Unread tracking:** a per-team `ReadAnchor(epoch, seq, at)`. Mailbox epochs are random and never
  ordered, so an anchor resolves to its row by EQUALITY only and unread is a pure positional count.
  Reads drain by scroll position, not by opening; `thread.js` walks a monotonic pointer against live
  layout because IntersectionObserver cannot fire on a bottom edge.
- **Idle pushback** (`IdlePushbackManager.kt`): background poll cadence backs off the longer it stays
  silent, releasing the wakelock for wall-clock-aligned `AlarmManager` wakeups at the deeper tiers.
  A fresh mailbox entry resets the ladder.
- **Attachment viewer** (`AttachmentViewer.kt`): one fullscreen sheet for every tapped file. Which
  stage it shows is decided by `viewerDecodableImage` in `AttachmentDisplay.kt`, never by a mime
  prefix, because the two renderers disagree in BOTH directions (the WebView draws SVG that
  BitmapFactory cannot; BitmapFactory decodes HEIF that the WebView cannot), so the viewer's set is
  not the thumbnail set.
  - `ZoomMath.kt` owns the arithmetic, free of Compose so it is unit-testable. The layer scale is NOT
    the zoom percentage: `ContentScale.Fit` has already scaled the bitmap and a downsampled one
    covers `sampleSize` source pixels per bitmap pixel, so a preset cannot be a constant. Both ends of
    the pinch range are derived per image, since which of fit or 200% is outermost flips with image
    size. The real gate is an emulator check that 100% is 1:1; the unit test cannot see the
    Dp-versus-pixel seam at the call site.
  - `TextPeek.kt` decides text-vs-binary for the preview stage. `CharsetDecoder` does the classifying,
    because it already separates a character truncated by the peek window from bytes that cannot
    appear in the encoding. `String(bytes)` cannot be used: it substitutes U+FFFD and never fails, so
    every file would classify as text.
  - `SaveTarget.kt` is the SAF half of Save. Downloads via MediaStore is the other half and is the
    only one reachable before a folder is picked. A stored grant is re-validated on every read, and
    `SaveOutcome` keeps "the folder is gone" apart from "the write failed", because only the first
    should send the user back to the picker.
- **Composer drafts:** one `Draft(text, files)` per team in the store, not composer-local state, so
  picked files cannot follow a tab switch. `takeBackIntoDraft` is the single write path back to the
  composer: files UNION, text lands only on a blank draft.
  - `DraftStrip.kt` draws them: collapsed to a fixed-height scrolling strip, expandable to the
    transcript's own layout. Tiles are keyed by FILE, never by position, because a removal shifts
    every later file down a slot and a positional key would leave the old bitmap on a tile whose
    remove badge now deletes a different file. The expand state is composer-local and must stay that
    way; it describes the view, not the draft.
  - `ThumbCache` is the one bitmap cache both thumbnail producers share, bounded in bytes and keyed
    per producer so a design card and an image cannot collide. It holds no lock: serializing renders
    is the WebView producer's problem, and a decode must not queue behind a card capture.
  - `ImageThumbs.sampleFor` bounds a decode by TWO rules, and both are load-bearing. The short edge
    decides sharpness (the tile centre-crops), and a ceiling on the long edge is the only thing that
    binds an extreme aspect ratio. Without the second, a stitched screenshot decodes at full size to
    fill a 64.dp tile and the OOM is swallowed into a blank tile.
- **Scheduled send:** client-local, no wire shape. At most one banked `ScheduledSend` per team, one
  shared alarm on the earliest record, all firing funneled through a mutex-guarded path so a warm
  kick cannot double-convert.

## Development

### Commands

- `bun run lint` - Biome CI + tsc
- `bun run test` - vitest
- `bun run bump patch|minor|major` (`--dry-run` to preview) - the whole version ritual. Marketplace
  updates hinge on `plugin.json`, so a stale one silently skips the update
- `bun scripts/codegen-kotlin.ts` - regenerate `proto/Protocol.kt` after editing a shared schema; CI
  fails on drift
- `bun scripts/check-module-residue.ts` - verify node_modules against bun.lock
- `bun scripts/sync-leaf.ts <path>` (or `--all`) - re-sync a synced leaf
- `bun scripts/import-stts-voices.ts` - regenerate the TTS voice lists. To refresh a provider, drop a
  fresh export at `data/stts-voices/<provider>.json`, run this, commit both files. CI drift-checks it

### Pull before every follow-up edit after a push

`gitPushNewBranch` moves commits to a branch and resets local `main` to `origin/main` while the PR is
still merging, so for a minute or two the tree does NOT contain the work just pushed. Editing in that
window silently applies to a tree missing the feature, and a scripted replace finds nothing and
reports success. This has bitten three times in one session.

Run `gitFetch` then `gitPull` after any push before touching a file. Treat a non-empty
`git log main..origin/main` as a hard stop. When scripting an edit, assert the match before writing.

### Verify locally before pushing, especially Android

`ci.yml` does NOT compile or test Kotlin. It runs the TS lint/test plus the codegen and stts drift
checks; Kotlin builds only in `main-push.yml`, AFTER the merge. So a Kotlin compile error lands on
`main` before any gate catches it. Greps cannot see this class of break (an over-matched Compose
`Switch` rename and a mangled verb both passed every grep and the full TS suite, twice).

```bash
source ~/android-dev/env.sh     # puts java/adb/emulator/gradlew on PATH
cd android && ./gradlew :app:testDebugUnitTest --console=plain
```

Treat that as the Kotlin gate the way `bun run lint && bun run test` is the TS gate. For a wire-shape
change, run the codegen first so the new types are exercised.

`testDebugUnitTest` runs UN-minified. Both variants R8-minify, so a renamed `@Serializable` class or
a dropped JS-bridge method only shows at `assembleRelease` or on-device. Keep-rules live in
`app/proguard-rules.pro`; the `@JavascriptInterface` keep is load-bearing (AGP's default misses it,
since the bridge is an anonymous object rather than a WebView subclass).

The sibling **evie-bot** repo has its own gate: `bun run lint && bun run test`, run INSIDE its
devcontainer (the host node is too old for vitest 4). Its `Push (main)` gates deploy behind lint, so
an unlinted change merges but SKIPS the rollout. Run it after editing any synced leaf.

### Look at the console yourself: the `emulator` build

A third build type beside debug and release. It exists because the console cannot get past onboarding
without a real Gateway, so every visual question otherwise costs the owner a screenshot. Reach for
this before asking a human to describe a screen.

```bash
source ~/android-dev/env.sh
cd android && ./gradlew :app:assembleEmulator
adb install -r app/build/outputs/apk/emulator/switchboard-emulator.apk
adb shell pm grant com.atelier_nyaarium.switchboard.sandbox android.permission.POST_NOTIFICATIONS
adb shell am start -n com.atelier_nyaarium.switchboard.sandbox/com.atelier_nyaarium.switchboard.MainActivity
adb exec-out screencap -p > /tmp/shot.png    # then Read the png
```

**Shut the AVD down when the feature or plan is done** - it does not exit with your session, and an
idle one still costs ~4.5% of a core and 4.4 GB. One left running burned 8 CPU-hours over 8 days,
which was more than every other process on the machine combined.

```bash
adb emu kill
```

- Installs BESIDE a real install (`applicationIdSuffix = ".sandbox"`), so it cannot overwrite the
  owner's app or data.
- All sandbox code lives in `src/emulator/`, so the onboarding bypass is not compiled into debug or
  release at all. `seedSandbox` is the only seam in shared code and is build-type guarded.
- `SandboxFixtures` is scaffolding, not a spec. Bend it to whatever is being looked at.
- Seeding bypasses the mailbox drain, so no inbound plugin handler runs. Anything a receiver decides
  from wire FIELDS (hiding a ref snapshot, a card's title) is unaffected and renders correctly;
  anything a handler has to record on arrival must be seeded directly, the way `SandboxApp` upserts
  design cards into `DesignStore` after `seedSandbox`.

### Dependencies

EXACT pins, no ranges: the plugin launches via `bun run` and a caret range would let any start pull a
brand-new release. Dependabot (daily, 7-day cooldown) is the updater; `overrides` pins transitives
with known advisories. After any manifest change run
`rm -rf node_modules && bun install --frozen-lockfile`, then `scripts/check-module-residue.ts` - bun
never prunes nested node_modules dirs the lock stopped sanctioning, and a stale nested copy silently
shadows the pinned version for both tsc and runtime.

### Synced leaves

Some `src/shared/` modules are the source of truth for a wire shape shared with a sibling repo and
are copied VERBATIM. Each carries a `// SYNC-HASH:` of its body, and each repo's CI fails on a
mismatch.

| Source | Copy |
|--------|------|
| `notice.ts` | `nyaaskills/src/shared/notice.ts` |
| `evie-protocol.ts` | `evie-bot/app/features/bridge/evie-protocol.ts` |
| `crypto.ts` | `evie-bot/app/features/bridge/crypto.ts` |
| `admission.ts` | `evie-bot/app/features/bridge/admission.ts` |
| `federation-lifecycle.ts` | `evie-bot/app/features/bridge/federation-lifecycle.ts` |

Always use `bun scripts/sync-leaf.ts <path>`. FOOTGUN: the order is format, restamp, copy. Copying
first and running `lint:fix` after reformats the SOURCE, staling both the stamp and the copy, and the
sibling repo's CI fails on the hash. The script runs biome first so a later `lint:fix` is a no-op.

### Code style

Biome: tabs, double quotes, semicolons, 120 char width. Files follow categorized sections:

```ts
////////////////////////////////
//  Interfaces & Types

////////////////////////////////
//  Schemas

////////////////////////////////
//  Class

////////////////////////////////
//  Functions & Helpers
```

### Environment variables

**Gateway (Docker):**

| Var | Meaning |
|-----|---------|
| `PORT` | HTTP/WS port (default 20000) |
| `GATEWAY_ID` | This Gateway's id (default: sanitized hostname) |
| `HOST_WS_TOKEN` | Secret the host daemon presents for the reserved `host` slot. Fail-closed. Auto-provisioned into `.env` by `start-gateway.sh` |
| `EVIE_NAMESPACE` | K8s namespace (default `evie-bot`) |
| `FEDERATION_DOMAIN_ID` | Domain id. NOT fail-closed; the enrollment-delivered `domain-id` file takes precedence |
| `DATA_DIR` | All durable state (default `/app/data`), deliberately separate from the log volume so clearing logs cannot wipe federation identity |
| `FEDERATION_DIR` | Keypair, allowlist, transport.json, domain-id (default: inside `DATA_DIR`) |

**MCP plugin (container):** `PROJECT_NAME` (required for crosstalk), `BRIDGE_ROUTER_URL` (default
`http://switchboard:20000`), `AGENT_TYPE`, `PROJECT_HOST_PATH`, `MCP_CONNECTOR_PORT`,
`MODEL_SIMPLE` / `MODEL_STANDARD` / `MODEL_COMPLEX`.

### Testing

Tests live in `src/__tests__/`. `bun run test` for all, or `bun run test <path>` for one.

### Debugging the console on-device

The release ships `switchboard-debug.apk` beside `switchboard-release.apk`, signed with the SAME key
so it installs over the release build and back. The debug build flushes `DebugLog` to evie's
`POST /ingest` each poll cycle; release never does. The in-app updater is variant-aware, so getting
onto debug requires sideloading once.

```bash
KUBECONFIG=~/projects/evie-bot/kubeconfig.yaml kubectl -n evie-bot \
  logs deploy/evie-bot-deployment --tail=200 | grep '\[console-ingest\]'
```

`DebugLog` already traces the enroll scan and the poll/drain flow (`[Poll]`, `[Drain]`). **A log line
is never private:** it ships off-device and stays on logcat, so never embed a bearer credential,
invite nonce, or minted secret. Only opaque ids, HTTP codes, and non-secret fields.

## Deploying

### Console bridge

Spans two repos and three runtimes, so the order is fixed.

1. Push evie (`app/features/bridge` + `deploy/`). Its `Push (main)` builds the image and rolls out.
   Await the run, then `gitPull` locally.
2. Push switchboard the same way, then `gitPull`.
3. Apply the cluster objects from evie-bot:
   - `kubectl create secret generic console-bridge-app-token -n evie-bot --from-literal=CONSOLE_BRIDGE_TOKEN=$(openssl rand -hex 32)`
   - `kubectl apply -f deploy/console-bridge.yaml`
   - `kubectl set env deploy/evie-bot-deployment -n evie-bot --from=secret/console-bridge-app-token`
4. On the host: `./down.sh && ./start-gateway.sh && ./start-host-daemon.sh`.
5. Validate with `evie-bot/deploy/console-bridge-smoketest.sh`.

`register`/`send`/`list_teams` relay through the gateway, so they only pass after step 4. Setting the
env before applying the yaml enables the bridge in the pod but leaves it unreachable.

### Federation

Layers on the console-bridge deploy. The gateway-to-evie WS is admission-only, no bearer fallback.

1. One-time RBAC: `kubectl apply -f evie-bot/deploy/federation-rbac.yaml`. Re-apply after a
   transport-endpoint change so the new rule lands.
2. Domain id is not fail-closed; a gateway without one arms for enrollment. A creds-less secondary
   gets it from the sealed bootstrap bundle.
3. `./setup.sh`. `2) Evie Admin Provision` does the cluster cutover, stages a pending admin Domain,
   and emits the transport-only blob. `1) Setup Gateway` arms this gateway, shows its admit payload,
   waits for the phone's sealed bundle, and connects in-process with no restart.
4. Per-user purges: `9) Purge Gateway` drops only this gateway's admission then wipes local state;
   `0) Purge Federation` drops only this owner's Domain slice (other tenants survive) then wipes
   local state and the host blob.
