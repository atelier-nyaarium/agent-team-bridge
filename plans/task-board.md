# Task Board

A global-ish task list for the owner's consoles, superseding Claude's own todo tools as the DEFAULT
without replacing them. Structure, screens and phases are all settled; see `# Plan` at the bottom.

## Settled model

Every entry lives on a **Gateway**. There is one board concept, not two.

| Tier | Role |
|------|------|
| Gateway | Holds every entry. Some assigned to a session, some not. |
| Console (phone) | Edits go over the wire through a retry queue. Holds a cache that pending edits merge over. |
| Session (agent) | No storage. Speaks over MCP to manage entries assigned to itself. |

- **Assigned vs unassigned** is the axis that matters. Unassigned entries are the triage pile and are
  still homed on a Gateway (normally the console's route Gateway, the first one it admitted).
- **Assign** sets the session link. **Unassign** clears it; the entry does not move.
- **Assigning a parent assigns its whole subtree.** No confirmation prompt; unassign is the undo.
- **The board is the UNION of both Gateways**, since each holds the entries assigned to its own
  sessions. The route Gateway's half arrives live on the plane; the other Gateway's half arrives by
  an explicit `board_read` on board-tab open and pull-refresh, since `poll` (the only plane carrier)
  takes no `targetGateway`. Accepted: the second machine's column is cadence-fresh, not live.
- **Assigning to a session on ANOTHER Gateway:** the console moves the entry itself, carrying the
  SAME entry id across. The write is the id-carrying upsert; the delete is `board_remove`, a true
  removal (relocation bookkeeping, not disposal - a trashed tombstone would let Restore fork the
  moved entry). The two are enqueued as a LINKED PAIR: the delete drains only after the write's
  acceptance. Non-atomic on purpose: write-then-delete, so a crash duplicates rather than loses,
  and the union view collapses the duplicate by id. No new federation op, since a console can
  already seal ops to any Gateway in its keyring.
- **States:** open, in progress, paused, done, cancelled.
- **Trash is a FLAG, not a place.** A trashed entry keeps its state, tree position and session link,
  is hidden, and is swept after 30 days. Restore unsets the flag and it reappears where it was.
- **Session ends:** an auto TTL sweep trashes done and cancelled and returns the rest to the pile; a
  manual forget trashes the same and BLOCKS on a prompt for the rest. Nothing is hard-deleted either
  way. Full table under Question 5.
- **A session sees the unassigned pile plus its own entries**, and may claim from the pile or create
  into it. Another session's work stays hidden as noise, not as a secret.
- **The board IS the agent's working list** (recheck 8). A breakdown nests as children under the
  owner's entry and ticks live, which is what makes the session list useful to watch. Claude's own
  todo tools go unused for anything board-tracked. **Agent writes must be COALESCED before the plane
  bumps**, since a plane re-hashes its whole snapshot per change and a fifteen-step breakdown would
  otherwise push fifteen full board rebuilds to the phone.
- **"Supersede" is capabilities guidance in the `designer` shape**, never interception.
- **The console never blocks on the network.** Every edit applies to the local cache first and a
  pending-actions queue drains behind it. There is no online mode and no offline mode, so an
  intermittent outage cannot interrupt an edit in progress.
- **Every action is absolute and single-field**, so replaying never compounds - and the client
  `opId` through the opCache is the OTHER half of the safety, stopping a stale replay from
  regressing a newer write. Neither alone suffices. Ranks are fractional, so a drag renumbers no
  neighbour.

## Questionaire

### Question 1 - How many Gateways?

Q: How many Gateways does the Domain run, now and intended?
A: **Two.**

> account scope is on the gateway? that's kinda scuffed isn't it? What if I turn off my computer?

Eliminated the cheap single-home option and forced the whole architecture open.

### Question 2 - One board, or two things?

Q: One global board, a per-Gateway board, or a split (global capture inbox + per-Gateway tracking)?
A: **Split**, then amended by the owner into something smaller:

> A. And to adjust something, forget phone to phone syncing of the unattached entries. if it's put on
> a session, then it gets sent to the daemon or whatever. Other phone can see it then.

This one sentence deleted the account-global store in every tier, an evie volume, the 1 MiB Secret
wall, the cross-Gateway state relay, device-to-device sync, and **the entire per-device content-key
cryptosystem** (symmetric crypto in a synced leaf, Kotlin twin, cross-platform vectors, rotation on
revoke, recovery wrap, silent-permanent-data-loss failure mode).

### Question 3 - What does attaching do?

Q: Move, link (stay in both), or move with multi-attach?
A: **Move.** Confirmed by the unlink behaviour the owner described:

> Unlinking via phone is just placing it back in my local board. Deleted for real from the gateway.
>
> "Deleting" from gateway puts it in the trash concept. Like done or canned ideas

**Unlink and delete are two different operations and must not share a code path.** Unlink is a
RELOCATION, so nothing is trashed. Delete is a DISPOSAL into trash. Collapsing them either trashes
things meant to be reclaimed or leaves phantom copies.

### Question 4 - Children when a parent is linked?

Q: Subtree moves, leaves-only, or trees may span the boundary?
A: **Subtree moves.** Under the later unification this reads as: assigning a parent assigns its whole
subtree. No confirmation prompt.

### Question 5 - A session ends. What happens to its tasks?

Q: Stay unassigned, unlink back to the phone, trash everything, or die with the session?
A: **Open tasks stay on the Gateway, shown unassigned.** Done and cancelled go with the session.

Amends the tier split: the Gateway holds some entries linked to nothing.

**Amended at recheck 6**, which separated the two ways a session can end. `sessionStore.sweep` at
`src/gateway/index.ts:363` fires on a 3-second tick and drops any record idle for
`SESSION_RESUME_TTL_MS`, with nobody deciding anything.

> manual: gate
> auto: trash bin dones, pile undones

| Event | Done and cancelled | Open, in progress, paused |
|-------|--------------------|---------------------------|
| Auto sweep (30 days idle) | TRASHED, trash clock starts | Back to the pile |
| Manual forget | TRASHED, trash clock starts | BLOCKING prompt, see below |

Trashing rather than deleting is what keeps the principle intact: **nothing that nobody decided is
allowed to destroy anything.** An auto sweep still leaves 30 recoverable days.

**The manual-forget prompt BLOCKS** (recheck 7). It names the undone count and the owner must pick
cancel-them or unassign-them; the forget does not complete until they do. Rejected a toast with an
action button:

> not a toast button. that's so easy to double tap into.

Skipped entirely when the session has no undone tasks, so the prompt always means something was
actually at stake.

### Question 6 - How does trash work?

Q: A flag, a container, or a sixth state?
A: **A flag.** Rejected as a sixth state, because that would make "done" and "trashed" mutually
exclusive and erase the record of what was actually finished.

### Question 7 - Unify the local notes and the Gateway board?

> Would you unify the local notes and gateway? As in You can only create task boards onto a gateway?
> No semmetry if it doesn't exist twice

A: **Yes.** Question 5 had already put unassigned entries on the Gateway, so the inbox is just the
unassigned view of a Gateway board. The local board stops existing, unlink becomes unassign, and
trash is one flag with one sweep instead of two of each.

Deliberate reversal, confirmed: unassigned entries now live on a Gateway, so a second console DOES
see unsorted thoughts. Q2's adjustment had ruled that out; it returns via the Gateway rather than
device-to-device, so none of the deleted sync machinery comes back.

### Question 8 - Assigning across two Gateways

Q: Console moves it, cross-Gateway session link, or pick the Gateway at capture time?
A: **Console moves it.** Rejected the cross-Gateway link: the holding Gateway cannot see or validate
that session, so nothing server-side can enforce or clean it up, which is how rows end up pointing at
sessions that stopped existing.

Amended at recheck 3, once the write queue made this the only compound action left: the entry keeps
the SAME id on both Gateways. Rejected the alternative of never letting entries cross, which would
have removed compounds entirely but punished the owner for which machine happened to be up when a
thought arrived.

### Question 9 - Agent authority

Q: Narrow (own assigned entries only), read-wide/write-narrow, or full?
A: **Narrow.**

**Amended at recheck 4.** The security argument was mine and the owner rejected the premise:

> That's not even security I'm worried about. You could literally rm my root directory if you wanted.
> Let's allow the mcp tool to claim an unassigned.

Settled scope: a session READS the unassigned pile plus its own entries, and WRITES its own plus a
claim from the pile. Another session's entries stay hidden because they are noise in a context
window, NOT because they are secret. Do not re-derive the hidden part from a security rationale.

**Tool family, camelCase after `codexStartAgent`** (the codebase is split: `crosstalk_send` and
`designer_push_card` are snake). Named `board` rather than `task` so it names the surface and does
not read as though it belonged to Claude's own task tools:

| Tool | Does |
|------|------|
| `taskBoardList` | The backlog and this session's entries, as a tree |
| `taskBoardClaim` | Take an unassigned entry and its subtree for this session |
| `taskBoardRelease` | Return one to the backlog, keeping state, body and tree position |
| `taskBoardCreate` | Add an entry |
| `taskBoardUpdate` | Set title, body, state, or parent and rank, on its own entries |
| `taskBoardClear` | Trash this session's done and cancelled entries |

**Descriptions stay one or two lines; every parameter carries its own.** The two facts that must
survive into the tool text itself, since it is the only place an agent reads them: a claim refuses
when another session holds the entry (so a lost-reply repeat is safe), and `taskBoardCreate`'s
`assignTo` has NO default on purpose, because whichever way it pointed is where nearly everything
would land.

`assignTo` is `"self" | "backlog"`, NOT a boolean. It was named `for` and the owner had to ask what
it did, which is what renamed it. A boolean would reintroduce the default through the back door,
since an omitted flag reads as false.

**Every `parent` parameter says there is no depth limit and asks for four or under.** Unenforced on
purpose: a refusal at depth five would fail a write the owner never sees a reason for.

### Capability text

Written to the /coding rules: it describes what IS, so nothing about what a session cannot see.

> The owner's Task Board is shared with you and live on their phone. Prefer it over Claude's built-in
> task tools for anything worth surviving the turn; those stay useful for scratch steps inside one.
>
> Claim a backlog entry before working it. Create your own with `assignTo: "self"`.
>
> Break work down as children of the entry it belongs to, and tick them as you go. That tree is the
> only progress the owner can see.
>
> A follow-up you will not do goes to the backlog with `assignTo: "backlog"`, or it dies with the
> session.

`taskBoardList` takes an optional `scope`: `unclaimed` for the backlog alone, `session` for this
session's alone, `all` for both. Never another session's, at any scope.

**A claim succeeds when the entry is unassigned OR already this session's, and refuses when another
session holds it.** That is what keeps a lost-reply retry a no-op rather than a theft.

A session may also create INTO the backlog (recheck 5), so a follow-up it notices mid-task outlives
it. Rejected a separate `boardStash`: one tool with no default keeps both directions equally visible,
where a default would bias every call toward itself.

### Question 10 - Does "the phone stores nothing durable" cover reading?

Q: Read-through cache, or a pure client that shows a blank board when no Gateway answers?
A: **Read-through cache**, drawn with a stale marker.

Originally recorded as "read-only, never a write source, so nothing merges" - SUPERSEDED by Q11's
local-first writes, which make the cache a merge base (see Android constraints). A whole-snapshot
replace over an optimistic edit would visibly revert every edit for one poll cycle.

The pure-client reading would have made the board the only screen in the app that goes blank offline.
`AppStateStore` already persists the transcript, drafts, labels, read anchors and design cards.

### Question 11 - Offline writes, and what a refused action looks like

Q: Queue writes locally, and what does the console show when one is finally refused?
A: **Queue them. A refused action snaps the row to Gateway truth and flags it**, dismissable.

> actually I want simple write, but nothing fancy like an outbox indexed journal. your outbox term
> made it seem like a core flashy feature. So a very basic updates action array?
>
> Actions and edits simply retries until it succeeds. Currently we have intermittent outages where
> the console doesn't see the gateway sometimes. and it would get annoying if it kicked me out of
> typing while I WAS online.

Reverses the earlier no-offline-capture ruling. The queue is a plain array in the same JSON blob,
drained in order PER TARGET GATEWAY, retried until accepted. `ScheduledSend` is the precedent for
the BANKING SHAPE ONLY (local record + opId + mutex); its lifecycle and alarm-driven retry do NOT
transfer - see the Android constraints, its retry is a bounded one-shot.

Per-gateway drain order matters because the second machine being off is the NORMAL case: a global
in-order drain would head-of-line block every write to the live Gateway behind one action targeting
the dead one, silently, for days. Per-gateway order is safe because an entry lives on one Gateway
at a time - except the MOVE, the single cross-gateway compound, whose two halves are enqueued as a
LINKED PAIR: the delete-from-origin is not eligible to drain until the write-to-target's acceptance
is recorded. Without that link, per-gateway drain lets the delete land while the write is held, and
the entry exists on NO gateway - the exact loss write-then-delete was chosen to prevent.

**The four rules that keep it from desyncing**, which is what the owner asked for:

1. Every action is ABSOLUTE, never relative. Set state to paused, set parent to X at rank R. No
   toggles, no move-up-one. Replaying restates one intent instead of compounding.
2. ONE FIELD per action. A drag writes rank, an agent writes state, so they cannot collide.
3. Ranks are FRACTIONAL, so a drop mints a value between its neighbours and renumbers nobody.
4. A client-minted opId, so an action that landed but lost its reply replays rather than doubles.

Refusal is therefore the only failure left: entry gone, parent gone or the move loops, session gone.

**A refused EDIT additionally restores its text to the composer**, which reopens. At most one board
draft at a time.

> may want to restore the draft to it's edit box and bring the composer up again. that said, only
> allow 1 task list draft at a time. should generally be rapid

`mergeTakenBackDraft` already implements the collision rule and is tested: text lands ONLY on a blank
draft, whitespace counts as blank, what is already typed wins. Consequence to keep in mind: a refusal
arriving while the composer is occupied DROPS the refused text.

### Rejected, with the reason, so it is not relitigated

- **evie as store of record.** Content-blind by deliberate commitment; scoped by Domain rather than
  owner (an owner-global key does not exist there and would have to be invented); its one durable
  object holds evie's private keys and every Domain's trust root, so a task write would be a CAS
  against federation itself. Its committed manifests define no PersistentVolume, no StatefulSet and
  no database, only Secrets.
- **A volume on evie** ($1/month, 10 GiB minimum, `linode-block-storage-retain`). Viable and cheap,
  and it would have removed the blast-radius objection. Made moot by Q2's adjustment. Note if ever
  revisited: Linode block storage is ReadWriteOnce, so `RollingUpdate` deadlocks and the strategy
  must become `Recreate`; evie's Deployment is NOT in version control; the cluster is a single node.
- **The phone as store of record.** Nothing in the system can ask a phone a question (no socket, no
  push channel), so "the phone owns the board" can only mean "the phone publishes replicas some other
  tier serves", which is the Gateway option plus a device-merge problem.
- ~~**A console-side outbox for offline capture.**~~ REVERSED by the owner at recheck 2. What was
  rejected was the word: "your outbox term made it seem like a core flashy feature." A plain retry
  queue is in. See Question 11.
- **Daemon-managed storage.** The host daemon has no durable storage. `src/main-host-daemon.ts` is 30
  lines and imports nothing that persists; neither it nor `hostDaemon.ts` touches `DurableStore`,
  `openDurable` or `DATA_DIR`.

## Binding technical constraints

Found during research and still load-bearing. Violating any of these has a known cost.

### Wire and codegen

- **NEVER a `z.record` / generic map on the wire.** `codegen-kotlin.ts` emits it as untyped
  `JsonObject`. Flatten to an array with the key as a field (`ReadAnchorWireEntrySchema` is the
  precedent).
- **NEVER a decode-side `z.discriminatedUnion`.** The emitter silently emits NOTHING for it while
  still referencing it by name, producing Kotlin that references an undeclared class. Use a flat
  optional `z.enum` tag plus flat optional per-variant fields (`ConsolePeekResultSchema.kind`).
- Every nested object needs `.meta({id})`. An inline anonymous object throws (loudly; CI catches it).
- **BoardEntry is FLAT: a `parent` pointer, never a `children` array.** (Audit, reproduced against
  the repo's zod.) A recursive schema used as a codegen ROOT emits `$ref: "#"` with no `$defs` and
  `codegen-kotlin.ts:224` throws `unresolved $ref`; recursive-as-root-AND-nested throws a misleading
  `.meta id collision`. Recursion works ONLY nested under a non-recursive wrapper root, and nothing
  recursive has ever shipped (0 of 147 generated classes). Flat parent-pointer needs none of it; the
  console rebuilds the tree.
- **The no-explicit-null constraint is SCOPED, not general.** (Audit corrected the earlier blanket
  reading.) A MULTI-FIELD patch cannot distinguish clear-from-omit, but an absolute single-intent op
  has no "leave unchanged" reading, so on `board_set_parent {id, rank, parent?}` an ABSENT parent
  means root - no sentinel, no full-replace. Pin that in the schema's doc comment; nothing enforces
  it, and a third field on that op would silently reintroduce the ambiguity. MCP tool inputs never
  pass through the Kotlin codegen at all, so `taskBoardUpdate` may use `.nullable().optional()`
  (absent = don't touch, explicit null = clear) - the constraint is a console/Kotlin fact only.
- Epoch-ms fields are `z.number().int()` (emits Long) - a bare `z.number()` emits Double and decodes
  without throwing. Give the `trashedAt` fixture a value above 2^31 as Long bait, the way
  `mailbox-reply-files-modified.json` does.
- `rank` gets an explicit `.max()` (every other console-facing string is bounded) and the rank module
  REBALANCES the sibling range when a mint would exceed it - fractional keys grow one char per
  same-gap insert, forever, and the failure lands at the 8 MB frame, not at the schema.
- `BoardEntrySchema` keeps flat literal fields in fixed order, no spread: `Object.entries` order IS
  the Kotlin constructor order (`MailboxEntrySchema` documents this). The `state` enum arrives in
  Kotlin as an open `String`, so every `when` needs an else.
- **`ci.yml` never compiles Kotlin.** It builds only in `main-push.yml`, AFTER merge. Run
  `cd android && ./gradlew :app:testDebugUnitTest` locally as the real gate.
- **A new wire shape is a FIVE-step ritual, not two** (audit): the fixture json in
  `tests/fixtures/protocol/`, its `_manifest.json` entry, the `SCHEMAS` map entry in
  `src/__tests__/protocol-fixtures.test.ts`, the `decodeAs` branch in `ProtocolFixturesTest.kt`, and
  reachability from the codegen ROOTS so that branch has a class to name. The Kotlin branch is the
  one CI never checks pre-merge. Mirror the read-anchors fixture PAIR (op envelope + poll result).

### Gateway

- A plane ships its **entire snapshot** on every bump; no intra-plane delta exists anywhere. The
  audit's cost verdict: the hash is cheap, the BUMP is not - each one settles the held poll, ships
  the whole board sealed, and triggers a whole-blob prefs rewrite on the phone. So coalescing is a
  REGISTRY primitive (`markDirtyCoalesced(name, windowMs)`, flushed by the tripwire), never a
  call-site debounce - one forgotten call site is the bug class the registry exists to rule out.
- **The plane rides ONLY the route Gateway's poll** - `poll` is the one console op with NO
  `targetGateway` (`ConsoleClient.kt:715`), so the "union of both Gateways" CANNOT be assembled from
  planes alone. (Audit blocker; the write half is fine, `targetGateway` exists on mutating ops.)
  Decision: the route Gateway's board rides its plane; a NON-route Gateway's entries are fetched by
  an explicit `board_read` op with `targetGateway`, issued when the board tab opens and on
  pull-refresh, merged console-side by entry id. Accepted consequence: the second machine's column
  updates on that cadence, not live. This also restores the crash-duplicate argument for the
  cross-Gateway move, which was unsound without the union read.
- Sealed poll reply is hard-capped at `MAX_RELAY_FRAME_BYTES = 8_000_000`, and an oversized reply
  fails the WHOLE poll - mail, presence, everything, deterministically, with no eviction path (the
  precedent plane's cap is entry-count over 3-integer rows; a board entry carries a body). So: cap
  `body` in the schema, budget the projection in BYTES where it is built, and DEGRADE (truncated set
  + `truncated` flag) rather than fail.
- `src/gateway/readAnchors.ts` is the template for the PLANE only (lazy `ensureRegistered`, flat
  wire projection, per-owner cap). It is the WRONG template for persistence: its own doc justifies
  tick-cadence durability by the data being low-stakes. Board writes persist synchronously through a
  checked write (the `commitCodexCatalog` model) into their OWN `DurableStore` file, so the write
  cost is proportional to the board and a poisoned file quarantines alone.
- **The projection sorts by entry id** (unique by construction), never by rank: rank ties leave
  order to Map insertion, which differs between a live process and a JSON-restored one, and the
  spurious hash change reships the whole board. Unit-test: same board, two insertion orders, one
  `stableHash`.
- **Revision CAS is INTERNAL-ONLY.** `commitCodexCatalog`'s client-presented `expectedRevision` does
  not transfer: absolute single-field ops commute by design, and a client-held revision under a
  retry queue livelocks (a queued action holding a stale revision never lands). The store serializes
  writers with its own read-modify-CAS loop; `revision_conflict` never reaches a client.
- **"Absolute" does not mean "safe to skip the dedup cache."** (Audit corrected this; `report_read`
  skips it because it is MONOTONIC - the anchor only advances.) A board op replayed after a newer
  write REGRESSES the field: console sets paused, reply lost, agent sets done, console retry reverts
  it to paused. Board console ops join `isMutatingOp` so the opCache replays the cached reply, and
  the MCP route gets its own per-operation-id record.
- **`taskBoardCreate` is NOT idempotent and is the one op that most needs the opId** (it is how a
  fifteen-step breakdown avoids duplicate entries on a lost reply, and `routerPost` retries 4x by
  default). Derive the entry id FROM the operation id, the way `codexAgentIdForOperation` derives
  the agent id - the replay becomes structural rather than a cache lookup.
- **HAZARD, INVERTED from the earlier reading** (audit, verified on disk): `9) Purge Gateway` wipes
  `volumes/gateway`, which is the LOG volume (`debug.log` only). Every store - board included, plus
  federation identity, mailboxes, blobs - lives in `volumes/gateway-data` and SURVIVES. So purge
  does not take the backlog; it strands it under the old owner key, while telling the owner it
  wiped. `FED_DIR_HOST` points into the log volume too, so `clearTransport()` is a no-op and
  `installState()` can never report installed. Fix `wipeState()`'s target FIRST; only then is a
  board-count guard between `dc("down")` and `wipeState()` worth anything. Same check applies to
  `purgeFederation()`, which shares `wipeState()`.
- **The auto-sweep hook needs `sweep` to return the removed team keys** - today it returns a bare
  boolean (`session-store.ts:541`), so the hook cannot know WHICH sessions ended. Do NOT hang the
  hook on `SessionStore.forget`: failed-wake and failed-create rollbacks call it for sessions that
  never started, and the hook would trash entries for a launch that never happened. Call it from the
  persist tick over the returned keys (own try/catch - an uncaught throw there exits the gateway)
  and from the console `forget` case beside `dropSessionResume`.
- **That 30-day sweep and the 30-day trash window are the same number for unrelated reasons.** They
  must NOT share a constant.
- `blob_fetch` is NOT an exact precedent for anything mutable. Its safety rests on three properties a
  board lacks: content-addressed by digest (a wrong request returns nothing, never wrong bytes),
  immutable and read-only, and cache-lifetime (anything evicted is re-fetchable). Reusing it
  transfers plumbing, not safety.

### MCP and capabilities

- **`SWITCHBOARD_SESSION_TOKEN` arrives ONLY through the daemon's launch command**, and a reattach
  discards that command, so a reattached session presents nothing - that diagnosis stands. The
  prescription changed (audit blocker, twice over): `mayUseLocalPlane` 403s a tokenless caller the
  moment ANY session on the gateway holds an active binding (a shipped test pins exactly this), and
  it is deliberately SUBJECT-less, so it can never answer "which session is calling" - which claim,
  release, update, clear and `scope: "session"` all require. **The board gate is the name-keyed
  `refuseImpersonation(req, from)` posture `/plugin-action` takes**: the MCP helper hardcodes
  `from: PROJECT_NAME` so a tool cannot smuggle an identity, `toClaim` is inert-aware so a reattached
  session passes, and a bound name still demands its token. Stated residual, decided rather than
  implied: an UNBOUND name is open by construction, so scoping holds against accident and against
  bound sessions, not against a determined local caller - the same accepted same-uid residual
  CLAUDE.md already records.
- **Adding the capability is 5 edits and THREE test gates, and NOTHING in `src/shared/capabilities.ts`**
  (audit corrected the earlier recipe; that file only carries the daemon-declared id). The edits:
  `"taskboard"` in `GATED_CAPABILITY_IDS` (`src/mcp/capabilities.ts`), the gate in `src/mcp/index.ts`
  beside `designer`, `assets/plugins/taskboard/manifest.json` with `content_id: "taskboard"` and the
  capability text as `agent_instructions`, a `PluginCatalog.Entry("taskboard", ...)` (`PluginEntry`
  is a fun interface, a no-op lambda is fine for a declaration-only plugin), and the tools module.
  Gates: the manifest-directory fixture test, the `EnabledPluginSchema` sweep, and
  `PluginCatalogAgreementTest` - the LAST one is Kotlin-only and post-merge, and it guards the
  highest-probability mistake: a manifest without a catalog entry is never loaded, never reported,
  and the tools silently never appear on any tier.
- The console must SHIP the plugin; enable is now the default (all plugins default on). The gate
  then survives 14 days of console silence via the durable `CapabilityStore` plus the MCP's own
  cache carry-forward, and fails closed after that.
- **The declaration only reaches the ROUTE Gateway today** (audit lap 2): `register` carries
  `enabledPlugins`, takes no `targetGateway`, and no cross-gateway capability mirror exists - so
  machine-B sessions would NEVER see the board tools, permanently, not as a rollout window. This
  gap already silently applies to `designer` and `references` on machine B. Decision: the console
  sends its plugin report to EVERY admitted Gateway in its keyring (a capability-report send per
  gateway on the register cadence), which fixes all three capabilities at once. Recorded as a
  Phase 2 item; the alternative (accepting machine-B sessions have no board) would gut "the board
  IS the agent's working list" on half the fleet. Owner confirmed, noting the existing gap rarely
  bit because a person toggles their plugins consistently across devices.
- **Decide the enable seam explicitly**: `PluginManager.isActive` has ZERO callers today, so nothing
  gates a core surface on a plugin. Either the tab, strip and session-card rung check
  `isActive("taskboard")` (its first caller), or the console UI is unconditional and only the agent
  surface is gated. Unstated, the two halves diverge on different triggers: toggling the plugin off
  drops the tools at next session start while the phone keeps drawing an editable board no agent
  sees. Decision: gate the UI on `isActive` - the toggle should mean one thing.
- **A running session never changes its tool set.** The owner must restart a session to adopt it.
- Guidance goes through `switchboard_capabilities`, never the always-on block (length-capped, and it
  silently truncates).
- **Deploy order is fixed:** gateway first, then the plugin version bump. Every new field must be
  optional at the gateway and tolerated by an older console, or a required field opens a fleet-wide
  400 window.
- `src/mcp/codex/codexTools.ts` is the worked example for a capability-gated tool set on one
  authenticated route, including minting a private per-invocation operation id so an HTTP retry is a
  replay rather than a second mutation.
- **Superseding Claude Todo needs no interception.** Its four task tools are per-session, stored at
  `~/.claude/tasks/<id>/<n>.json`. MCP tools are namespaced `mcp__<server>__` so a name collision
  cannot occur. The board is ADDITIVE plus one guidance line, exactly as the `designer` capability
  already reads. (`env.CLAUDE_CODE_ENABLE_TASKS=false` in settings.json would disable them, but that
  is the owner's choice to make, and "supersede does not mean kill".)

### Android console

- **No database at all.** No Room, no SQLite, no DataStore. Every collection is one JSON blob in one
  `EncryptedSharedPreferences` key, rewritten WHOLE on every mutation - and `apply()` rewrites the
  whole FILE, which also holds the uncapped transcript. So the board persist is debounced, skipped
  when the decoded snapshot equals what is stored, and the cache + queue share ONE key so an
  optimistic edit and its queue append are one atomic apply (`saveThreadsAndReadAnchors` is the
  reasoning precedent).
- **The cache is a MERGE BASE, not read-only** (audit blocker; supersedes Q10's wording). A whole-
  snapshot replace erases the optimistic edit Q11 requires, so every edit visibly reverts within one
  5s poll and flips back when the queue drains. The shipped fix for exactly this is
  `withFreshTeams`: the snapshot is authoritative EXCEPT for fields covered by a still-pending
  action, re-applied until acknowledged or refused. Pure function, unit-tested.
- **The queue's lifecycle is NOT ScheduledSend's** (audit blocker). ScheduledSend is a bounded
  one-shot - one retry after 5 minutes, and `clearScheduledSendRecord` destroys the durable record
  BEFORE delivery. Only its banking shape (local record + opId + mutex) transfers. The board queue
  retires an entry ONLY on gateway acceptance or explicit refusal, and drains on the existing poll
  loop, not on alarms (Doze rate-limits `setExactAndAllowWhileIdle` to ~1/9min anyway). Honest
  latency: backgrounded, the idle-pushback ladder means a queued action can wait for an hourly wake.
- **Duplicate `LazyColumn` keys crash the app, and the plan itself manufactures duplicates twice**
  (audit): the cross-Gateway move puts the same id on two Gateways as NORMAL operation, and the two
  fold rules overlap (a childless done top-level entry satisfies both). Both resolve in ONE pure
  `flattenBoard(entries) -> List<BoardRow>`: collapse-by-id first, then both folds in a single pass
  with explicit precedence (branch-fold wins; bottom-gather takes only done entries whose parent is
  not itself done), keyed by entry id alone, with a unit test asserting id uniqueness over generated
  trees. The collapse is a RENDERING PRECONDITION, not an eventual-consistency nicety. (The
  "already guarded elsewhere" comfort was false: the guard is one `distinctBy` on one list, and
  `renderProject("host")` has an unguarded double-render path today - flagged for cleanup.)
- **Register the board keys in BOTH wipe lists** (`SCHEMA_WIPE_KEYS`, `PROVISIONING_KEYS` in
  `AppStateStore.kt`): their pinning tests are subset asserts, so a missed key passes silently and
  the board would survive a Clear - the privacy regression the list doc warns about by name.
- The SessionsScreen lift is SMALLER than first scoped (audit): the dialogs are window-level and
  already sit above the Scaffold, `snackbarHostState` is already hoisted. Real work: drop the
  Scaffold wrapper, move four top-bar params, and fix ONE state loss - `collapsedGateways` is a
  plain `remember`, and a pager disposes the non-current page, so it becomes `rememberSaveable`
  (store a Set of collapsed ids; a Map needs a Saver).
- The entry edit screen joins App's hand-rolled navigation in THREE places: the ordered `when`
  (`MainActivity.kt:564-861`), BOTH halves of the `BackHandler`, and the notification-tap
  `LaunchedEffect`'s clear list - missing the third reopens the recorded masked-thread bug. Back on
  the board tab with no overlay exits the app (Android convention); decided, not inherited.
- The in-thread strip: `ReorderableTabRow` already renders directly under the bar when more than one
  tab is open, so the strip sits ABOVE the tab row and the pulse-as-bottom-edge reads correctly only
  in the single-tab case. Expanded height is capped (~35% of content, internal scroll) - the folds
  bound done work, not open work, so a twelve-open-children entry must not bury the transcript.
- **`SessionCard` (`MainActivity.kt:2050`) is the visual language to reuse**: M3 `Card`, monospace
  `titleMedium` name, outlined `StatusChip`s, `PulseBar` when busy, snippet line with relative time,
  muted title colour when asleep or ended, 16.dp indent when nested.
- The plugin framework has NO extension point for a top-level screen. The board UI is core app
  surface. The agent-interaction half could still reuse `pluginActions`.
- **The y-axis drag is a NEW pure module, not a port of `TabDragMath`** (audit): the x-axis math
  needs a complete slot list, which a LazyColumn cannot supply (offscreen rows are disposed); the
  scroll term needs absolute pixels, which `LazyListState` does not expose for variable-height rows;
  and the commit is `(parentId, rank-between-SIBLINGS)`, not a flat index - the visible neighbour
  above a drop may be a folded branch at another depth. Compute from the flattened row model plus
  `layoutInfo.visibleItemsInfo`; only the gap-opening shift transfers. Budget it as its own slice.
- **The board draft is its own type** (`BoardDraft(entryId, title, body)`), not a reuse of `Draft`:
  two deferred fields to `Draft`'s one, no files, and the `drafts` map's loader hard-filters keys
  through `isAddressKey`, so a `board:` key would persist and then silently vanish on restart.
  `DraftTakeBackTest` is the model to copy, not the code.

## Related: the no-ack channel push

Agreed in principle, and the board is its first consumer. Not part of the board's own scope.

- An optional `no_ack` field on `ChannelPushPayload`, branching the `instructions` attribute in
  `src/mcp/channel/channelNotify.ts` to "awareness only, no reply, no turn".
- **The harness meta-key regex is `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and a non-matching key is SILENTLY
  DROPPED.** So `no_ack`, never `no-ack`.
- ANY push starts a turn. "No-ack" can only ever be a CONVENTION in `meta.instructions`, enforced by
  nothing.
- `src/gateway/vibeCheck.ts` is the working precedent for an unprompted gateway-authored push, and it
  already solves idle/busy detection by peeking the pane (`src/shared/agent-screen.ts`). The board
  push wants the opposite polarity: ride a running turn, bank when idle.
- A normal push creates a persistent job entry and counts toward the vibe check. Both are wrong for a
  no-ack push, so it needs its own interceptor in `respond()` beside the handshake and vibe-check ones.

## Landed already

- `src/shared/blob-store.ts` carries a two-line TODO to re-home the blob store off per-machine
  storage. Same disease as the board had: a blob lives on whichever Gateway received it, so one held
  by a switched-off machine is unreachable. Lint passes.
- **`DEFAULT_ON_IDS` is gone; every baked-in plugin is on by default.** The toggle exists to switch a
  feature OFF, never to opt into one, so an exception list was micro-management. An explicit off
  still wins, because the stored value outranks the default. Dropped the now-dead `SANDBOX_PLUGINS`
  loop with it. Kotlin gate run: `:app:testDebugUnitTest` passes.
- The designer plugin's `agent_instructions` now teach card authoring (whole document, `<title>`
  names it, viewport meta must match the declared width).

## Screens

Three surfaces, three jobs, settled at recheck 9. Drawn as design cards in the console dock.

**Sessions tab** (`sessions-list.html`). `SessionCard` unchanged in height. Its preview line already
runs a ladder, description over last message; the current task becomes the new TOP rung, with its
state icon and a `2/6` count. The relative time drops off a card showing live work, since a task
title answers "is anything happening" better than a timestamp.

**The icon carries STATE, not merely the presence of a task.** Paused work on an idle session would
otherwise render identically to an idle session with nothing to do.

**Task Board tab** (`task-board-tab.html`, v4). Capture field at the top, then the unassigned pile,
then one card per session holding its tree.

- **Tall cards are solved by folding what is finished**, not by capping the list. TWO folds, and they
  are separate rules: a finished BRANCH (parent and every descendant done) collapses onto its parent
  row carrying a count, keeping it in tree order; loose finished entries gather into one row at the
  bottom. **One open descendant anywhere keeps its whole branch open**, so neither fold can hide
  unfinished work. Height therefore tracks work REMAINING rather than work ever done.
- **Assign is a long press**, not a drag onto a session card. Drag stays for reordering within a
  list, where the target is on screen; a session you want may be twenty rows away.
- **A row shows nothing about WHO wrote it**, and neither does the record. An authorship marker was
  drawn and cut. Do not reintroduce it.
- **The state icon is the TASK's state**, never the session's. Session presence stays on the card's
  chip and pulse bar, so an online session can hold paused work and read correctly.

**In-conversation strip** (`conversation-dock.html`). Pinned under the TopAppBar, NOT above the
composer. **Opens EXPANDED on entering a chat**, showing this session's tree with the same two folds
and NO triage gestures: no drag, no assign, no trash, since those need the pile beside them.
Collapsed is one line carrying the current task's state icon, title and count, the same line the
session card shows, with the pulse as its bottom edge so it reads as part of the bar.

**Consequence of docking to the top:** `threadDockSlots` renders above the COMPOSER
(`PluginEntry.kt:150`, call site `MainActivity.kt:3076`), so this is NOT the designer's slot. It is
either a second top-anchored registry or core surface under the bar. Cheapest honest answer: core
surface, gated on the plugin being enabled, since the board owns a top-level tab anyway.

**Entry edit view** (`entry-edit.html`). Full screen, not a dialog, since the body is multiline.
Title, body, state chips, placement (session and parent), children with add, move to trash, and a
meta footer.

- **An entry carries a BODY**, the longer explanation the assigned session reads. No hint text under
  it: that an agent reads the fields is not something the UI explains.
- **State and placement commit on tap. Title and body wait for Save.** Those two are the only fields
  with a draft to lose, and the only ones that return to a composer when a write is refused. A chip
  has nothing to restore, so making it wait would only add a step.
- **NO authorship or edit trail anywhere**, not on the row and not in the record. No `createdBy`, no
  `updatedBy`, no created or edited timestamps on screen. The one timestamp the model keeps is when
  an entry was trashed, because the 30-day sweep runs off it.

## Card authoring, learned the hard way

A design card is a WHOLE HTML document and must declare its own viewport. `DesignerThumbs` lays one
out in a fixed 480x640 offscreen WebView and lets `loadWithOverviewMode` zoom "the card's own
viewport" to fit; with no `<meta name="viewport">` the WebView falls back to its 980px default, so a
390px mockup renders at roughly a third inside its own background colour, which reads as a black
card. The shipped `SandboxFixtures` card is 900 wide with a full `<head>`, which is why it never hit
this. Also: `<title>` is where a card's NAME comes from. Folded into the designer plugin's
`agent_instructions` so the next author gets it without rediscovering it.

# Plan

Three phases. The order is forced by two things: the deploy ritual puts the gateway ahead of the
plugin bump, and the capability is CONSOLE-declared, so no session sees a tool until a console that
ships and enables the plugin has registered.

## Phase 1 - Wire and Gateway

The whole server half, landing together so it can deploy on its own.

- `BoardEntry` in `schemas.ts`, FLAT (parent pointer, never a children array - recursion-as-root
  crashes the codegen): id, title, body (`.max()`), state enum, `parent`, `rank` (`.max()`,
  fractional string), `sessionId`, and `trashedAt` (`z.number().int()`) as the ONLY timestamp. Flat
  literal fields in fixed order, `.meta({id})` throughout. The full FIVE-step fixture ritual, as a
  TRIO - op envelope, poll-result plane projection, and the `board_read` reply result (its decode
  path is separate from the plane's and CI never exercises Kotlin decode) - with a >2^31 trashedAt
  as Long bait in the reply fixture. Then `bun scripts/codegen-kotlin.ts`, and run
  `cd android && ./gradlew :app:testDebugUnitTest` before pushing - Phase 1 edits generated Kotlin
  and the fixture test, and is the phase most likely to break the post-merge build.
- Ops are ABSOLUTE, each carrying a client `opId`. **Creation is an UPSERT by an explicit,
  writer-minted entry id** - the console mints ids for capture and add-child (it needs the id at
  local-apply time anyway), the MCP create derives its id from the operation id
  (`codexAgentIdForOperation` pattern) - so a replayed create is the same entry on BOTH surfaces,
  and the move's write-half is the same upsert carrying the id across. The rest are single-field:
  set state, set title, set body, set parent+rank (absent parent = root, pinned in the schema doc),
  set trashed, set session (claim/assign/release). Plus `board_remove` - a TRUE removal by id, used
  ONLY as the move's delete-half: the move is relocation bookkeeping, not disposal, and a trashed
  tombstone on the origin would let Restore fork a moved entry into two. And `board_read`. Console
  ops join `isMutatingOp` so the opCache replays a lost reply - absolute is not monotonic, and a
  skipped dedup regresses fields under retry.
- **Server-side refusals, enumerated** (not "cycle rejection only"): cycle on a parent change,
  claim when another session holds the entry (the theft-safety the tool description promises),
  and the existence checks behind Q11's list - entry gone, parent gone, session gone.
- The console-forget hook's DEFAULT for undone entries is return-to-pile, same as the auto sweep
  and same as an old console's behavior. The Phase 2 blocking prompt expresses its decision as
  ordinary queued single-field ops SENT BEFORE the forget, so no forget-op wire change ever exists.
- Fractional rank maths as a pure module with its own tests, including the REBALANCE when a mint
  would exceed rank's `.max()`.
- Board store keyed by `ownerKeyId` in its OWN `DurableStore` file, synchronous checked writes (the
  `commitCodexCatalog` model), CAS internal-only - no client ever sees `expectedRevision` or
  `revision_conflict`. Server-side validation is the refusal list below, nothing more.
- Owner-scoped plane after `readAnchors.ts` (`task-board:${ownerId}`, lazy `ensureRegistered`, flat
  projection SORTED BY ID, byte-budgeted, degrades with a `truncated` flag). Coalescing lands as a
  REGISTRY primitive (`markDirtyCoalesced`), not a call-site debounce. **Trashed entries RIDE the
  projection** (they count against the byte budget) - the trash view and Restore need them, and Q6's
  30 recoverable days are only real if a surface can reach them.
- `board_read` with `targetGateway` is the union's read half - the plane only rides the route
  Gateway's poll. Triggers: board-tab open, pull-refresh, and entering a thread whose session is
  non-route (the sessions-tab rung and the strip read the same cache, so all THREE surfaces share
  that cadence for non-route sessions - decided, not discovered).
- **The down-Gateway failure shape** (verified in evie): a `targetGateway` naming an offline gateway
  is silently rerouted to the first LIVE gateway, which cannot unseal the frame and answers a fast
  cleartext `unseal failed` error; with nothing connected it is HTTP 503. Never a hang. Board code
  treats EVERY board_read failure as "column stale", never a banner. **The retire rule for the
  queue:** a refusal is an ok=false INSIDE a sealed reply that verified against the target gateway's
  signing key; every thrown, cleartext, or transport error RETRIES. The crypto enforces this for
  free, but it must be stated or an implementer retires queued writes on the first outage. (The
  misroute also logs an unseal error on the live gateway per attempt - known noise; a future evie
  cleanup could bounce instead of misroute.)
- `board_read` results pass through the SAME pure pending-action merge as the plane snapshot BEFORE
  the by-id union collapse - a by-id-only merge would revert an optimistic edit on every
  pull-refresh, the exact defect the merge base exists to prevent.
- Routes behind `refuseImpersonation(req, from)` - name-keyed, identity-yielding, reattach-tolerant
  (the `/plugin-action` shape; `from` is hardcoded MCP-side). NOT `mayUseLocalPlane`, which 403s
  tokenless sessions once anything is bound and cannot say which session called. NOT the `/codex`
  gate, which a reattached session 404s. Unbound-name residual accepted and recorded.
- Both sweeps, with SEPARATE constants: trash at 30 days, and the session-end hook fed by `sweep`
  RETURNING THE REMOVED KEYS (today a bare boolean) - called from the persist tick in its own
  try/catch and from the console `forget` case, never from `SessionStore.forget` (rollback paths
  call that for sessions that never started).
- **Fix `wipeState()` to target `volumes/gateway-data`** - today `9) Purge Gateway` wipes the LOG
  volume and strands every store, and `FED_DIR_HOST` mispoints the same way (breaks `clearTransport`
  and `installState`). THEN the board-count guard before the wipe. Check `purgeFederation()` too.

## Phase 2 - Console

Everything the owner touches. Kotlin gate is local: `cd android && ./gradlew :app:testDebugUnitTest`.

Lands as TWO PRs, neither broken alone: **PR-A** is invisible - the SessionsScreen lift, the tab
scaffold, the cache+queue key with both wipe-list registrations, `flattenBoard`, `BoardDraft`, all
pure or dormant. **PR-B** is the surfaces - the plugin manifest + catalog entry (kept together
because `PluginCatalogAgreementTest` pins the pair), the board tab, the edit screen and its
navigation wiring, the strip, the forget prompt, the session-card rung. The drag module trails as
its own slice; the edit screen's placement field covers moves until it lands.

- The plugin: `assets/plugins/taskboard/manifest.json` (`content_id: "taskboard"`, capability text
  as `agent_instructions`) plus the `PluginCatalog.Entry` - the pair `PluginCatalogAgreementTest`
  pins, and that test is Kotlin-only, so run the local gate. UI gates on `isActive("taskboard")`.
- Cache and queue under ONE prefs key (one atomic apply per edit), persist debounced and skipped on
  unchanged snapshots. The cache is a MERGE BASE: snapshot authoritative except fields under a
  pending action (`withFreshTeams` shape, pure and unit-tested). Queue entries retire only on accept
  or refuse, drain on the poll loop; from `ScheduledSend` only the banking shape transfers. Register
  every new key in `SCHEMA_WIPE_KEYS` and `PROVISIONING_KEYS`.
- The two-tab page: the SessionsScreen lift (drop its Scaffold, move four top-bar params,
  `collapsedGateways` to `rememberSaveable`), then the first `TabRow` and pager in this app. Back on
  the board tab exits the app; decided, not inherited.
- Board tab: capture field, unassigned pile, per-session cards, long-press assign sheet, and
  `flattenBoard` as the ONE pure producer of rows - collapse-by-id, both folds with explicit
  precedence, id-keyed, uniqueness unit-tested over generated trees. Nothing reaches
  `items(key=...)` except through it. Collapse-by-id precedence when the two copies differ (the
  move's crash window is normal operation): a non-trashed copy beats a trashed one; between two
  live copies, the one on the Gateway its `sessionId` points at (the move's destination) wins. One
  test case per rule.
- **A Trash section at the bottom of the board tab**, folded by default: trashed entries with days
  remaining, long-press offers Restore (set trashed false - the wire op already exists). This is
  Q6's delivery vehicle; without it the 30-day window is recoverable in theory only. Owner-only:
  no agent tool untrashes.
- The cache blob carries per-Gateway sync metadata (`lastSyncedAt`, set on each successful plane
  apply or board_read merge) - explicitly CACHE metadata, outside the no-timestamps-on-entries
  rule - and the stale marker draws from it, so it can say how stale, not merely that a fetch
  failed.
- Drag reorder is a NEW Compose-free module committing `(parentId, rank)` from the flattened rows
  plus `visibleItemsInfo` - not a `TabDragMath` port. Its own slice.
- Session card gains the live line as the top rung of its existing preview ladder, and drops the
  timestamp while a task is live.
- The top strip in a thread: above `ReorderableTabRow` when tabs exist, expanded height capped with
  internal scroll. Plus the blocking forget prompt (skipped when nothing is undone).
- The entry edit screen wired into all THREE navigation places: the App `when`, both `BackHandler`
  halves, and the notification-tap clear list. `BoardDraft(entryId, title, body)` as its own type
  and store key - `Draft`'s loader would drop a board key on restart.

## Phase 3 - Tools, guidance, rollout

- The six `taskBoard*` tools in `src/mcp/board/`, after `codex/codexTools.ts`: one authenticated
  route behind `refuseImpersonation`, `from` hardcoded in the MCP helper, a private per-invocation
  operation id, and create's entry id derived from it so a retry replays rather than doubles.
  `taskBoardUpdate.parent` is `.nullable().optional()` (absent = don't touch, null = root) - legal
  here because MCP inputs never pass through the Kotlin codegen.
- Capability wired per the corrected recipe: `GATED_CAPABILITY_IDS`, the `mcp/index.ts` gate, the
  manifest, the catalog entry - NOTHING in `shared/capabilities.ts` - with all three test gates run,
  the Kotlin one locally.
- Guidance through `switchboard_capabilities`, in the `designer` shape, urging the board over Claude
  Todo. **Never the always-on block**, which silently truncates.
- Rollout in order: **BOTH gateways** (`./down.sh && ./start-gateway.sh` on each - the guard is
  "every gateway before the console ships", not "a gateway"), THEN `bun run build minor` and push,
  then the console build last. Two windows if violated: a new console against a stale gateway shows
  that gateway's column absent and its queued writes hold until it updates (degraded, self-heals);
  a new PLUGIN against a stale gateway is worse - an old gateway relays the taskboard declaration
  fine, so the tools register and then 404 on routes that do not exist. The capability gate fails
  closed against an undeclared console, NOT against a stale gateway.
- Phase 2's console change (capability report to every keyring gateway) rides the same console
  build, so machine B gains the tools the first time the updated console reports to it.

Follow-on, deliberately out of scope: the no-ack channel push, which the board is the first consumer
of but which stands on its own.

