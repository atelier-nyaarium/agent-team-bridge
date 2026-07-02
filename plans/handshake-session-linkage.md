# Handshake-established session linkage

Reintegrate the lead handshake with the session store: the handshake becomes the ceremony that
ESTABLISHES a phone session. Builds on the shipped ad-hoc provenance fix (PR #105), parts of which
this plan supersedes (see Questionaire).

## Questionaire

Clarified facts (owner statements):

- "No handshake" for computer-started sessions is CAUSAL, not a design choice to make: a `claude`
  run without `--dangerously-load-development-channels plugin:switchboard@atelier-nyaarium` (the
  flag every daemon launch bakes in via `CLAUDE_FLAGS`, `hostDaemon.ts:309`) never surfaces channel
  notifications to the LLM, so a handshake sent to it is undeliverable and unanswerable.
- "I do expect if I manually spawn a session with the flag, it should show up." So the signal for
  phone visibility is CHANNEL CAPABILITY (proven by handshake completion), not name provenance.
  The gateway needs no new client-side detection: the confirm IS the detection.

Answered:

**Q1 - What makes a session visible on the board?** -> **A) Visible = store entry OR
confirmed-live.** Phone-created cards visible from creation (preemptive entry); a flag-enabled
manual session appears the moment its handshake confirms; flag-less sessions never appear. Gateway
restart: store-backed cards stay (chip dips to verifying until re-confirm); a storeless manual
session blinks off until it re-answers. Consequence accepted: partially supersedes PR #105 -
`claudeSessionId` returns to the register wire unconditionally and the gateway records it at
handshake-CONFIRM time instead of register time (recommendation chosen: the confirm is the
capability detection, so no client-side flag is needed).

**New requirement (owner, alongside Q1):** "the session name as set in the app will no longer be a
slug. It will get an ID given by Evie. Evie will associate this store ID to, if exists, the proper
running tmux. And once created, the claude resume ID." I.e. sessions become ID-keyed store records
with FREE-FORM display names: `{ id, displayName, tmux binding (if one runs), claudeSessionId (once
known) }`. The typed name is a label, not an address segment.

**Minting authority (owner confirmed):** the GATEWAY mints (evie is content-blind on the sealed
console ops and cannot read or inject into them): "gateway mints after determining a random ID
doesn't clash." The gateway is the SOLE store authority - the phone is a client that sends ops and
renders teams(); it validates nothing (it may be stale, offline, or one of several devices). Both
invariants are gateway write-time checks: (1) mint = random short id, re-roll on clash; (2) resume
dedup = at confirm-time record, if the incoming claudeSessionId already lives on a store record,
BIND this live session to that record instead of minting a duplicate - one record per Claude
transcript, which also generalizes "associate the store ID to the proper running tmux".

**Q2 - Where does the minted ID live in the address grammar?** -> **A) The ID becomes the session
segment.** Address = `domain.gateway.<spawn>.<id>`; the tmux session is named by the id; the address
grammar, store keys, threads, and codegen are untouched - only the SOURCE of the segment changes
(minted vs typed), and the session label rides on TeamInfo for rendering. Legacy named sessions stay
valid: their name IS their id. Gateway authority locked (owner: "gateway authority. Locked.").

**Q3 - Default display name for sessions the phone did not create?** -> **cwd basename + `-#` on
collision** (owner: "base name + `-#` if another one exists by that name"). The plugin sends its
cwd basename as an optional register field; the gateway (as name authority) appends `-2`, `-3`, ...
when another record already holds that label. Phone-created sessions use the typed name (same
`-#` dedup, scoped PER SPAWN - the board groups by spawn header). Fold-in accepted: the phone-local
per-device label map is RETIRED in favor of the server-side label (rename becomes a sealed console
op; one truth, synced via teams()).

**Q4 - Repeat flag-enabled bare launches?** -> **B) Keep them all** (owner: "B. Keep them."). Each
bare (no `--resume`) launch of a flag-enabled loose `claude` is a new transcript and gets its OWN
durable card (`switchboard`, `switchboard-2`, ...), cleaned by the 30-day TTL or a manual Forget.
No cwd-rebind tier exists; accumulation is deliberate (the flag is an intentional act) and bounded.

> Terminology note: the Questionaire's "display name"/"session label" wording maps to the NEW
> `sessionLabel` wire field defined in the body. It is NEVER the existing `displayName` TeamInfo
> field, which already means the owning Domain's network name (see Target model).

## Problem

Today the linkage is unwired end to end:

- A session registers and is fully live (listed, addressable, resume-recorded) BEFORE the handshake
  is even sent (`websocket.ts:209` insert vs `:239` handshake).
- `handshakeConfirmed` is write-only state: no reader anywhere consumes it. The only enforcement is
  the worker-reject path. A session that never answers stays registered forever, indistinguishable
  from one whose channel SDK works.
- Every computer-started loose `claude` WITH the channels flag gets the handshake channel message
  injected into the user's own session - noise for a session that may never be phone-addressed
  (a flag-less session never even sees it).
- A phone-created session has no store presence until its register lands: the card appears only
  after the (long) boot, and a failed launch leaves nothing to retry from.

## Target model (settled by the questionnaire + audit laps 1-2)

A **session is an ID-keyed store record** owned by the gateway (the sole authority):

```
SessionRecord {
  id            // minted or adopted by the gateway, short slug (clash-checked vs records, catalog
                // projects, reserved host sessions); THE address segment; tmux name for daemon panes
  sessionLabel  // free-form label (<=64 chars, printable, single path segment - no separators/"..",
                // trimmed): typed at create, else register cwdName, else the id itself. Gateway
                // dedups per-spawn with a `-#` suffix; renameable by a sealed op.
                // NOT the existing displayName wire field: that means the owning Domain's network
                // name (schemas.ts:143, stamped identically on every TeamInfo; the app reads it as
                // the Domain label). A separate field avoids corrupting old apps.
  spawn         // "host" or the devcontainer project
  workdirHint?  // host sessions: drives the daemon's ~/projects/<hint> workdir inference (the id is
                // opaque). Lookups use workdirHint ?? sessionLabel; migration seeds it from the
                // legacy segment so old sessions keep their historical workdir.
  claudeSessionId?  // the harness resume id, bound at handshake-confirm (transcript dedup key)
  liveTeam?     // registry {team, subId} of the CURRENT confirmed incarnation (usually team =
                // `spawn.id` itself; differs for an alias-bound manual re-incarnation). Stamped at
                // confirm (resolveHandshake holds pending.{team, subId}), cleared when that team
                // disconnects, NULLED by restore() (a stamp never survives a gateway restart).
                // "Live" is always a REGISTRY PROBE (a socket with readyState === 1), never a
                // trust-the-stored-flag test. This is the record -> live-socket direction that
                // send/wake resolution consults.
  confirmedAt?  // when a lead handshake last established this record
  lastSeen      // refreshed by the TTL-liveness rule below
}
```

- **Visible = has a store record.** teams() lists records (live -> online/verifying, asleep ->
  available) plus spawn-points, and nothing else. A confirmed live session ALWAYS has a record
  (confirm creates or binds one). Recordless live peers (flag-less loose sessions) are invisible to
  console list_teams AND discovery; their outbound conversations still route (conversationRegistry
  is untouched). Cross-Domain consequence (intended): a recordless session is also invisible to the
  share kind-gate - you cannot share what you cannot see.
- **TTL-liveness:** teams() refreshes `lastSeen` for any record with a live incarnation (mirroring
  touchShares, routes.ts:485), so the 3s sweep (index.ts:166) can never delete a live session's
  record. Provisional (unconfirmed) records get the standard 30-day TTL from creation - orders of
  magnitude beyond any boot window, so an instant card cannot vanish mid-boot, and a failed launch
  stays retryable for the full TTL. Record TTL must remain >= the cross-Domain share lifetime (the
  kind-gate reads teams(), gatewayRelay.ts:84-104).
- **The handshake is both the capability probe and the linkage ceremony.** Sent to every channel
  registrant exactly as today; a flag-less harness never surfaces it. A lead confirm makes the
  gateway record/bind. A worker reply still rejects and closes (with full registry cleanup - Phase
  B hygiene).
- **Confirm binding order** (lap-2 rank 4 re-rank - transcript dedup STRICTLY precedes free-segment
  adoption):
  1. the session's own team segment matches an EXISTING record id -> bind (covers the
     create_session-preemptive record, legacy records, and daemon relaunches); records the
     incoming claudeSessionId (the one-record-per-transcript invariant needs it for a later
     `--resume` tier-2 match);
  2. `claudeSessionId` matches a record -> bind (the manual `claude --resume` re-incarnation);
  3. the segment is FREE -> adopt it as a new record's id (the hand-set composite PROJECT_NAME
     escape hatch; also the normal landing tier for EVERY flag-enabled loose launch, whose
     self-composed segment is free by construction - each bare launch gets its own record per Q4);
     sessionLabel = cwdName, else the segment; records the incoming claudeSessionId;
  4. else MINT a fresh id (reachable only when the segment collides with the catalog/reserved
     names/an existing record - tiers 3 and 4 are disjoint); sessionLabel = cwdName, else the
     minted id.
  Tier 2 does NOT overwrite `liveTeam` while a live socket already serves `spawn.id` (the daemon
  pane stays canonical; see resolution order below). On a segment that collides with an existing
  record bound to a DIFFERENT live transcript: first-binding-holds - refuse and log, never
  silently take over a card.
- **Re-incarnation routing is gateway-side state, not a plugin rename** (lap-1 rank 3): confirm
  stamps `liveTeam`. THE ONE authoritative resolution order, applied identically by send
  resolution, terminal-op resolution, AND doWakeTeam: **registry.get(`spawn.id`) first (the daemon
  pane is canonical when live), else resolveLive(id) -> registry probe of liveTeam, else wake** -
  and doWakeTeam refuses while either probe is live (no duplicate incarnation on one transcript).
  Terminal ops against a record whose resolved incarnation is NOT a daemon pane (the user's own
  terminal) return a clear "terminal view unavailable for a user-launched session" instead of
  driving a nonexistent tmux.
- **Phone-created**: create op mints the record preemptively (typed label, workdirHint = label),
  daemon launches a tmux named by the id, the register delivers `claudeSessionId` + `cwdName`
  (stashed on the socket), the confirm binds via order (1). A failed launch keeps the card for a
  retry wake.
- **Send-woken** (crosstalk or console send to an asleep/unknown composite): the wake ADOPTS the
  addressed segment as the record id (adopt-by-id, NOT mint - minting would strand the woken
  session at an address nobody used); sessionLabel = the segment (a slug); workdirHint = the segment.
  The addressed segment stays the label: the daemon-launched session confirms via binding order tier
  1 (segment match), which records the transcript id but does NOT overwrite the label. That is
  deliberate - the human addressed this specific segment, and a devcontainer's cwdName is the less
  specific project basename (shared across its sessions), so the segment is the better board label.
  The provisional record is ROLLED BACK if the wake never comes online (a bogus/removed project, a
  dead launch): doWakeTeam forgets a record IT created when the wake fails and the record is still
  unconfirmed with no live incarnation, so a typo'd or dead send-wake leaves no phantom "available"
  card (mirroring create_session's launch-failure rollback). A host session whose segment CLASHES
  with a catalog project adopts no record (clash predicate), but the wake still sends the segment as
  workdirHint so it opens in ~/projects/<segment> rather than $HOME.
- **Computer-started with the channels flag**: registers, confirms, binds per the order above.
- **Computer-started without the flag**: registers (outbound crosstalk works), never confirms,
  never records, never appears. This is the strand-proof default.

## Phases (one per implementation lap)

## Phase A - session store (gateway)

- NEW `src/shared/session-store.ts`: a SessionStore class owning the SessionRecord map, KEYED BY
  the composite `spawn.id` team (globally unique, exactly the address a session registers and lists
  under - so `id` need only be unique within its spawn, as the address grammar already is, and no
  cross-spawn qualifier is ever needed). API (all write invariants live here): `snapshot()/restore()`
  (DurableStore round-trip), `getByTeam(team)`, `list()`, `teamOf(record)`, `mint(opts)` (random
  short hex, re-roll via a clash predicate covering catalog project names + RESERVED_HOST_SESSIONS -
  the predicate is a constructor injection since the catalog lives in gateway state), `adoptById(id,
  opts)` (caller-supplied id when free in its spawn), `recordRegister(team, cid)` (the register path:
  bind-or-create by composite, cannot fail or conflate), `bindBySegment()`, `bindResume()` (both
  stamping `liveTeam`), `confirm()`, `rename()`, `forget()`, `sweep()`, `touchLive()`,
  `resolveLive(team) -> liveTeam`, `clearLive(team)` (disconnect hook). A per-spawn label index
  keeps dedup O(1) (an unauthenticated register must not amplify to an O(n^2) event-loop stall).
- Same DurableStore file (`session-resume`); boot migration reads both shapes off the SAME composite
  key: a legacy value `{claudeSessionId, lastSeen}` becomes a full record (label + workdir hint
  seeded from the segment, confirmedAt = lastSeen since it was recorded under the old
  trusted-provenance regime); a persisted record (value carries `id`) loads as is (a rename survives
  any number of restarts because a loaded record is never re-derived) with its label re-sanitized
  against a hand-edited file. The isComposite+isSlug read-guard (routes.ts:530) applies during
  migration.
- Write-boundary validation (the gateway is the authority): sessionLabel / cwdName / workdirHint
  capped ~64 chars, printable, TRIMMED, and a SINGLE PATH SEGMENT (reject separators and `..` -
  the label drives a filesystem path join in resolveHostWorkdir; an unauthenticated LAN register
  must not steer a launch cwd or inject markup into the owner's board). The rest of the
  unauthenticated-surface hardening stays deferred to `plans/gateway-auth-surface.md`.

## Phase B - confirm-time recording + handshake hygiene

Plugin side (`src/mcp/`):
- `helpers.ts`: `claudeSessionId` returns to the register unconditionally; drop `BridgeConfig.adhoc`
  / `IS_ADHOC` / the buildRegisterMsg gate. New optional register field `cwdName` =
  basename(process.cwd()). Update the register-shape tests.
- `registerBridgeTools.ts`: drop the threaded `adhoc` param; `index.ts`: drop the destructured
  `adhoc`; `team-name.ts`: `resolveSessionNaming` keeps composing the name; its `adhoc` output and
  docstrings updated (name provenance no longer gates anything). Full edit list: helpers.ts,
  registerBridgeTools.ts, index.ts, team-name.ts, bridge-register.test.ts, team-name.test.ts.
- Escape hatch PRESERVED via binding order (4): a hand-set composite PROJECT_NAME session that
  confirms adopts its own segment.

Gateway side (`src/gateway/websocket.ts` + store):
- Register stashes `claudeSessionId` + `cwdName` on `ws.data` (no store write at register).
- `resolveHandshake` lead-confirm runs the binding order and stamps `confirmedAt` + `liveTeam`.
  Duplicate confirms are idempotent.
- Hygiene (lap-1 rank 5): the eviction paths (same-subId replace `:199-202`, conversation takeover
  `:213-216`) synchronously prune the evicted socket's handshakePending entry and subs slot (today
  close() short-circuits on isStale and leaks both); `resolveHandshake` honors a confirm only for
  a socket with `readyState === 1`; `handshakePending` gains a createdAt TTL sweep; the
  worker-reject branch runs full registry cleanup instead of the isStale short-circuit.
- Disconnect clears `liveTeam` for records bound to the closing team (`clearLive`).

## Phase C - visibility = records (+ verifying status, sessionLabel on the wire)

- `routes.ts teams()`: list spawn-points + records only. Record with a live incarnation
  (registry.get(spawn.id) OR resolveLive alias) -> `online` or `verifying`, keyed on the RESOLVED
  LIVE SOCKET's `handshakeConfirmed` (never record.confirmedAt - a post-restart re-registered
  session must read `verifying` until its LLM re-answers, per the edge cases); none ->
  `available`. touchLive() per the TTL-liveness rule. Alias-aware: an incarnation registered under
  a self-composed name folds into its record's entry, never a second listing.
- `TeamInfoSchema`: status gains `"verifying"`; NEW OPTIONAL field `sessionLabel` (the Domain-level
  `displayName` is untouched - regression test: displayName uniform across LOCAL entries; remote
  entries legitimately differ per Domain). Codegen -> `Protocol.kt`; old app ignores the unknown
  field (kotlinx ignoreUnknownKeys) and renders `verifying` via its else-branch ("ended")
  transitionally.
- Consumers (complete list): `ConsoleClient.kt` (Team model gains sessionLabel + the teams()
  mapping - without this the field never reaches a render site), `ChatRepository.kt` (label(),
  retire the local label map; optional one-shot seed of server renames from existing labels -
  decide at implementation), `MainActivity.kt` (board, tabLabelFor, SessionCard - secondary raw-id
  line becomes on-demand [long-press] rather than unconditional, since every id is now opaque hex,
  terminal-view titles), `AgentScreen.kt` (the working chip treats a user-launched/no-terminal
  record as its own calm state, not an absent-error), `verifying` chip (amber), and the AGENT
  surface: `/discover` + `bridgeDiscover.ts` render `label (address): status` so crosstalk agents
  see human context. `notify_human` attribution resolution site: the CONSOLE maps the notice's
  `from` address to the sessionLabel it already holds from teams() at render time (the plugin
  never holds the gateway-authoritative label, so humanTools.ts is NOT the edit site).
- Cross-gateway/mixed-mesh note: an un-upgraded remote gateway still lists recordless peers and
  stamps only the Domain displayName; the privacy guarantee is per-gateway until the mesh upgrades
  (single-owner fleets upgrade together - accepted transitional).

## Phase D - create_session v2 + rename op

- `create_session` op - ADDITIVE-SAFE wire migration: `sessionName` becomes OPTIONAL and a new
  optional `displayLabel` is added, with a cross-field refine requiring at least one. Handler
  dispatch: `displayLabel` present (new APK) -> mint-first, label = displayLabel, the MINTED id is
  the tmux/session name (slug assertion applies to the id; the label is never slug-checked);
  `sessionName` only (old APK) -> adopt-by-id with the typed slug exactly as today, so the old
  app's locally-composed thread address stays correct - NO ghost-thread skew window. Reply gains
  OPTIONAL `{id, sessionLabel}` beside `created` (old field kept; optional so a new APK decoding
  an old gateway's `{created:true}` does not MissingFieldException - verified kotlinx behavior:
  ignoreUnknownKeys covers extra keys only, missing requireds throw).
- NEW sealed `rename_session` op `{target, sessionLabel}` - target is the gateway-qualified
  `spawn.id` address per the existing op convention (like forget); idempotent per
  (conversationId, opId); result `ConsoleRenameSessionResultSchema = {renamed, sessionLabel}`
  added to ConsoleOpResultSchema's union (codegen requires the named member).
- Android create flow: `ConsoleClient.createSession` reads the reply's optional `{id,
  sessionLabel}`; when present, `MainActivity` onSpawn opens the thread keyed `spawn.<id>` (falls
  back to the typed composite against an old gateway); create dialog drops slug validation when
  talking to a new gateway (sends displayLabel); rename UI entry point (thread menu) drives
  rename_session.
- Label authority: the rename UI now DUAL-WRITES via `repo.rename` - it sets the local label
  (immediate feedback + the fallback against a gateway with no server label) AND pushes
  `rename_session` to the gateway (authoritative, agent-visible via teams(), reaches other devices).
  `label()`/`labelOrNull` stay local-first (`local ?: server ?: leaf`), so an existing rename
  survives and a session THIS device never renamed converges on the server label. Chosen over a
  one-shot seed-then-flip-then-retire migration: dual-write delivers server-side authoritative
  renames with no risky one-time migration and no old-gateway conditionality. Fully retiring the
  local map (server-only authority + cross-device convergence for a session both devices renamed) is
  a deferred cleanup, not required for the feature.
- `forget` unchanged in spirit: kills tmux by id, drops the record.

## Phase E - re-incarnation alias (gateway-side)

- Confirm stamps `liveTeam` ({team, subId}); disconnect clears it; restore() nulls it. **Send
  resolution** (routes.ts send path, the registry.get site): the ONE authoritative order (see
  Target model) - registry.get(`spawn.id`), else `resolveLive(id)` -> registry probe of liveTeam
  (targeting the stamped subId's socket); wake ONLY when neither is live. **doWakeTeam**
  (index.ts): refuse/short-circuit when either probe is live (send routes there instead - no
  duplicate incarnation). Edit sites: routes.ts send resolution, index.ts doWakeTeam, websocket.ts
  confirm/disconnect hooks, AND consoleHandler's createConsoleDispatcher deps (SessionStore must be
  injected - resolveTmuxTarget resolves purely by catalog membership today).
- Response routing needs no change: channel session ids are minted from the TARGET address
  (routes.ts:743), so phone threads key on the record id regardless of the incarnation's
  registered name; the incarnation's replies carry its conversationId, which the
  conversationRegistry already resolves.
- Terminal ops (peek/tmux_send/reload) against a record whose RESOLVED live incarnation is not a
  daemon pane: return "terminal view unavailable for a user-launched session" (consoleHandler
  resolveTmuxTarget consults the record); the working chip treats it as no-terminal rather than
  absent-error. **forget** on such a record is card-removal-only: it drops the record but cannot
  kill the user's own terminal process (killSession finds no tmux by the id and idempotently
  succeeds) - the reply says so explicitly ("session is user-launched; end it from your terminal")
  so the orphaned-but-running process is never a silent surprise.
- First-binding-holds: a confirm claiming a claudeSessionId bound to a DIFFERENT record with a
  live incarnation is refused and logged. This closes the tier-2 cross-record hijack. The tier-1
  overwrite of an ASLEEP record's claudeSessionId (a forged confirm re-pointing a named record's
  resume id) is indistinguishable from a legitimate daemon relaunch without authenticating the
  register, so its residual stays in `gateway-auth-surface.md` (owner-deferred); the daemon's
  `/^[0-9a-fA-F-]{8,}$/` resume-id guard already blocks it from becoming shell injection, and a real
  re-confirm self-heals the value.

## Phase F - daemon/tmux paths on ids

- Wire shapes (mirroring Phase B's precision): `shared/host-op.ts` createSession HostOp variant
  gains `workdirHint?`; `hostOpRunner.ts` TmuxOps.createSession signature threads it; the wake
  message/payload (gateway -> daemon) carries `workdirHint` + `resumeSessionId` from the record.
- `resolveHostWorkdir(hint)` keys on `workdirHint ?? sessionLabel` (never the opaque id), treats
  the hint as a single path segment (basename/reject-`/` before join - belt and suspenders with
  Phase A validation), else falls back to $HOME as today. Devcontainer sessions ignore the hint
  (workdir is `/workspace/<project>`).
- Self-pane tools all derive the session name from `parseSessionName(PROJECT_NAME).session`
  through ONE source (`selfSessionTarget()`): set_effort_level, compact_session, AND
  `reloadPlugins.ts` (which today hardcodes DEFAULT_SESSION and would drive a nonexistent pane
  under minted ids).
- Reserved-session guards and catalog-first disambiguation re-verified against opaque segments;
  mint/adopt clash predicate already excludes RESERVED_HOST_SESSIONS (Phase A).
- Send-wake stamps its provisional record via `adoptById` (see Target model); create_session via
  `mint`.
- Deliberate deferral (pain-points cross-ref): SessionRecord carries no model/effort, so a resumed
  session still relaunches with the hardcoded `--model opus --effort xhigh` flags; closing that
  painpoint is follow-up work, not this plan.

## Phase G - docs, fixtures, painpoints, gates

- Protocol golden fixtures: NEW files (never mutate existing fixtures in place -
  index-based assertions pin them): `op-envelope-create-session-v2.json` (displayLabel form),
  `op-envelope-rename-session.json`, `list-teams-result-v2.json` (verifying + sessionLabel), all
  registered in `_manifest.json` AND in both runtimes' hardcoded schema maps (vitest + the Android
  op-kind map - a manifest entry alone is not picked up).
- `CLAUDE.md`: Channel Conversation Model; "Devcontainer sessions are dynamic project.session
  loose peers" (the resume map -> SessionStore as the durable known-session list); "Gateway
  identity and qualified names"; Console Bridge ops list; schemas.ts/routes.ts file bullets;
  notify_human attribution note.
- `plans/pain-points.md`: partially closes the seeded-phantom-card sting (no record without a
  completed handshake; full closure still `gateway-auth-surface.md`); note the model/effort
  deferral stays open.
- Migration temp code (the legacy-entry boot migration, the create_session `sessionName` alias,
  and any transitional fallbacks) is marked with a removal TODO and CLEANED UP IN A FOLLOW-UP
  after the upgrade lands successfully (owner directive) - same pattern as the DATA_DIR boot
  migration.
- Post-upgrade cleanup backlog (owner-flagged, do AFTER everything is verified working; not part
  of this feature): remove the aggressive per-launch Downloads sweep in `DebugLog.kt` `init`
  (deletes old `switchboard-debug.log*` spills every app start) once the long tail of old-build
  spills has cleared - it is dead weight on every launch by then.
- Gates: session-store vitest (migration round-trip incl. rename-survives-restart + cross-spawn
  segment collision, mint clash incl. reserved names, the FULL binding order incl. escape-hatch
  adoption + first-binding-holds refusal, label dedup per-spawn,
  path-segment validation, TTL-liveness + provisional TTL); register/confirm-flow tests (stash,
  hygiene, readyState gate); alias tests (send resolution via liveTeam, wake suppression);
  codegen drift; Android `testDebugUnitTest` + `assembleRelease`.

## Deploy order (the halves are not atomic; scope is PER MACHINE - a plugin only registers with
its own machine's gateway via BRIDGE_ROUTER_URL, so a multi-gateway fleet upgrades machine by
machine independently)

1. **Gateway + daemon first** (git pull + rebuild): confirm-time recording tolerates the CURRENT
   7.2.6 plugin - its ad-hoc registers omit claudeSessionId AND cwdName, so a fresh confirm lands
   in tier 3 (adopt the free self-composed segment, sessionLabel = the segment: a transitional
   hex-labeled card, accepted); its daemon-launched registers carry the id -> stash + confirm
   binds tier 1. Live sessions across the restart re-register + re-confirm into migrated records.
2. **Plugin second** (version bump + marketplace reload): claudeSessionId returns unconditionally -
   safe once THIS machine's gateway is upgraded (an old gateway would record at register again,
   reopening the PR #105 bug for the skew window).
3. **APK last**: create/rename UX + sessionLabel rendering. Old APK against new gateway stays
   fully functional including create (the sessionName-only path adopts the typed slug - no
   ghost-thread window); it renders hex leaf labels and shows `verifying` as "ended" until
   upgraded. New APK against an old gateway falls back to `sessionName` + local composition
   (optional reply fields absent).

## Edge cases

- Worker teammates: worker reply -> reject + FULL cleanup (Phase B hygiene), never a record.
- No harness session id: confirms fine; record has no claudeSessionId -> wake launches fresh.
- Gateway restart: records persist; live sessions re-register + re-confirm (chips dip to
  `verifying` until each LLM re-answers - accepted honest blip). `hs-` per restart stays the cost
  of proof for flag-enabled sessions.
- Conflicting incarnation claims: first-binding-holds; refused claims logged, never silent
  takeover.
- Unanswered handshakes: no retry in this plan (the LLM answers when its turn ends; a flag-less
  harness never answers by design); handshakePending TTL bounds the map; the session stays
  `verifying`/invisible per its record state.
- TTL: provisional records get the standard 30-day TTL from creation (an instant card cannot
  vanish mid-boot; failed launches stay retryable); live records are touch-refreshed; unconfirmed
  records are never touch-refreshed and age out.
- Pre-existing cross-Domain shares to a session that never confirms under the new model: the
  record (migrated, confirmed-at-migration) still lists, so shares survive; only recordless-live
  sessions are outside the gate (intended).
- The `hs-` reply path does not require the team to be listed, so a `verifying` session can always
  complete its confirm.
- An alias-served record (a manual `claude --resume` re-incarnation registered under a DIFFERENT
  self-composed name than its record's segment) has no way for teams() to resolve its live socket
  until the incarnation re-confirms: liveTeam is stamped only at confirm, and restore() strips it,
  so in the pre-confirm window (and after a gateway restart) the record reads `available` and a send
  can wake a second incarnation. Accepted: the window is small (a resume confirms at the end of its
  first turn) and confined to the manual-resume-under-a-different-name flow; the daemon path re-wakes
  under the same composite (canonical lookup hits -> verifying -> online). Phase E's wake-suppression
  consumes liveTeam once stamped.
- A devcontainer live under a BARE project name (no `.session`) reads `available` (a spawn-point),
  not `online`: a non-composite name never becomes a record, and the wake path always launches the
  composite `project.session`, so a bare live register is not a normal flow.
- A create with an all-non-ASCII label (slugifies to empty, so no `sessionName` is sent) works
  against a new gateway (it mints from `displayLabel`) but fails against an OLD gateway (its schema
  requires `sessionName`); the failure is currently silent (onSpawn has no error surface). Accepted:
  the deploy order upgrades the gateway before the APK, so the new-APK-vs-old-gateway window is
  transient, and a surfaced create error is a follow-up UX nicety.
- A grammar-ambiguous composite team (a dotted project like `my.app.foo`, parsed as a non-slug
  session segment) is not stored as a record. The old resume map stored it by raw key, but the old
  teams() asleep filter's isComposite+isSlug guard already hid it from the board and it was never
  wakeable, so refusing to record it is a consistency win, not a regression (the listing surface is
  byte-identical).
- Unbounded record growth from an unauthenticated register + `/respond` flood (each confirm minting
  a record, no count cap, 30-day TTL, whole-store 3s snapshot) is the same unauthenticated-surface
  DoS as before and stays deferred to `gateway-auth-surface.md`. Phase B RAISES the bar for it (a
  record now needs a completed handshake, and the raw register path does zero store work); it does
  not lower it. The tier-4 mint fallback is non-idempotent only for an adversarial reserved/catalog-
  colliding segment (a legitimate session's segment is a hex or daemon name and converges via tier 1
  or tier 2), so its growth folds into the same deferred surface.
- Daemon/gateway version skew (a NEW daemon taking a wake from an OLD gateway that sends no
  workdirHint) makes a host session open in $HOME instead of ~/projects/<segment>, because the new
  daemon no longer derives the workdir from the opaque session segment. Accepted: the documented
  deploy (`down.sh && start-gateway.sh && start-host-daemon.sh`) runs NO daemon during the gateway
  swap, so the skew window never opens; it is transient and self-heals once the gateway image is
  rebuilt. Not worth a segment-fallback shim in the daemon (which would re-key the workdir on the
  opaque id the plan deliberately moved off).

## Noted (declined by design)

- `assertDaemonDrivable` judges "user-launched" from `liveTeam.team != teamOf(record)` (alias-served),
  not a fresh registry probe. Correct for the intended alias case. The one divergence is a
  pathological wake to a composite whose SESSION segment equals a catalog project name (tier-4 mint
  desyncs the record id from the requested team), where a daemon-launched session reads
  "user-launched" - but that session's terminal is already broken by the name mismatch, so it is a
  misleading message in a rare edge, not a new regression.
- `forget` on an alias-served (user-launched) record issues killSession against the record's OWN
  canonical name, never the user's alias process (a different name), then drops the record - so it
  honors "cannot kill the user's terminal." A reconnect-race (a canonical pane whose tmux is alive
  but whose WS dropped, with an alias having taken over liveTeam) could kill that reconnecting daemon
  pane, but "forget tears down the daemon session" is defensible and the window is exotic.

- The 6-hex id recipe is hand-rolled in four small sites (session-store `randomId`, team-name
  `randomTeamId`/`stableTeamName`, consoleHandler `mintedSessionId`). Factoring a shared
  `randomSlugId`/`stableSlugId` into session-id.ts was declined: the gain is cosmetic DRY of trivial
  one-liners and it would add a `node:crypto` dependency to the pure address-grammar module (which
  has a hand-authored Kotlin twin). Left as independent one-liners.

## Painpoints

Read-only crust sweep (4 scouts + synthesis), most-actionable first. These are follow-up work, NOT
gates on this plan. The bug classes flagged in Phase E's own surface (establishRecord asleep-holder,
resolveHandshake confirm-ordering) sit beyond the plan's stated first-binding-holds invariant (which
scopes the refusal to a LIVE holder); see the plan-completeness note. The two legacy-landmines marked
`(tracked)` are already scheduled for post-upgrade removal by Phase G's migration-temp TODO.

**Bug classes**
- `src/gateway/websocket.ts : createWebSocketHandlers : establishRecord` - **bug-class** - first-binding-holds only refuses a LIVE holder, so an asleep holder lets tier-1 bindBySegment bind the same claudeSessionId onto a second record, breaking one-record-per-transcript and spawning duplicate `--resume` processes on wake. (Beyond the plan's live-holder invariant; needs a resumeRecord check even when the holder is asleep.)
- `src/shared/session-store.ts : SessionStore : sweep` - **bug-class** - TTL sweep drops a still-connected record because lastSeen is refreshed only by teams()->touchLive (never the heartbeat), making a live session invisible in teams() and re-mintable while resolveLiveIncarnation still routes to it; the comment's "can never delete a live session" is false. (30-day window; the fix is to touchLive from the heartbeat or spare live records in sweep.)
- `src/gateway/websocket.ts : createWebSocketHandlers : resolveHandshake` - **bug-class** - ws.data.handshakeConfirmed is set before establishRecord, so a first-binding-holds refusal leaves a confirmed-but-recordless socket that resolveLiveIncarnation reports as canonical live, producing a routable-but-invisible duplicate. (Compounds the establishRecord finding; set confirmed only after establishRecord succeeds.)
- `src/gateway/console/consoleHandler.ts : createConsoleDispatcher : handleFrame` - **bug-class** - opCache evicts oldest past size 256 regardless of settle state; a retried opId older than 256 re-runs its op, losing at-most-once for side effects (duplicate channel_push, re-minted handshake window) with no host-side dedupKey backstop.
- `src/gateway/console/consoleHandler.ts : createConsoleDispatcher : mintedSessionId` - **bug-class** - 6-hex (24-bit) sha256 truncation with no re-roll on the deterministic create path; two colliding (conversationId, opId) creates in one spawn make the second silently reattach the first session instead of minting.

**Dead code & stale names**
- `src/shared/session-store.ts : SessionRecord : workdirHint` - **dead-code** - written, sanitized, persisted, and restored but never read; the daemon infers workdir from the session id, so its "drives ~/projects/<hint>" comment describes unwired behavior. (Phase F wires this - resolve there, not a standalone cleanup.)
- `src/gateway/routes.ts : createRoutes : send (channelOnly CLI-mode guard)` - **dead-code** - the `channelOnly && targetMode !== "channel"` branch is unreachable since ConnectionMode is single-value "channel", and its "is a CLI-mode agent" error names a concept retired with the host split.
- `android/.../switchboard/ChatRepository.kt : ChatState : label` - **stale-name** - the localGatewayId parameter is unused by the body (sessionLeaf ignores gateway id) yet still threaded through all six call sites, implying a relevance that no longer exists.

**Framework & dup-logic**
- `src/shared/session-id.ts : Address : (missing) localName + isLocalTo methods` - **framework-violation** - Address/SpawnPoint own .canonical but not the locality predicate or local-team-field projection every gateway caller needs, forcing both to be hand-reimplemented at every site (all findings below); the value object should own them.
- `src/gateway/routes.ts : createRoutes : localAddress` - **dup-logic** - the `parseSessionName -> Address.local(...)` builder is triplicated (routes.localAddress, consoleHandler.localAddress, gatewayRelay.localShareTarget), each carrying a "must match byte-for-byte" comment that is exactly the missing-single-owner smell; should be Address.localFromName.
- `src/gateway/console/consoleHandler.ts : resolveTmuxTarget/rename_session/assertShareable : local-gateway check` - **framework-violation** - the raw `t.domain !== localDomain || t.gateway !== localGatewayId` locality test is re-implemented at 5 sites (plus routes resolveLocalTarget and send); belongs on an Address.isLocalTo predicate.
- `src/gateway/console/consoleHandler.ts : canonicalShareTarget/assertShareable/forget : SpawnPoint->local-name collapse` - **dup-logic** - the `t instanceof SpawnPoint ? t.spawn : composeSessionName(t.spawn, t.session)` collapse recurs across 6 sites; should be a single Address/SpawnPoint .localName projection.
- `src/gateway/console/consoleHandler.ts : dispatch : dedupKey / mintedSessionId` - **dup-logic** - the `${conversationId}:${opId}` idempotency key is spelled inline in four ops and re-hashed by mintedSessionId, so the at-most-once key has no single producer and a recipe change must be mirrored in five places.
- `src/gateway/federation/gatewayRelay.ts : createGatewayRelayHandler : localKind` - **dup-logic** - "what kind is this session" materializes the whole teams().json() array and .find()s it in 3 sites (localKind, the inbound list-filter, assertShareable); should share one kind-classifier with teams().
- `src/gateway/index.ts : startGateway : doWakeTeam / relayToHost host-ws resolution` - **dup-logic** - the live-host-socket lookup (`registry.get("host")` then find readyState===1) is copied verbatim in doWakeTeam and relayToHost; "the one live host socket" is an ownerless resolver concept mirroring resolveLiveIncarnation.
- `src/gateway/routes.ts : createRoutes : sealTargetFor` - **dup-logic** - sealTargetFor re-encodes the sealer's local-then-cross-Domain-then-throw precedence that sealer.seal resolves again, so the seal-target collision rule lives in two owners that must stay in lockstep.
- `src/gateway/routes.ts : createRoutes : localDomain sentinel normalization` - **dup-logic** - the LOCAL_DOMAIN_SENTINEL fallback is applied three inconsistent ways (`?? SENTINEL`, `|| SENTINEL`, raw + Address.local internal) that treat empty-string differently; Address.local already owns this, so the call-site fallbacks are redundant and drift-prone.

**Legacy landmines**
- `src/gateway/index.ts : startGateway : SCHEMA_VERSION one-shot wipe` - **legacy-landmine** - the SCHEMA_VERSION="2" block wipes old-grammar pending-jobs/mailboxes/cross-domain-share-state on first boot after the address-grammar flip; pure temp migration code, the whole try-block plus sentinel read/write is removable once all gateways have booted past schema-2.
- `src/shared/session-store.ts : SessionStore : restore()` - **legacy-landmine** (tracked) - the `!persisted` branch reads the OLD `{claudeSessionId,lastSeen}` resume-map shape and synthesizes a record; every persist tick re-snapshots the new shape, so the branch (and its guard/ternaries) is dead once all gateways have re-written session-resume.json.
- `src/gateway/index.ts : startGateway : LOG_DIR legacy-dir cleanup` - **legacy-landmine** - LOG_DIR=/app/log exists only so the schema wipe can rmSync legacy-dir copies of the old files; nothing else reads it, so it dies with the schema-wipe block.
- `src/shared/schemas.ts : TeamInfoSchema : gatewayId / ConsoleRegisterResultSchema.gatewayId` - **legacy-landmine** - both comments describe the retired slash grammar (`gateway/team`, "migrates bare-keyed threads") though the live grammar is the dot path and the console runs a one-shot bare-keyed wipe on upgrade.
- `src/shared/schemas.ts : WsRegisterSchema : claudeSessionId` - **legacy-landmine** (tracked) - the comment describes a `team -> claudeSessionId` map that SessionStore replaced (index.ts now reads sessionStore.getByTeam(team)); the field is live but the comment points at a removed structure.
- `src/shared/session-id.ts : module header : unified-address-grammar migration comment` - **legacy-landmine** - header describes the grammar as added "alongside the legacy TeamAddress/SessionId/NoticeId ... deleted at the wire flip," but those classes are already gone and the wire has flipped, so it narrates a completed migration as in-progress.
- `src/gateway/console/consoleHandler.ts : ConsoleHandlerDeps.domainStatus : pre-feature-evie fallback` - **legacy-landmine** - the omit-and-fall-back-to-already-rooted branch (and mirrored ConsoleRegisterResultSchema optionality) is back-compat for evie pods predating the status field; removable once all pods report domainStatus.

**Cosmetic DRY (framework audit, declined - no correctness gain)**
- `src/shared/session-store.ts : SessionStore : create` - **cosmetic** - workdirHint is seeded identical to the sessionLabel seed at all four record-creation sites; create() could default `workdirHint ?? sessionLabel` so call sites drop the redundant param. Already-correct everywhere, so pure hardening.
- `src/gateway/index.ts + consoleHandler.ts : provisional-record rollback` - **cosmetic** - the adopt-then-forget-on-failure recipe is orchestrated at two sites, but the rollback predicates legitimately differ (create rolls back synchronously on a launch-op failure; doWakeTeam guards on confirmedAt + live over the WAKE_TIMEOUT window), so they stay separate by design; only the shared load-bearing `hostWorkdirHint` precedence was consolidated.

## Verification (live)

- Phone create -> card instant -> boots -> `verifying` -> confirm -> `online`; reboot -> wake ->
  same card resumes in the right workdir (~/projects/<label>).
- Loose `claude` (no flag) -> never appears, no records, exits clean.
- `claude` WITH the channels flag -> appears on confirm labeled by cwd (`switchboard`,
  `switchboard-2` on collision), persists as available after exit, resumable from the card;
  relaunching bare from the same directory adds its OWN new card (Q4: keep them all), cleaned by
  TTL or Forget.
- Manual `claude --resume` of a phone session (with flag) -> existing card lights up live via
  liveTeam, send from phone reaches the live terminal session, wake is suppressed while it lives,
  terminal view reports user-launched, no duplicate card.
- Rename from phone A -> phone B converges on next refresh; Domain displayName unchanged
  everywhere.
- Old APK against new gateway: create still works (typed slug adopted), board renders (hex labels,
  verifying-as-ended), Domain name intact.
