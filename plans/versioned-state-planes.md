# Versioned State Planes (gateway -> console live sync)

The 5x-recurring "tile never updates on events" staleness class, attacked at the framework level.
Assessment: framework-first-assessor, 2026-07-17. Reference architecture studied: nyaadot's
NetAction (journal + snapshot providers + Merkle desync self-heal + reactive bindings).

## Root cause (assessed, file:line verified)

The board pulse bar is `busy = statusWord == "verifying" || (live && working(team))`
(MainActivity.kt:1591) - a union of TWO pull-only planes, both structurally eventless:

- **Verifying half:** the gateway flips verifying->online SYNCHRONOUSLY at handshake confirm
  (websocket.ts:607-611 via routes.ts:1100) and `teams()` reads the live flag (routes.ts:717-729).
  Server is innocent. But the console's teams refresh sits at the TOP of the poll loop, gated
  behind `client().poll()` which holds ~40s (LONG_POLL_HOLD_MS; server waitForAppend
  consoleHandler.ts:684-686). A status flip appends nothing to the mailbox, so it CANNOT settle
  the held poll. Staleness: ~40-70s visible, or unbounded on the pre-confirm handshake residual
  (plans/handshake-retry-and-gating.md).
- **Working half:** `sessionWorking[team]` is set by a boot-time peek and then never re-poked -
  the board only pokes on a list/lastActivity change (MainActivity.kt:394-401,
  ChatRepository.kt:2605,2618). A working->idle transition with no later console-visible event
  leaves the pulse STUCK INDEFINITELY. This half explains "never clears without manual refresh."
- Manual Refresh works because `refreshTeams()` bypasses the held poll out-of-band. "Another
  event on top" works because the append settles the poll.
- `withFreshTeams` merge is CORRECT (wholesale overwrite, no optimistic-override bug). The five
  failed fixes were all callsite-driven nudges (forceTeamsRefresh x2, delay(400) spawn nudge,
  pokes on more triggers) - none gave presence an event, so every unnudged transition stays stale.

## Plane map

| # | Plane | Trigger | Worst latency (visible) |
|---|-------|---------|------------------------|
| 1 | Mailbox journal (messages/notices/plugin_action) | append settles held poll (device-mailbox.ts:207-227) | sub-second (reference design) |
| 2 | Teams snapshot (status/label/version chip/description) | 30s timer + force flags | 40-70s or unbounded |
| 3 | Working pulse | client tmux poke per board change | unbounded (poke starvation) |
| 4 | Domain keyring | version-gated piggyback on poll response (consoleHandler.ts:697-704) | one poll cycle (the precedent) |
| 5 | Linked-peers roster | folded into teams refresh | inherits plane 2 |

Compose side is already reactive (collectAsState, wholesale ChatState) - latency is entirely
"fresh data into _state", never "state onto screen". fanOutConsolePush never relays status
cross-gateway (routes.ts:426-441).

## Assessor recommendation

Generalize the domainVersion precedent into a **plane registry**: named versioned snapshots
(domain, presence=teams payload, later working/unread/peers). Poll carries knownVersions;
response returns only changed planes; every held poll's waiter is woken by mailbox append OR any
plane version bump (one shared wakeAll). Presence bumps inside SessionStore mutations - the
store is the single writer, so a mutation physically cannot forget to announce itself
(nyaadot's inversion). Presence is a versioned snapshot, NOT journal entries: ephemeral
last-write-wins fights the mailbox's durability/cap/cursor semantics (a device asleep an hour
must get current truth, not replay 40 dead flips).

Dependency-ordered improvements: (1) versioned presence plane + shared early-settle;
(2) server-derived working plane on the same rail (deletes plane 3); (3) migrate linked-peers +
cross-device unread onto the registry; (4) retire TEAMS_REFRESH_MS + every force/nudge hack;
(5) TerminalView wakeRequested latch unified on the now-reliable online signal.

## Questionaire

**Stated requirement (user):** "extremely responsive while foreground? I don't want 70 sec
delays. It can tier down when background." Foreground = sub-second status propagation;
background may ride the existing idle-pushback ladder.

**Q1. Unifying abstraction: A) Versioned plane registry + shared poll wake.** Named versioned
snapshots (domainVersion precedent generalized) multiplexed on the poll response; poll carries
knownVersions; response returns only changed planes; a version bump settles every held poll via
the same waiter primitive a mailbox append uses. Bumps happen inside store mutations so a state
change cannot forget to announce itself. Recommended because: proven in-repo (domainVersion),
reuses the mailbox waiter, sub-second foreground (one RTT, identical to messages), background
tiering inherited from the idle ladder for free, and version comparison on every poll is the
self-heal. B (journal entries) rejected: presence is ephemeral last-write-wins - fights mailbox
durability/caps/cursors, replays dead flips after sleep. C (dedicated push transport) rejected:
new surface through evie, new battery/idle implications.

**Q2. Scope: C as two phases.** User: "One phase to B. then after green, another phase C to
catch the ones I didn't complain about (yet!). Phase for C will also be where you delete all the
dupe and diverged code that each system was doing their own sync."
- Phase 1 = registry + presence plane + server-derived working, one deployment; both halves of
  the pulse bar become event-driven; teams timer / force flags / spawn nudge / client poke
  machinery deleted in the same migration. *(Amended lap 1, flagged to user: the periodic
  teams timer is DEMOTED to a capability-gated legacy fallback instead of deleted outright -
  a new APK against a not-yet-updated gateway (guest Domains) must not regress below today.
  Physically deleted in phase 2 once the fleet is upgraded. All other deletions stand.)*
- Phase 2 (after phase 1 is green) = linked-peers plane, cross-device unread groundwork,
  terminal wake latch rework, AND sweep-delete every remaining hand-rolled sync path each
  system grew on its own (the dupe/diverged per-system sync code).

**Q3. Working derivation: intent-driven cooperative peek scheduler** (user's design, "sorta
hook like" - nyaadot-style interest management: "User says their intent, and the daemon
adjusts to serve the user"):
- The phone declares its focus intent to the daemon: board-foreground / terminal(session) /
  background. Cadences per intent:
  - Foreground on the session list: daemon peeks ALL listed live sessions at 2s.
  - In a session's terminal view: the phone tells the daemon "this is where I'm looking";
    that session refreshes at the phone's configured rate (user's setting: 0.5s).
  - Backgrounded / not in app: minute intervals.
- Design implications settled alongside (mine, pending user objection): intent piggybacks on
  the existing poll request plus terminal open/close, with a TTL so a killed app degrades to
  background cadence without a goodbye; when the phone is already client-peeking a terminal
  for rendering, the daemon derives status from that same frame stream through hostOpRunner's
  single-flight instead of double-peeking (one peek stream, two consumers: frame to phone,
  regex to plane); multi-console intents union and the fastest wins; derivation = TS port of
  the spinner + logged-out regexes (working + needs-login both move server-side); plane bump
  only on flip; working cleared on disconnect.

**Q4. Multi-gateway presence: parallel and equal, phase 1.** User (rejecting a local-first
phase split): "Do you mean a second gateway that is as equally remote as the first one? If
there's code that treats 1 gateway as primary, then that's a flawed handling and also needs
fixing. It should work in parallel, equally. [Multi-tenant guests] It should work from their
phones to their Gateway as well."
- Every gateway is simultaneously a presence SOURCE (its own sessions, derived by its own
  daemon) and an AGGREGATOR (merges same-Domain peers' presence for whatever consoles route
  through it). No gateway is privileged Domain-wide; the phone's route gateway is only its
  transport anchor (the console-bridge poll target, with evie's existing latest-gateway
  fallback), never a data-plane primary.
- Presence bumps relay same-Domain over the existing sealed gateway_relay (the console_push
  precedent: origin-only fan-out, dedup, same-Domain-only gate). Aggregate carries per-source-
  gateway versions + freshness so an offline peer gateway's sessions degrade honestly (stale-
  marked, never frozen "online"). *(Amended lap 1: push alone is at-most-once and cannot
  deliver Q4's own "never frozen" requirement - the federation leg is now a versioned
  EXCHANGE with anti-entropy, see Plan item 6.)*
- Intent federates the same way: a board-watching console ramps every same-Domain daemon to
  the board cadence; terminal intent stays route-local until the cross-gateway terminal-view
  gate is ever lifted (peek is gated off cross-gateway today, unchanged by this work).
- Tenant Domains inherit all of it automatically - the mechanism is per-Domain symmetric,
  same-Domain-only gated; a guest's phone -> their route gateway -> their Domain's gateways.
  Cross-DOMAIN (linked peers) presence stays on the discovery refresh - out of scope here.

**Closing rulings (presented, no objection - accepted with "ok write it"):**
1. Wire shape: flat optional per-plane fields on the poll request/response beside the existing
   domain/domainVersion pair; no generic plane map on the wire (codegen forbids decode-side
   unions). The plane registry is a server-side abstraction only. *(Refined lap 1: per-source
   version sets ride as ARRAYS of flat objects, never maps - a map field lands as codegen's
   untyped JsonObject fallback, outside the typed + fixture gates.)*
2. Presence payload = the full team list (status, working, needsLogin, label, description,
   version chip, mode, lastActive) as ONE versioned plane; any change ships current truth.
   *(Refined lap 1: lastActive and other per-second-churn timestamps are AMBIENT payload -
   they ride the snapshot but are excluded from the identity hash that gates bumps, else the
   version churns continuously and the tripwire is dead or false-firing.)*
3. ~~The teams op survives phase 1 as pull-to-refresh + cold-hydrate~~ *(Superseded lap 1:
   a surviving unversioned teams() writer can strand stale content behind a current plane
   version - the exact "believed current, actually stale" state the plan exists to kill.
   Pull-to-refresh = reset knownVersions + immediate re-poll (full rehydrate through the ONE
   plane path). The teams() op remains ONLY on the capability-gated legacy-gateway fallback
   path, where no plane version exists to strand.)*
4. Presence bumps do NOT reset the background idle ladder; only real comms activity does.
   Background freshness = minute-tier peeks picked up at ladder cadence.

## Plan

Refined lap 1 (72-agent audit, 55 findings) then lap 2 (42-agent targeted re-audit of the
rewrite, 31 confirmed findings, 3 verify calls lost to a rate limit mid-run - see Audit
sections). Lap 2 hit hardest on federation/epoch soundness and one unflagged direction
deviation; both are corrected below.

## Phase 1 - plane rail + presence + working (one deployment)

**Framework core (TS, gateway/shared):**

1. **Plane registry - the one-call framework.** A plane registers ONCE:
   `registerPlane({ name, snapshot(), identityOf(snapshot) })` - the registry owns everything
   else: version identity, dirty-tracking, bump gating, poll delivery, and the tripwire, for
   EVERY plane uniformly (presence now; domain migrates internally onto the SAME identity
   shape - its wire stays a bare version string, translated at the registry boundary so lap-1's
   "wire unchanged" claim actually holds; phase-2 planes inherit all of it as genuine
   one-liners).
   - **Version identity = (bootEpoch, counter) + a persisted hash + a cleanShutdown flag,
     bundled ATOMICALLY into SessionStore's own snapshot** *(rebuilt lap 3 - lap 2's "zero
     bumps on restart, epoch persists" claim was unsound in three independent ways the lap-3
     audit proved reachable: (i) SessionStore's 3s persist tick is decoupled from the real-time
     bump/fan-out path, so an uncaughtException between ticks - which deliberately does NOT
     flush, index.ts:182-189, by design - restores a counter BEHIND what peers already
     installed live, and the same-epoch merge rule then silently drops every subsequent
     lower/equal update from the true source forever; (ii) presence's epoch+counter and
     SessionStore's own content were two SEPARATE DurableStore files with zero cross-file
     write coordination - the established four-sibling idiom in this exact function
     (index.ts:171-179) - so one file's write failing (durable-store.ts's swallowed
     best-effort error) while the other survives desyncs an intact-looking epoch/counter from
     actually-lost content; (iii) "identityOf on restore reproduces the pre-restart hash
     bit-for-bit" is false for any session that was live at shutdown, since ruling 2 hashes
     status/mode/version (routes.ts:723-730's `resolveLiveIncarnation`-derived fields), and
     NO socket survives a process exit, graceful or not - a "routine deploy" with any active
     session unavoidably produces a real content change the zero-bump design would silently
     swallow.)*
     - **One file, one atomic write:** bootEpoch, counter, the current identity HASH, and a
       `cleanShutdown` boolean are extra fields on the SAME object `SessionStore.snapshot()`
       produces, written by the SAME `sessionResumeDurable.save()` call (one tmp+rename covers
       both) - not a separate sidecar file. An asymmetric loss between "presence knows its
       epoch" and "SessionStore knows its sessions" is now structurally impossible; they succeed
       or fail together.
     - **Writer discipline:** every regular 3s persist tick writes the CURRENT `identityOf()`
       hash with `cleanShutdown: false` (assume dirty until proven otherwise). The SIGTERM/
       SIGINT handler (index.ts:180-181, synchronous, already the sole flush-on-clean-exit path)
       recomputes `identityOf()` fresh at the true moment of exit and writes it with
       `cleanShutdown: true` as its last action. `uncaughtException` / `SIGKILL` skip this
       entirely by design - the file on disk keeps whatever `cleanShutdown: false` state the
       last regular tick left.
     - **Boot reconciliation, replacing "zero bumps" with a correct invariant:**
       `cleanShutdown !== true` (crash, or first boot, or a missing/corrupt file) mints a FRESH
       epoch unconditionally - the persisted counter lineage cannot be trusted (nothing proves
       what happened between the last tick and the crash), so a full resync is the only safe
       move, matching the existing "unrecoverable state loss" case one level up. `cleanShutdown
       === true` keeps bootEpoch and the counter, but ALWAYS recomputes a fresh boot-time
       `identityOf()` and compares it to the persisted hash - live-derived fields make this
       differ whenever a session was active at shutdown (expected, not a bug), so a difference
       bumps the counter ONCE, correctly, through the ordinary funnel, healed automatically as
       real reconnections re-derive true status moments later. **The acceptance criterion is
       no longer "zero bumps on a routine deploy" - it is "a restart, clean or not, converges
       within one correctly-announced bump cycle, never a silent regression."** A deploy with
       no live sessions at all still produces the old cheap zero-bump path as a special case of
       the same rule (hash genuinely unchanged), so the common quiet-hours-deploy case stays
       free; the common busy-hours-deploy case now costs one honest bump instead of a silent
       lie.
   - **Hash-gated bumps (nyaadot MerkleHasher shape):** mutators only MARK DIRTY; the registry
     recomputes `identityOf` and bumps IFF the identity hash changed. Ambient fields
     (lastActive-class timestamps) ride the payload but sit outside identityOf - no churn. The
     tripwire is then exact: hash-changed-without-bump = escaped write, log loudly + self-bump;
     it runs on a slow tick, never on the per-poll hot path.
   - **`touchLive`'s read-path call site stays, corrected from an earlier claim in this same
     item** *(caught by Phase 2's align-fan-out audit, which found the code diverging from this
     exact commitment and traced why)*: the original text here claimed the `teams()` read-path
     `touchLive` call would be deleted, on the theory that excluding `lastActive` from the
     identity hash made the write itself pointless. That conflated two separate concerns -
     `touchLive`'s actual, sole purpose (per its own doc comment in `session-store.ts`) is
     refreshing a live record's `lastSeen` so `SessionStore.sweep()`'s TTL eviction can never
     delete a still-live session's record out from under it; excluding `lastActive` from the
     identity hash only solves the churn problem, and says nothing about whether the underlying
     write should still happen. `touchLive` is `teams()`'s ONLY caller in the whole codebase, so
     deleting it would let `sweep(SESSION_RESUME_TTL_MS)` (30 days) silently evict a
     continuously-live session's durable record the moment it crossed that TTL - a real
     regression, not a cleanup. The call stays.
   - **Closed world - concrete mechanism** *(pinned lap 2 - zod fields carry no plane marker,
     so "a schema-side test" was hand-wavy)*: every plane-sourced field on PollResult/TeamInfo
     is defined through one shared schema helper (`planeField(planeName, zodType)`) that tags
     the field's origin in a side registry at schema-definition time; a single test asserts
     every registered plane has >=1 tagged field and every tagged field's plane is registered -
     a genuinely new gateway state either goes through `planeField` (tracked) or a raw field
     (caught by a second test that diffs PollResult's own key set against the tagged set plus
     an explicit small allowlist of non-plane fields). No enumeration to keep by hand.
   - **`identityOf` scope, pinned:** each gateway's presence plane identity is computed over
     its LOCAL client-facing view - own sessions plus whatever peer sub-planes are currently
     merged in plus the local freshness overlay (item 6). It is never computed over a bare
     "local-only" slice. A `mergeApply` therefore changes local identity like any other dirty
     write and correctly wakes this gateway's own PollWaitHub (below) - `mergeApply`'s only
     special property is that it never calls `localBump`'s federation fan-out, not that it
     skips the local bump.

2. **PollWaitHub - one wake primitive, race-free.** A held poll registers its waiter UNDER THE
   HUB LOCK BEFORE comparing versions; bumps take the same lock - the
   bump-between-compare-and-register lost-wake is structurally impossible. Settles on: mailbox
   append (its conversation) OR any registered plane's identity bump vs the presented
   knownVersions. **Compared per-plane with ONE rule, no "ahead" special case** *(simplified
   lap 3 - an earlier "ahead means withhold" branch was found to conflict with presence's own
   monolithic send shape and to invert into a permanent staleness trap on console failover, see
   the lap-3 Audit section)*: ANY difference - behind, ahead, or an unrecognized/different
   epoch - means "send this plane's current truth," full stop, exactly generalizing the
   existing domainVersion rule with zero added cleverness. A console that was legitimately
   ahead (cached a fresher row via a different gateway before failing over) can see that one
   row read as momentarily older from its NEW gateway's own current truth - bounded and
   self-healing within one anti-entropy cycle (item 6), the same bound every other cross-
   gateway staleness in this design already carries, in exchange for deleting an entire class
   of ordering bugs a "smarter" compare kept reintroducing.
   **Coalescing:** a min-settle window (~250ms) batches a burst of bumps into one settle -
   foreground latency stays sub-second, poll rate stays bounded (never RTT-bounded). The
   response tags WHY it settled (see wire, item 7) so the client's instant-empty degradation
   heuristic cannot misread a plane-settle as a broken old gateway. On disconnect, an
   in-flight held poll's waiter is deregistered (no leak); the client's own focus-transition
   cancel (item 5) is a normal disconnect from the hub's point of view.

**Presence (TS):**

3. **Presence facade - single writer over the ACTUAL read set.** The facade's input set is
   derived from what teams() reads (routes.ts:677-748), not prose: SessionStore records; the
   live registry with ALL FOUR socket flip paths (register, handshake confirm, disconnect,
   evictSocket); the wake/create in-flight containers (index.ts inflightWakes/inflightCreates
   move INTO facade-owned state with enter/leave mutators - every wake outcome including
   failure, timeout, and daemon-disconnect failAll announces itself; the silent
   verifying->available flip dies); the catalog scan (both its concrete mutation sites route
   through the facade, and the catalog's own refresh lands as a facade write like any other -
   no separate unrouted frame); `domainMeta` (displayName/isAdminDomain - a facade input like
   any other, since teams() surfaces it); and the working/needsLogin map (see item 4 - the
   derivation loop's write is itself a facade mutator, not a bypass of the enumeration: the
   enumeration is "every writer of a snapshot-read field", and the derivation loop is exactly
   one such writer, routed through the facade's own working/needsLogin setter). SessionStore
   marks dirty inside its own mutation funnel; socket + wake flips route through facade
   setters. Enforcement: (a) no module outside the facade writes any identity field (asserted
   by the same closed-world mechanism as item 1, applied to facade inputs), (b) the registry
   tripwire (item 1) catches and self-heals anything that escapes anyway.
   - **Derivation-death semantics, pinned per cause** *(lap 2 found "cleared on disconnect"
     ambiguous between three distinct events)*: (i) host-daemon disconnect - every session's
     working/needsLogin clears to UNKNOWN (the daemon is the only frame source; nothing can be
     derived); (ii) a single session's socket disconnect/wake-failure - THAT session's
     working/needsLogin clears to UNKNOWN (it can no longer be peeked, regardless of daemon
     health); (iii) a peek-failure streak on an otherwise-connected daemon - same session-level
     clear. All three route through the same facade setter and bump like any other flip - "the
     thing that could tell you got quiet" is itself an announced state change, never a frozen
     last-known value. Reconnect re-derives from the next frame.
   - **Sleep semantics, pinned** *(lap 2 found this genuinely unset)*: a session going fully
     asleep (verifying/online -> available) clears working/needsLogin to UNKNOWN in the SAME
     facade write as the status transition - there is no window where status reads "available"
     while working/needsLogin still hold a stale live-session value.

4. **Working/needs-login derivation runs on the HOST DAEMON** *(reverted lap 2 - corrects an
   unflagged deviation from Q3)*. Q3's recorded design has the daemon adjusting to serve
   declared intent ("the daemon adjusts to serve the user"); lap 1 silently moved derivation to
   the gateway, justified by an assumption - "no plugin redeploy" - that does not hold: the
   host daemon (`src/main-host-daemon.ts`) is deployed by git-pull + `start-host-daemon.sh`
   restart, entirely independent of the `.claude-plugin/plugin.json` marketplace/reload
   sequence that governs the in-container MCP tools. There is no deploy-cost reason to
   centralize it, so it moves back to match the recorded answer:
   - The daemon runs the regex (TS port of AgentScreen's spinner + logged-out patterns, pinned
     by cross-runtime vectors, session-id-vectors pattern) locally against every frame it
     captures - zero extra hop for the raw ANSI text. It reports only the small derived
     `{working, needsLogin}` bit up to the gateway over the existing host WS, which the
     facade's session-level setter (item 3) applies and bumps on flip.
   - Regex runs ONLY on kind=tmux frames (container-logs boot frames excluded - no
     false-positive working/needsLogin from log text).
   - **2-frame hysteresis on the SAME underlying frame content, not merely two calls:** a flip
     must be observed on two consecutive DISTINCT frames (by hash) before it lands. A
     hash-unchanged repeat peek is not a second confirmation (nothing new was observed) and
     does not itself clear or extend the hysteresis window; it simply carries no new evidence.
     One transient footer state cannot become a mesh-amplified bump pair. Worst-case flip
     latency at board cadence: ~4s; at terminal cadence: ~1s.
   - Frames come from BOTH streams through hostOpRunner's single-flight, which already lives
     daemon-side: scheduler-fired peeks and client rendering peeks relaying through routes. A
     hash-unchanged peek implies an unchanged frame, hence unchanged status - no derivation
     loss, and no schema conflict with hysteresis (previous point).
   - **Derive-only peeks do not resize the pane.** tmuxCore's capture path resizes to the
     TERMINAL VIEW'S own geometry as part of rendering a frame for display; a new
     `captureNoResize` variant skips that step and is used by scheduler-fired peeks that exist
     purely to drive derivation, never by a client rendering peek. The two concurrency
     properties this item wants - one shared single-flight per pane, and a resize-free
     derive-only path - are reconciled by making resize a parameter of the SAME capture call
     rather than a second competing capture: single-flight coalesces concurrent callers
     requesting the same pane regardless of their resize flag, and serves the highest-fidelity
     (resized) result to any renderer that was waiting, while a derive-only-only window uses
     the no-resize path. No second peek stream, no doubled exec cost.
   - **Scope:** only tmux-backed targets (devcontainer + host sessions) derive. A live session
     with no peekable pane (loose desktop peer, user-launched alias) carries
     working=undefined - the tile shows status without a pulse, honestly, instead of freezing.
   - **Priority lanes, concrete mechanism** *(pinned lap 2 - hostOpRunner's pool was FIFO)*:
     the runner's slot semaphore gains two lanes - INTERACTIVE (the actively-viewed terminal's
     0.5s stream) and DERIVE (board-cadence scheduler peeks) - INTERACTIVE always preempts
     queued DERIVE requests for slot admission; DERIVE never blocks behind more than one
     in-flight INTERACTIVE request. A wedged board target can never starve the terminal stream.

5. **Intent.** The poll request carries `focus`; on a focus TRANSITION (board<->terminal<->
   background) the client cancels its in-flight held poll and re-issues with the new focus -
   intent propagates in one RTT, not at held-poll expiry, with zero new ops (the cancel is an
   ordinary abandoned-request disconnect from the hub's side, item 2). TTL expires intent to
   background after N missed polls (killed app needs no goodbye) - pinned at 3 missed polls
   at the CURRENT cadence, so a killed foreground app degrades within seconds, not tens of
   seconds. Multi-console intents union, fastest wins. A terminal's own rendering-peek stream
   doubles as implicit terminal intent (belt and suspenders). **Zero-watcher floor:** with no
   console holding any intent at all, sessions still derive at the background cadence (60s) -
   intent only ever RAMPS UP the floor, never turns derivation off entirely, so a session
   worked on by no one watching still eventually reflects reality instead of freezing at
   whatever it last was when the last watcher left.

**Federation (TS):**

6. **Versioned exchange with a gateway-owned anti-entropy timer, decoupled from console
   intent** *(hardened lap 2 - the tick was previously defined AS the intent-relay tick, which
   meant zero foreground consoles = zero anti-entropy, and the merge rule had no cross-epoch
   tie-break)*. Per-source sub-planes keyed `(sourceGateway, bootEpoch, version)`.
   - **Two separate timers, one transport:** the ANTI-ENTROPY exchange is a gateway-lifecycle
     timer, owned by and running for as long as the gateway holds its evie connection -
     independent of whether any console is attached, same lifecycle class as the existing
     evie heartbeat. **Cadence: 10s** (same order of magnitude as heartbeatTick, tight enough
     that "lost push heals within one tick" is a real sub-15s bound, loose enough that a
     single-gateway Domain's short-circuit, below, still means near-zero steady-state cost for
     the common case). INTENT relay to ramp peer daemons is a separate, genuinely
     intent-gated concern that piggybacks on the SAME wire call opportunistically when intent
     exists, but its absence never pauses anti-entropy.
   - **presence_push** relays a source's own sub-plane same-Domain (origin-only, dedup-keyed,
     hard same-Domain deny) - the fast path for a normal flip, healed by anti-entropy if lost.
     **Per-destination outbound coalescing** *(added lap 3 - closes a gap in the epoch-authority
     rule below)*: this gateway keeps AT MOST ONE in-flight presence_push attempt per
     destination peer; if a new push needs to go out (a fresher bump, a new epoch after this
     gateway's own restart) while a previous attempt to that SAME destination is still inside
     `relayWithRetry`'s independent backoff window, the new push REPLACES that in-flight
     attempt's payload rather than queuing a second independent closure - `relayWithRetry`
     itself (routes.ts:560-582) is unchanged and still correct for every other FederatedOp kind
     it serves; this coalescing lives one layer above it, specific to this gateway's own
     outbound presence traffic. A stale retry can therefore never land after a fresher one
     already succeeded, since there is only ever one payload in flight per destination and it
     is always this gateway's current truth at send time.
   - **Merge rule, closed over all interleavings** *(the cross-epoch gap lap 2 found; the
     same-direct-epoch ordering gap lap 3 found is closed by outbound coalescing above, not by
     adding a second ordering primitive)*: a receiving gateway tracks, per source, the
     last-known `(epoch, version)` it has installed.
     - Same epoch as tracked: higher version wins, lower/equal dropped (out-of-order retries
       cannot roll back).
     - **Source-direct epoch authority:** a NEW epoch for source S is installed ONLY from a
       frame that is authoritatively S's own current state - S's own push, S's own rejoin
       re-push, or an anti-entropy ANSWER FROM S ITSELF. An epoch learned about S third-hand
       (an anti-entropy answer from some OTHER peer P claiming to know S's state) is NEVER
       installed over a fresher or equal locally-tracked epoch for S - it can only fill a
       genuine gap (no tracked state for S at all). Because outbound coalescing (above)
       guarantees S itself never has two conflicting direct frames in flight to the same
       destination at once, "authoritatively S's own" is now sufficient on its own - no
       separate ordering field needed between two direct-from-S epochs, since there is
       structurally never more than one live.
     - **Anti-entropy answers are scoped to the answerer's OWN sub-plane only**, never a
       relayed view of a third source - the tick already reaches every same-Domain peer
       directly (it is all-to-all, not a relay chain), so a lost push still heals in one tick
       without ever needing third-party relay, which is what made stale-data echo possible.
     - **A gateway never mergeApplies its own sourceGateway's sub-plane from ANY inbound
       frame** - the facade (item 3) is the sole writer of the local gateway's own sub-plane;
       an inbound frame naming this gateway as source is a structural no-op (closes the
       three-gateway echo-poisoning race).
   - **Structural no-re-fan-out:** the registry exposes two distinct write paths -
     `localBump()` (facade-originated, fans out via presence_push) and `mergeApply()` (inbound-
     originated, applies the merge rule above, bumps LOCAL identity per item 1's `identityOf`
     scope, never itself calls `localBump`'s fan-out). A landed push physically cannot
     gossip-loop; the loop-prevention test asserts the type-level split, not a flag.
   - **Peer freshness state machine, with a named owner and a roster-vanish trigger**
     *(hardened lap 3 - "exchange failed" alone left a peer that silently drops out of the
     cached roster entirely with no path to ever transition)*: the gateway's own anti-entropy
     timer IS the ticker, and it now checks the roster EVERY tick regardless of cost-floor
     state (see below) - so "this known peer is simply absent from a fresh roster fetch" is
     itself an observation, counted the same as a failed exchange attempt. Per peer: fresh (an
     exchange completed within the last 2 ticks) / quiet (exchange succeeded, answer had
     nothing new - healthy idle, NOT stale) / unreachable (2 consecutive ticks where EITHER the
     exchange failed OR the peer was roster-absent - that peer's rows in the LOCAL aggregate
     get a freshness annotation and a LOCAL identity bump, via `mergeApply`'s own path, never a
     forged version in the source's own stream - "stale-marked" lives in the aggregator's local
     view, not the source's version space). "Quiet because idle" and "silent because dead" are
     now distinguishable, and a peer that vanishes from evie's roster entirely (decommissioned,
     purged) reaches `unreachable` in bounded ticks exactly like one that merely stops
     answering.
   - **Cost floor, corrected** *(lap 3 found the original wording stopped the ticker
     permanently for any gateway that registered alone, with no re-arm trigger when a peer
     joined later)*: the roster-CHECK itself (a `list_gateways` call, the cheap half) runs
     EVERY tick unconditionally, refreshing the cached roster - this is what lets a
     single-gateway Domain that later gains a peer (friend onboarding, a second gateway
     enrolled) start exchanging with it on the very next tick with no restart needed, and is
     also what feeds the roster-vanish detection above. Only the EXPENSIVE half - the actual
     per-peer exchange calls - short-circuits to zero when the freshly-checked roster comes
     back empty. A single-gateway Domain's steady-state cost is one cheap roster lookup every
     10s and nothing else; the "zero evie calls" framing from lap 1/2 was too aggressive an
     optimization and is retired in favor of this.
   - **Evie-reconnect immediate revalidation** *(added lap 3 - the ticker pausing for the
     DURATION of an evie WS outage was fine and stays; leaving every peer's freshness
     untouched AFTER reconnect was not)*: `evieClient`'s `ws.on("open")` handler, in addition to
     resuming the normal 10s ticker, immediately fires ONE exchange attempt against every
     currently-tracked peer and marks each peer's freshness state as provisional (neither
     `fresh` nor its pre-outage value trusted) until that immediate round completes. This
     bounds "a peer that died during my own evie outage" detection to roughly the outage
     duration plus one round trip, instead of the outage duration plus up to two additional
     10s ticks silently showing stale-but-labeled-fresh rows.
   - **Console failover, simplified** *(lap 3 - the "ahead means withhold" version of this
     rule was found to conflict with presence's own monolithic send shape and to invert into a
     permanent staleness trap when epochs disagreed; deleted along with the hub's "ahead"
     branch, item 2)*: a console presents its knownVersions to whichever gateway it is
     currently polling; a newly-adopted route gateway applies the hub's now-single compare
     rule (item 2) - any difference ships current truth. A row the console had fresher via a
     since-lost prior gateway can briefly read as older from the new one; it self-corrects
     within one anti-entropy cycle (this item) once the new gateway's own next exchange catches
     it up and re-bumps. No promise of zero-regression on failover - a bounded, self-healing
     one instead, which is both simpler and actually deliverable under the wire shape ruling 2
     commits to.
   - **Mixed-version peers:** an old gateway rejects unknown FederatedOp kinds; the sender
     probes once per roster tick, marks it legacy, and its rows ride the old discovery-refresh
     path until it upgrades. Same-Domain gateways should upgrade together (release note);
     nothing breaks while they haven't.
   - Cross-Domain: BOTH new ops (presence exchange and intent relay) land in a default-DENY
     dispatch (allowlist of same-Domain op kinds) - a forgotten gate fails closed, unreachable
     by linked friends.
   - **Legacy-peer probe error handling** *(pinned lap 2)*: the probe distinguishes
     "unknown op kind" (a clean legacy signal - the peer understood the envelope and rejected
     the specific op) from a seal/transport failure (treated as `unreachable`, not `legacy` -
     a legacy gateway is never confused with a dead one). The anti-entropy exchange reply is
     schema-validated like every other relay frame (no informal-shape exception).

**Wire (TS schemas -> Kotlin codegen):**

7. Poll request: `focus` fields + `knownPresenceVersions` as an ARRAY of flat
   `{gateway, epoch, version}` objects (never a map - a map falls to codegen's untyped
   JsonObject). Poll response: `presence?` (TeamInfo list), `presenceVersions?` (same array
   shape), and a `settled?` reason tag. TeamInfo gains `working?` / `needsLogin?` /
   `presenceFresh?` (open decode-side values per codegen rules). **`presenceFresh?`'s write
   path and value domain, pinned** *(lap 3 found this field was declared but never wired)*: a
   tri-state string `"fresh" | "quiet" | "unreachable"`, present ONLY on a row whose owning
   source is a same-Domain PEER gateway (a row sourced from this gateway's own local sessions
   carries no federation freshness concept at all - the field is absent, not a fourth "local"
   value). The wire-assembly step that turns the internal merged snapshot into TeamInfo rows
   copies the peer freshness state machine's per-source output (item 6) onto every row from
   that source at assembly time - this is the concrete implementation the earlier draft left
   unstated, closing Q4's "stale-marked, never frozen online" requirement end to end from
   mergeApply through to the console's screen. **Absent-vs-empty semantics pinned:** an ABSENT
   knownPresenceVersions (old APK) = legacy client - the gateway sends NO planes and behaves
   exactly as today (opt-in, no churn); EMPTY array = new client cold boot = send everything.
   CONSOLE_PROTOCOL_VERSION bumps; golden fixtures + both manifests gain the new shapes;
   MailboxEntry untouched.

**Android (Kotlin):**

8. **One merge path.** A single plane-merge function owns: tombstone filtering (forgottenUntil
   applied inside it; tombstone EXPIRY re-applies the last cached plane content, so a failed or
   remote forget resurrects locally without waiting for a server bump), label-override pruning,
   absence streaks - everything withFreshTeams does today, with exactly one writer.
   **Pull-to-refresh, corrected** *(lap 2 found the original wording left the held poll running
   underneath it)*: clear knownVersions, CANCEL the in-flight held poll (the same
   focus-transition cancel path, item 5), THEN re-poll - without the cancel, a manual refresh
   against an already-open held connection would wait out the remainder of that poll's window
   before the version-cleared request even reaches the server, inheriting up to ~40s of the
   exact staleness this whole plan removes. Plane versions are NEVER persisted across app
   restarts (fresh process presents empty, full-resyncs - crash-between-merge-and-persist
   cannot strand stale content).
   **Cross-Domain rows (linked peers' sessions) - decoupled onto their own small timer**
   *(fixed lap 2 - "retained on the existing discovery-refresh path" quietly meant "retained on
   the path being deleted", since refreshLinkedPeers today is folded INTO refreshTeams
   (ChatRepository.kt:2563), the very call item 9 kills against a plane-capable gateway)*:
   `refreshLinkedPeers()` gets its own standalone periodic trigger (same ~30s cadence, its own
   timer, independent of both the presence-teams path and its capability gating) - clearly
   temporary scaffolding, replaced when phase 2 migrates linked-peers onto the registry as a
   real plane.
9. **Capability-gated legacy fallback (the flagged Q2 deviation):** the periodic teams() timer
   survives ONLY against a gateway that does not advertise planes (capability = plane fields /
   protocol version in the register reply or first poll). Against a plane-capable gateway the
   timer path is dead (test-asserted) - the ONLY thing item 9 kills is the OWN-Domain presence
   snapshot timer; cross-Domain peer refresh (item 8) is a distinct, undeleted timer, resolving
   the item-8/item-9 contradiction lap 2 flagged. Physically deleted in phase 2 once the fleet
   upgrades.
10. **Deleted in this migration** (against plane-capable gateways): forceTeamsRefresh (x3
    sites), the delay(400) spawn nudge + redundant refreshTeams calls, pokeWorking + the board
    poke LaunchedEffect, sessionWorking/sessionNeedsLogin as the BOARD's status source (the
    open terminal's own rendering peeks still drive its local frame, but tiles read TeamInfo).
    TerminalView declares terminal intent on open (rate from settings, user's = 0.5s), clears
    on close.
11. Idle ladder untouched (tier-down spec); plane settles are not comms activity.
12. **Instrumentation:** DebugLog `[Plane]` lines - server settle reason + bump timestamp in
    the response, client merge timestamp - the on-device measurement instrument for the
    sub-second acceptance criteria (and the debug-build ingest stream picks it up).
13. **Deploy - awaits the APK publish, per user direction (2026-07-17):** phase 1's deploy
    sequence gates on `main-push.yml`'s APK release workflow completing, then notifies the
    user their release is installable - they update mid-plan rather than the plan assuming a
    pre-updated fleet.

**Verify (phase 1):**
- **Class-kill lock (structural, not enumerated):** a property test fuzzes EVERY public facade
  mutator and asserts identity-hash-change <=> version-bump - a new mutator that escapes the
  funnel fails the property, not a hand-kept list. Plus the tripwire's own unit (escaped write
  -> loud log + self-bump), and the closed-world schema test (item 1).
- Hub: lost-wake lock-ordering test; coalescing window; settle-reason tagging; changed-planes-
  only responses; absent-vs-empty knownVersions semantics; waiter cleanup on disconnect/cancel;
  **the "ahead" case is exercised explicitly and asserted to send current truth, not withhold**
  (lap-3 correction - no regression test for a deleted branch is still a real gap).
- **Persistence and restart, rebuilt lap 3 (the highest-severity cluster this lap found):**
  clean shutdown (SIGTERM) with NO live sessions at exit produces zero bumps (the cheap path);
  clean shutdown WITH a live session at exit produces exactly one correct bump on next boot
  (the corrected invariant - NOT "zero bumps"); an uncaughtException / SIGKILL between two
  persist ticks, where real mutations were fanned out live to peers after the last tick, mints
  a fresh epoch on restart and every peer/console full-resyncs rather than freezing on a
  stale-but-plausible counter; a SessionStore-content loss with an otherwise-intact presence
  sidecar is IMPOSSIBLE to test in isolation post-fix because they are now one atomic file -
  assert the single-write-single-file property directly (one `sessionResumeDurable.save()`
  call covers both) rather than trying to reconstruct the old two-file desync.
- Presence: bump on every derived input flip incl. evictSocket, wake-failure
  (verifying->available lands like any other flip), daemon-disconnect / session-disconnect /
  peek-failure-streak each independently clear working to unknown and bump, sleep clears
  working/needsLogin in the same write as the status transition.
- **Federation - a TWO-GATEWAY vitest harness PLUS a THREE-GATEWAY harness (two gateway
  instances/three + stubbed evie relay, per routes.test.ts's existing stub pattern), rebuilt
  lap 3 with the interleavings actually found:**
  - Outbound coalescing: two rapid restarts of S, each queuing an independent-payload retry to
    the same destination under the OLD design, now assert only ONE payload (the latest) is
    ever in flight per destination, so a stale retry can never land after a fresher direct
    push already succeeded.
  - A peer's anti-entropy answer about a THIRD source never regresses that source's
    directly-tracked epoch; a gateway never installs its own sourceGateway from any inbound
    frame; mergeApply never fans out (type-level + behavioral).
  - **Roster-vanish reaches `unreachable`** within 2 ticks with NO failed exchange ever
    attempted (the peer is simply absent from a fresh roster fetch) - distinct from the
    exchange-times-out case.
  - **A single-gateway Domain gaining a peer post-boot** (friend onboarding, a second gateway
    enrolled after this gateway registered alone) starts exchanging with it within one tick,
    with zero restart of the observing gateway - was previously impossible under the "zero
    evie calls forever" cost floor.
  - **Evie WS bounce**: a peer that dies DURING this gateway's own evie outage is detected
    within outage-duration + one immediate round trip on reconnect, not outage-duration + two
    additional 10s ticks; every peer's freshness is provisional (not silently "fresh") for the
    span of an evie outage plus that first post-reconnect round.
  - Legacy peer degrades to discovery path (unknown-op-kind vs seal-failure distinguished);
    single-gateway Domain's steady-state cost is one roster-check call per tick, zero per-peer
    calls; cross-Domain denied by default for BOTH new op kinds; console failover self-heals
    within one anti-entropy cycle (not zero-regression - assert the BOUND, not impossibility).
  - `presenceFresh` reaches the wire: an `unreachable`-marked peer's rows carry
    `presenceFresh: "unreachable"` in an actual poll response, not just on the internal
    aggregate - closing the wire-vs-design gap lap 3 found.
- Working: regex cross-runtime vectors (manifest-wired); hysteresis defined over distinct
  frame hashes, not raw call count; container-logs frames ignored; non-peekable targets stay
  undefined; INTERACTIVE lane preempts DERIVE lane admission; captureNoResize used only by
  scheduler-fired peeks.
- Intent: TTL at 3 missed polls; zero-watcher floor still derives at 60s; focus-transition
  cancel-and-reissue lands in one RTT (hub disconnect path, not held-poll expiry).
- Kotlin: codegen drift, golden fixtures for every new shape, one-merge-path units (tombstone
  expiry resurrection, pull-to-refresh rehydrate), testDebugUnitTest.
- Mixed-version matrix: old APK + new gateway (legacy behavior, no churn); new APK + old
  gateway (fallback timer active); mixed-version peer gateways (legacy path).
- On-device: wake -> verifying->online sub-second measured via [Plane] logs; working flip <=4s
  board / <=1s terminal; wake FAILURE -> spinner clears to available; background tier-down;
  a live `docker compose down`/restart on a busy gateway produces exactly one visible,
  correct tile reconciliation, never a stuck stale row.
- Deploy = gateway rebuild + host daemon restart + APK release. The daemon change ships in the
  same repo the plugin loads from, but hostOpRunner/tmuxCore run daemon-side; verify whether
  the in-container MCP bundle is byte-affected at all - if it is, follow the full plugin
  version-bump + reload_plugins sequence rather than assuming "no plugin change".

## Phase 2 - after phase 1 green

- Physically delete the legacy fallback timer + the app's teams() writer (fleet upgraded).
- Linked-peers roster + cross-device unread (read-anchor) planes as one-call registrations on
  the registry (they inherit versioning, settle, tripwire, closed-world for free).
- TerminalView wakeRequested latch rework on the now-reliable online signal.
- Sweep-delete every remaining hand-rolled per-system sync path (refreshLinkedPeers folding,
  reconcile hacks, timer-shaped residue) - "the ones I didn't complain about (yet!)".
- Decide cross-Domain presence (linked peers' tiles) - currently discovery-refresh; phase-3
  shaped, needs its own questionaire pass if wanted.
- Docs: CLAUDE.md architecture section + plans/pain-points.md cross-links.

## Audit (plan-refinement lap 1)

12-dimension parallel audit (3 dimensions vetting against nyaadot's netcode: funnel rigor,
convergence, extension discipline), 72 agents, every finding adversarially triaged against the
code: 55 confirmed, 4 rejected. Clustered into 10 roots, all folded into the Plan above:

1. **[critical] Federation was push-only** - a lost presence_push froze stale truth
   cross-gateway forever (fanOutConsolePush enumerates the roster at fire time; evie's roster
   drops reconnecting peers; retries cap at ~5). -> Versioned exchange + anti-entropy tick +
   rejoin re-push + quiet/unreachable state machine (Plan 6).
2. **Version identity across restarts** - bare counters collide after a gateway restart
   ("version equal, content different"). -> (bootEpoch, counter) identity, mailbox-epoch
   precedent (Plan 1).
3. **Facade input undercount** - wake/create in-flight flips (index.ts closures), evictSocket,
   the catalog scan, and daemon-death working state all sat outside the enumerated facade. ->
   Input set derived from teams()'s actual read set; wake state moves into the facade;
   derivation-death semantics (Plan 3).
4. **Payload-neutral churn** - touchLive + lastActive would churn the version continuously or
   storm the hub, and made the tripwire false-firing or dead. -> Identity-hash gating with
   ambient fields excluded; dirty-mark + hash-decide (nyaadot MerkleHasher shape); coalescing
   window (Plan 1, 2).
5. **Client instant-empty misclassification** - a plane-settled empty-entries response looked
   like a broken old gateway and tripped 5s degradation backoff, defeating sub-second. ->
   Settle-reason tag + pinned absent-vs-empty knownVersions semantics (Plan 2, 7).
6. **The surviving teams() pull was a second unversioned writer** - stale content pinned behind
   a current version. -> Pull-to-refresh rehydrates through the plane path; teams() only on
   the legacy fallback (superseded ruling 3; Plan 8, 9).
7. **Registry was prose, not framework** - no one-call contract, presence-only self-heal, no
   closed-world enforcement, phase-2 re-scatter. -> registerPlane contract + closed-world
   test + uniform tripwire (Plan 1).
8. **Android merge edges** - forget-tombstone resurrection had no bump to ride; cross-Domain
   rows lost their only refresh cadence; half-deleted working caches could diverge. -> One
   merge path with tombstone-expiry re-apply; cross-Domain rows explicitly retained; board
   reads TeamInfo only (Plan 8, 10).
9. **Peek/scheduler mechanics** - resize-on-capture cost, no lane priority, container-logs
   false positives, no flip hysteresis, non-peekable loose peers inside "peek ALL". ->
   No-resize derive peeks, priority lanes, tmux-frames-only, 2-frame hysteresis,
   working=undefined scope-out (Plan 4).
10. **Mixed-version rollout** - old APK/new gateway churn, new APK/old gateway regression,
    legacy peer gateways hard-rejecting new ops. -> Opt-in absent semantics, capability-gated
    fallback (the flagged Q2 deviation), legacy-peer probe + discovery-path degradation
    (Plan 6, 7, 9).

Also folded: intent propagation on focus transition (cancel + re-issue the held poll - the
poll-request channel alone was up to 40s stale for intent), the hub lock-ordering lost-wake
race, structural loop prevention (localBump vs mergeApply split), roster caching +
single-gateway short-circuit, the property-based class-kill lock replacing the
enumeration-shaped one, [Plane] instrumentation as the acceptance instrument, and an explicit
deploy-time check of whether the daemon-side change byte-affects the in-container MCP bundle
(the "no plugin change" claim is now verified, not assumed).

**Deviations from recorded questionaire answers, flagged for the user:** (a) Q2's "teams timer
deleted in phase 1" became "capability-gated fallback, deleted in phase 2" (mixed-version
safety for guest Domains); (b) ruling 3's surviving teams() pull-to-refresh became
version-reset-and-repoll through the plane path. Both called out in the channel report.

**User ratified (post-report):** "we will update APK mid plan. So let us know when publish
workflow completes. then the next phase should remove legacy landmines."
- Deviation (a) accepted: the user updates their APK mid-plan; deploy step for phase 1 must
  AWAIT the main-push.yml APK publish workflow and NOTIFY the user when the release is ready
  to install.
- Phase 2's framing is explicitly "remove legacy landmines": the capability-gated fallback
  timer, the app's teams() writer, and every legacy-path residue get purged there.

## Audit (plan-refinement lap 2)

Targeted 8-dimension re-audit of the lap-1 rewrite itself (not a fresh sweep of the whole
plan), 42 agents. 31 confirmed findings (coverage note: 3 verify calls in the client-merge
dimension errored on a mid-run model rate limit rather than resolving true/false - their
findings were conservatively dropped rather than counted unverified; worth a small targeted
re-run of that one dimension if the user wants full coverage, not currently blocking). Every
surviving finding folded into the Plan above; clustered:

1. **[high] Federation merge rule was only sound within one epoch** - unknown-epoch
   full-replace let a late rejoin-reorder, a stale third-party anti-entropy answer, or a
   self-echo through a third gateway roll back or self-poison presence, re-expressing the
   exact class root 1 (lap 1) was supposed to kill. -> Source-direct epoch authority (a new
   epoch for S installs only from a frame authoritatively S's own), answers scoped to the
   answerer's own sub-plane only, a gateway never merge-applies its own sourceGateway (Plan 6).
2. **[high] The anti-entropy tick was a phantom constant** - no cadence number anywhere, and
   it was DEFINED as the intent-relay tick, so zero foreground consoles meant zero
   anti-entropy and zero peer-death detection - unbounded staleness, undoing lap 1's headline
   fix. -> Split into a gateway-lifecycle timer (10s, runs independent of console intent) vs a
   genuinely intent-gated ramp piggybacking the same wire call (Plan 6).
3. **[high] Registry/identity gaps** - `mergeApply`'s local hub-wake was unstated,
   `identityOf`'s scope (local-only vs merged) was unpinned, and the unreachable-peer
   stale-mark had no version space to live in without either forging the source's stream or
   never being delivered. -> `identityOf` explicitly scoped to the local merged view (so
   `mergeApply` wakes the local hub like any dirty write); stale-marking is a local freshness
   overlay bumped via `mergeApply`'s own path, never the source's version (Plan 1, 6).
4. **[high] Item 8 vs item 9 self-contradiction** - "cross-Domain rows retained on the
   existing discovery-refresh path" named the SAME refreshTeams()-folded call item 9's own
   test asserts dead against a plane-capable gateway. -> `refreshLinkedPeers` decoupled onto
   its own standalone timer, independent of both the presence path and its capability gate
   (Plan 8).
5. **[high] Pull-to-refresh omitted the held-poll cancel** - clearing knownVersions without
   cancelling the in-flight 40s-held poll first meant manual refresh could inherit up to 40s
   of the exact staleness being removed. -> Cancel via the same focus-transition path, then
   re-poll (Plan 8).
6. **[high] Hysteresis vs hash-unchanged frames was self-contradictory** - "2 consecutive
   frames" read either as 2 calls (a stuck pane satisfies it trivially forever) or 2 DISTINCT
   frames (consistent with "hash-unchanged = no new evidence" elsewhere in the same item). ->
   Pinned to distinct-frame-hash confirmations; a repeat hash carries no new evidence and
   neither extends nor satisfies the window (Plan 4).
7. **[high] Presence value for a sleeping/disconnected session was unpinned** - three distinct
   events (daemon-disconnect, one session's socket-disconnect/wake-failure, a going-asleep
   transition) all needed a stated working/needsLogin outcome or a stale last-known value
   could freeze inside the presence plane itself. -> All three pinned to clear-to-unknown,
   routed through the same facade setter, bumping like any other flip (Plan 3).
8. **[medium] Closed-world enforcement had no concrete mechanism** - zod fields carry no plane
   marker, so "a schema-side test" collapsed into the hand-kept enumeration the plan
   rejects. -> A `planeField()` schema helper that tags origin at definition time, checked by
   a field-set-diff test (Plan 1).
9. **[medium] Derivation locus silently drifted from the recorded Q3 answer** - Q3 has the
   DAEMON adjusting to serve declared intent; lap 1 moved regex + scheduling to the gateway,
   justified by an assumption (plugin-redeploy cost) that does not hold - the host daemon
   deploys via git-pull + `start-host-daemon.sh`, independent of the plugin marketplace
   sequence entirely. -> Reverted to the daemon (Plan 4), the deploy-cost justification
   corrected. **Flagged to the user below - this is the one lap-2 finding that changes
   direction rather than hardening the existing one.**
10. **[medium/low] Misc pinning** - epoch precedent cited backwards (DeviceMailbox PRESERVES
    epoch across a graceful restart; presence now does too, keyed off SessionStore's own
    persist tick, so routine deploys produce zero bumps) (Plan 1); domainMeta and the
    catalog's two mutation sites folded into the enumerated facade input set (Plan 3);
    `touchLive`'s call site stays - see Plan 1's own correction above, added when Phase 2's
    align-fan-out audit found the shipped code keeping it and traced the reason (TTL-sweep
    survival for a live record, unrelated to the identity-hash churn concern this bullet
    originally conflated it with); scheduler's three concurrency properties reconciled as one
    capture call
    with a resize parameter rather than competing streams, plus named INTERACTIVE/DERIVE lanes
    (Plan 4); intent TTL pinned at 3 missed polls, zero-watcher floor pinned at the existing
    60s background cadence (Plan 5); console failover given an explicit never-regress rule
    (Plan 6); legacy-peer probe distinguishes unknown-op-kind from seal-failure (Plan 6).

**Direction question for the user (per your standing instruction to reopen on big drift):**
item 9 above is a real, unflagged deviation from your recorded Q3 answer, and I've reverted it
back to match what you said (daemon derives + schedules) now that I've confirmed the reason I
moved it in lap 1 was wrong. If you'd rather keep it gateway-centralized for some reason I
haven't weighed (e.g. you want regex/scheduling changes to ship without touching the daemon
process at all, even though today that costs nothing extra to redeploy), say so and I'll flip
it back - otherwise this stands as corrected.

Given lap 2 concentrated real correctness bugs in the federation/epoch rewrite specifically
(the newest, least-baked part of the design), lap 3 will be a smaller, sharper pass aimed
just at that cluster rather than a full re-sweep - proceeding now.

## Audit (plan-refinement lap 3)

Sharp 6-dimension audit targeted ONLY at federation/epoch soundness - the cluster lap 2
concentrated its findings in - hunting a third race the first two laps missed, not a fresh
sweep. 17 agents, 10 confirmed findings, FIVE of them critical: two laps of hardening the
federation/epoch design still left reachable rollback-and-freeze bugs, all now fixed below.

1. **[critical] Persist-tick lag on the no-flush crash path.** SessionStore's 3s persist timer
   is decoupled from the real-time bump/fan-out path, and the `uncaughtException` handler
   deliberately does NOT flush (index.ts:182-189, "the last quiescent persist-timer/SIGTERM
   snapshot is consistent" - true for disk consistency, false for peer-consistency). A crash
   between two ticks restores a counter BEHIND what peers already installed live via real-time
   pushes; the same-epoch merge rule then silently drops every subsequent lower/equal update
   from the true source, forever. -> A `cleanShutdown` flag, false by default and set true
   only by the synchronous SIGTERM/SIGINT flush; any non-clean boot mints a fresh epoch
   unconditionally rather than trusting an unprovable counter lineage (Plan 1).
2. **[critical] Epoch-file/SessionStore-file desync.** The codebase's own established idiom is
   four independent sibling DurableStore files with zero cross-file coordination and
   swallowed per-file write failures (durable-store.ts) - unlike DeviceMailbox's own cited
   precedent, which bundles epoch and content into ONE atomic write. A separate presence
   sidecar file inherits the multi-file idiom's asymmetric-loss risk the precedent doesn't
   have. -> bootEpoch, counter, the identity hash, and `cleanShutdown` become extra fields on
   the SAME object `SessionStore.snapshot()` produces, written by the SAME atomic call - the
   two can no longer desync because they are no longer two files (Plan 1).
3. **[critical] "Zero bumps on restart" was provably false for the common case.** Ruling 2
   (never amended) hashes live-derived fields (status/mode/version, `resolveLiveIncarnation`-
   sourced) as part of presence identity - but no socket survives a process exit, graceful or
   not, so a restart with ANY session live at shutdown time unavoidably produces a real content
   change the old "identical hash, no bump" claim would have silently swallowed. -> The
   acceptance criterion is rebuilt: a clean restart with no live sessions stays free (genuinely
   unchanged hash); a clean restart WITH live sessions produces exactly ONE correct, funnel-
   routed bump, healed automatically as reconnections re-derive true status - "one honest tick
   per restart" replaces "zero bumps" as the actual invariant (Plan 1, Verify).
4. **[critical] Presence's atomic whole-list send cannot honor a per-source never-regress
   promise.** Ruling 2 (never amended) ships one monolithic list gated by one hash; item 6's
   lap-2 console-failover fix demanded PER-SOURCE non-regression - structurally incompatible
   under a single-blob wire shape, since answering one poll with "the whole current list"
   necessarily includes this gateway's own possibly-stale copy of a source the console had
   fresher via a different, now-lost gateway. -> The "ahead means withhold" branch is deleted
   from both the hub (item 2) and the failover rule (item 6): any version difference ships
   current truth, full stop; a console's momentarily-fresher cached row self-corrects within
   one anti-entropy cycle instead of being promised (falsely) never to regress at all.
5. **[critical] The anti-entropy ticker never re-arms after a peer joins post-boot.** The
   lap-2 cost-floor ("zero evie calls" for a single-gateway Domain) had no trigger to ever
   re-check `list_gateways` except the observing gateway's OWN restart - a Domain that starts
   with one gateway and later gains a second (the documented friend-onboarding / multi-gateway
   workflow) leaves the FIRST gateway's own outbound ticker permanently blind to the new peer,
   even while correctly receiving and merging that peer's inbound pushes. -> The cheap half
   (a `list_gateways` roster check) runs every 10s tick unconditionally; only the expensive
   half (per-peer exchange calls) still short-circuits to zero when the roster is empty - a
   newly-joined peer is discovered and exchanged with on the very next tick (Plan 6).

Also fixed at HIGH/MEDIUM, all folded into the Plan above: source-direct epoch authority had
no tie-break between two GENUINELY direct-from-S frames racing through independent retry
backoffs - closed by per-destination outbound coalescing (at most one in-flight presence_push
per destination) rather than inventing a second ordering primitive (Plan 6); the console
failover rule's version-only compare could invert into a permanent trap when epochs disagreed
- moot once the "ahead" branch above is deleted entirely; the anti-entropy ticker's binding to
evie's heartbeat lifecycle correctly pauses DURING an outage but left every peer's freshness
frozen at its stale pre-outage value AFTER reconnect - fixed with an immediate revalidation
round on evie `ws.on("open")` (Plan 6); `presenceFresh?` was declared on TeamInfo with no
stated write path from the freshness state machine - pinned as a tri-state string copied onto
each row at wire-assembly time, present only for peer-sourced rows (Plan 7); a peer that
silently vanishes from evie's roster entirely (not merely errors) had no path to ever reach
`unreachable` - folded into the same roster-check-every-tick mechanism as item 5 above, so
roster-absence counts as a failure observation too (Plan 6).

No further findings survived triage beyond these ten (out of the six dimensions run); the
"zero findings is a valid answer" instruction given to each auditor was not needed here - every
dimension that returned something found something real, which is itself the signal that this
cluster deserved the extra scrutiny rather than being declared solid after lap 2.

**Assessment:** three laps deep, the first two rounds hardened the federation design's
INTENDED behavior (what the merge/timer/facade rules were supposed to do); this round found
that the PERSISTENCE layer underneath them - how a restart, a crash, or a partial write
interacts with those rules - had never been audited on its own terms, and that is where all
five criticals lived. The fixes are now persistence-first: one atomic file, one clean/unclean
signal, one corrected "one honest bump" invariant, plus the two federation-specific gaps
(outbound coalescing, roster-check-every-tick) that only a THIRD pass, informed by the first
two rounds' own fixes, was positioned to find. This is reported to the user now rather than
looping to a lap 4 - the remaining Plan is not "the federation layer might still be unsound,"
it is "verify the fixes above compile and pass the rebuilt test list," which is implementation
work, not design work; further audit rounds on an unimplemented design face diminishing
returns against the concrete alternative of building it and letting the Verify section's own
new assertions (which now directly encode all five criticals as test cases) catch a
regression.

## Painpoints (Phase 2's read-anchors audited-implementation cycle)

Genuine friction from actually cycling this plan, not a code audit - recorded because it was felt,
not manufactured to fill the section.

- **A heavily-audited design document still drifted from what shipped, and nothing caught it until
  an independent align pass checked.** This file went through three full audit laps before Phase 1
  shipped - real scrutiny, not rubber-stamping. It still confidently asserted several things as
  done that were never built (the federation exchange, `planeField()`, the property-based
  class-kill-lock test) and one thing as "will be deleted" that turned out to be load-bearing
  (`touchLive`). Design-time audit laps check whether the DESIGN is sound; nothing in this plan's
  own process checked whether the SHIPPED CODE still matched the design months later. The
  `audited-implementation` cycle's own align-fan-out step is exactly that missing check, and it
  only ran because Phase 2 happened to route back through this same plan - a plan that shipped and
  was never revisited would have kept lying indefinitely.
- **I wrote the read-anchors feature AND its own 14-test suite this session, and still missed the
  obvious abuse cases** (an unbounded `epoch`, an unbounded `team` count) until a dedicated
  red-team pass looked at it adversarially. Feature-authoring instinct covers the happy path and
  the cases you were already thinking about (monotonic merge correctness, in this case) - it does
  not reliably cover "what if a hostile or buggy caller sends something absurd," even when you are
  being careful. This is the concrete case FOR always running red-team-fan-out as a genuinely
  separate pass, not a formality folded into the same sitting as implementation.
- **`consoleHandler.ts`'s poll case is three near-identical plane-piggyback blocks today, and the
  framework-first audit's own honest "not worth extracting yet" verdict is load-bearing on staying
  at exactly three.** Its reasoning explicitly depends on no fourth static plane being currently
  committed - if Phase 2 item 5's cross-Domain questionaire lands another named plane, or the
  federation exchange in `plans/cross-gateway-presence-exchange.md` ships as another static block
  rather than the dynamic per-source-gateway shape it is actually designed as, re-run that
  assessment rather than assuming "not worth it" still holds.
- Minor, recurring, not worth fixing anything over: biome's import-order/line-wrap formatting
  needed a `bun run lint:fix` pass after nearly every multi-file edit round in this cycle. Never
  once caught a real bug, pure friction. Also minor: a stray `cd android` earlier in the session
  left the shell's working directory changed for every later Bash call in that same session,
  which silently broke a `git add` with relative paths (a confusing "pathspec did not match"
  rather than an obviously-wrong-directory error) until traced back to `pwd`.
