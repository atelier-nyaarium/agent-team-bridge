# Session id/name teardown

## Questionaire

### Context (research, before any questions)

The original ask was: creating a session takes a NAME, not an ID. What shipped only did half of
it - the pieces for the other half already exist in code, just not wired together:

- `create_session` already supports a mint-your-own-id mode: when the op omits `sessionName`, the
  gateway mints an opaque id itself (`consoleHandler.ts : mintedSessionId`, a 6-hex sha256-truncation
  of `conversationId:opId`) instead of deriving anything from text.
- `slugifySessionName`'s own doc comment already calls its output "the back-compat sessionName an
  older gateway adopts as the session id" - it was written as a legacy path, not the intended one.
- `SpawnDialog`'s own comment already says "the gateway mints the session id, so the label is not
  slug-constrained" - the intent was already recorded in the code.
- The actual gap: `ChatRepository.kt : spawnSession` still computes `slugifySessionName(label)` and
  sends it as `sessionName` regardless, so the mint-path never fires. That's the unfinished half.
- `rename_session` (gateway) already only ever touches `sessionLabel`, never the id - a rename was
  never rewriting the id. What actually reads as "confusing to look at" is `SessionCard` deliberately
  rendering the raw id as a small secondary line under the label whenever they differ - a permanent,
  growing-more-stale ghost of the original typed name, surfaced by design once a label diverges from
  its id.
- Addressing already copes with label != id elsewhere: `crosstalk_discover` already prints
  `"<sessionLabel> (<address>)"` when a label exists, so another agent (or the user) already resolves
  a session by label-then-address, not by memorizing/typing the id.
- The id doubles as the devcontainer's tmux session name and, via `composeSessionName`, the wire
  address leaf every `crosstalk_send`/`wake` targets - the one place opacity has a real, non-UI cost.

### 1. What should the id actually be, once the slug-derivation is torn out?

**Answer: A - fully opaque, gateway-minted id.** `create_session` stops sending `sessionName`
entirely; the gateway always mints one. Pure decoupling - the id is never human text, at creation or
ever after. Cost: a devcontainer's tmux session name / wire address becomes an opaque hex leaf instead
of a readable one, mitigated by the terminal view (no one needs to type tmux commands by hand) and by
discovery already resolving by label first.

Also confirmed against the code: discovery already shows both display name and id
(`bridgeDiscover.ts` formats `"<sessionLabel> (<address>)"` whenever a label exists, and
`create_session`'s `displayLabel` already becomes the gateway's `sessionLabel` immediately), so no
discovery-tool change is needed. Found a real bug matching the "not cached unsynced on phone" concern
though: Android's `labelOrNull` lets the phone-local label cache win over the gateway's authoritative
`sessionLabel` forever once set, even after the server disagrees - fixed in Phase C.

### 2. Is prefix-addressing a human/agent convention, or a new resolve-by-prefix protocol feature?

**Answer: A - convention only, no protocol change.** User: "No changes to those functions. Display
name usually enough. Agent will discover and see it. 4 digit as extra assurance." `crosstalk_discover`
already lists full ids next to labels, so telling another agent "message session a1b2" already works
today - it reads the list, pattern-matches the prefix by eye, uses the full id in `crosstalk_send`.
Zero new surface needed.

### 3. SessionCard's secondary line - remove entirely, or keep the id visible for power users?

**Answer: A - remove entirely.** User: "Remove, keep listing cleaner." The tile shows only the label.
The technical id stays reachable via the Rename dialog's "Id: ..." line and `crosstalk_discover`'s
"label (address)" listing for anyone who needs it.

### 4. Local label cache: bound its override window (user-raised)

User: "The phone Session Name cache needs to be a cache and not an override. If I rename, it must
rename on gateway / host-agent. Another phone must pick up the rename journal event. Or grab it fresh
on poll. however that works."

Resolution: no new push/journal mechanism needed, the existing poll loop covers it once wired
correctly (Phase C) - the passive teams refresh will prune a stale local label the moment it observes
the gateway's own value, so a rename from any device propagates to every other device within one poll
cycle, with the local cache surviving only as a same-request optimistic flash.

### 5. Does the crosstalk wake-creates-a-session path also tear down?

`doWakeTeam` (`src/gateway/index.ts`) has a second, independent session-minting mechanism: when
`crosstalk_send`/`wake` addresses a `project.session` that does not exist yet, it adopts a provisional
record using the parsed leaf of whatever address the caller typed as both id and label - the same
typed-text-becomes-the-permanent-id pattern this plan tears down elsewhere, just reached through a
different door.

**Answer: B - tear it down too.** User: "for a team to create a session that doesn't exist, their
tool should make them choose a name. So it's Display Name and the minted ID. Easy for both agent and
human to see." Every creation path, Android or crosstalk, ends up name + minted-id. See Phase G.

## Phase A - gateway: collision-safe minted ids

`create_session` mints an id via `mintedSessionId` whenever `sessionName` is omitted; Phase B makes
this the primary path for every new session instead of a rare fallback, so it needs to be safe against
two things a rare fallback never had to worry about: two different requests computing the same id, and
the same request retrying after a restart or cache eviction.

**Provenance-based retry safety.** `SessionRecord` (`session-store.ts`) gains an optional
`mintedFrom?: string` field, set only for a gateway-minted id (`${conversationId}:${opId}`), never for
a `sessionName`-provided/slug-adopted record. `CreateOpts` gains the matching field. Threaded through
exactly two construction sites: `create()`'s object literal reads `opts.mintedFrom`, and
`SessionStore.restore()`'s separate field-by-field literal extracts it from the persisted value with
the same `typeof`-guard every sibling optional field already uses there (`typeof v.mintedFrom ===
"string" ? v.mintedFrom : undefined`), gated by the same `persisted` ternary its siblings use -
`restore()` is the boundary between disk bytes and a typed record, so every field crossing it needs
its own runtime check, not just a name in the output literal. `adoptById`/`mint`/`adoptOrReattach`
need no changes of their own; they all forward `opts` straight through to `create()`.

`SessionStore` gains a lookup by provenance: `findByMintedFrom(mintedFrom: string, spawn: string):
SessionRecord | undefined`. Not a blind first-match scan - unlike `id` (unique by Map key) and
`sessionLabel` (unique via the store's own `claimLabel`/`dedupLabel` index, actively re-verified on
every mutation including `restore()`), a bare `mintedFrom` scan has no such backstop by default, so a
corrupted or hand-edited persisted file violating "at most one record per mintedFrom" would otherwise
silently return whichever record sorts first - worse than a visibly-wrong phantom, since it silently
reattaches to an unrelated stranger's session. If the scan finds a second match, treat the result as
ambiguous and return `undefined` (falls through to a fresh mint, always safe) rather than trusting the
first hit. Also take the caller's `spawn` and reject/ignore a match in the wrong spawn - cheap
insurance against a client bug that reuses a `(conversationId, opId)` pair across a different target.

In the `create_session` handler, when `op.sessionName` is absent - and only inside that branch, never
hoisted alongside the unconditional `dedupKey` computation a few lines above it (the two happen to be
the textually identical `${conversationId}:${opId}` expression, an inviting-looking but wrong
refactor target: a hoisted, unconditional lookup would run on a `sessionName`-provided create too and
could reattach it to an unrelated mint-path record sharing that op id by coincidence):

1. Call `sessionStore.findByMintedFrom(\`${conversationId}:${opId}\`, spawn)`. Found -> reattach
   directly to that record, done - stable no matter what happened to any other record in the meantime,
   since it never re-derives or re-probes anything.
2. Not found -> mint a fresh id via `SessionStore.mint()` (the store's own existing, already-tested
   random-id-with-retry helper - reused rather than hand-rolling a second mechanism), with
   `mintedFrom` stamped so step 1 finds this record directly on every future retry. A fresh
   independent draw on every genuine collision means there is no scenario where deleting an earlier
   collision's winner forces a retry back through a fixed, guaranteed-to-repeat sequence of
   candidates - each attempt is independent, matching the exact reasoning `mint()`'s own doc comment
   already gives for why its bound is "unreachable in practice against a handful of records."

**Don't roll back a provisional record on an ambiguous host-op timeout, only on a definitive
failure.** The existing rollback (`if (!ok && adopted?.created) sessionStore.forget(...)`) currently
fires identically whether the host op genuinely failed or merely timed out waiting for a reply -
`HostOpCoordinator.wait`'s 20s timeout resolves on its own clock regardless of whether the host
daemon's launch is still in flight and succeeds moments later. If the real launch does land afterward,
the confirming session's lead handshake goes through `establishOnConfirm`, a separate path with no
`conversationId`/`opId` in scope, so its own self-heal cannot stamp `mintedFrom` - a later retry of
the original op would then find nothing via provenance and mint a genuine second record for an op that
already succeeded. Fix: give `HostOpCoordinator`'s timeout result a distinct `errorKind: "timeout"`
(extending the `errorKind` discriminant `host_op_reply` already carries), and skip the `forget()`
rollback specifically for a timeout - leave the provisional record in place; it either gets confirmed
normally by the in-flight launch, or sits unconfirmed until the ordinary 30-day TTL sweep like any
other stalled provisional record today.

**Accepted, explicitly out of scope:**
- `establishOnConfirm`'s self-heal path remains structurally unable to stamp `mintedFrom` (it has no
  request provenance in scope at all). The timeout fix above closes the most likely path into this
  gap but not the gap itself; fully closing it means threading provenance through the confirm path, a
  materially larger change than "make the mint path collision-safe."
- An abrupt, non-graceful crash (SIGKILL/OOM, not a graceful restart - those already flush via the
  `SIGTERM`/`SIGINT` handlers) inside the ~3s window between persist ticks can lose any just-created
  record. This is a pre-existing property of the whole persistence model, not specific to this phase.

**New tests**, six in `src/__tests__/console-handler.test.ts` plus one in `src/__tests__/session-store.test.ts`:
- (a) genuine collision - seed the store with a stranger record, dispatch a create_session for a
  different (conversationId, opId), assert the stranger is untouched and the response id differs.
- (b) the existing restart-safe test (line 1244) still passes unmodified.
- (c) a genuine snapshot/restore round trip - mint a record in one `SessionStore`, `snapshot()` it,
  `restore()` it into a SECOND, fresh `SessionStore` instance, re-dispatch the identical op against
  store #2, assert it reattaches rather than minting a phantom.
- (d) store churn - after a genuine collision resolves, delete the ORIGINAL WINNING record itself (not
  just whatever it collided with), retry the same op, assert it mints a fresh id, distinct from the
  forgotten one, without touching the original stranger.
- (e) ambiguity guard - hand-construct two records sharing one `mintedFrom` value (a corrupted/
  hand-edited file), confirm `findByMintedFrom` returns `undefined`, not either record. Lives in
  `session-store.test.ts` instead, alongside the store's own other direct unit tests, since it
  exercises `SessionStore.findByMintedFrom` directly rather than a console_handler dispatch.
- (f) scope guard - seed a `mintedFrom`-stamped record, dispatch a create_session with an explicit
  `sessionName` reusing that SAME (conversationId, opId), assert the response honors the caller's own
  `sessionName` rather than reattaching to the unrelated mint-path record.
- (g) concurrency pin - fire two DIFFERENT, colliding create_session dispatches via `Promise.all` (not
  pre-seed-then-await) to empirically confirm no interleaving between the provenance lookup and the
  mint, rather than leaving that property true only by code inspection.

**Red-team addendum (found and fixed post-implementation, empirically reproduced against the real
code before the fix, not just traced):**
- The rollback guard's `adopted?.created` check conflated two different things on the mint path: a
  retry that reattaches its own prior record via `findByMintedFrom` also reads `created: false`, the
  same value a genuinely unrelated pre-existing record gets on the `sessionName`-provided path - so
  once a mint-path record survived one ambiguous timeout, every later retry that reattached it became
  permanently exempt from rollback, even on a fully definitive failure. Fixed by tracking rollback
  eligibility separately from `created`: on the mint path ANY record reached is eligible (provenance
  can never match a stranger), on the `sessionName` path only a fresh `created: true` is.
- Separately, `HostOpCoordinator.failAll()` (fired on a host WS disconnect) resolved with no
  `errorKind` at all, so it was wrongly treated as a definitive failure even though it is exactly as
  ambiguous as a bare timeout - the op was already relayed to the host and executes independently of
  the WS that requested it. Gave it its own `errorKind: "disconnected"`, treated identically to
  `"timeout"` by the rollback guard. This also closes a deeper cascade a full trace surfaced: since a
  wrongly-forgotten record used to force a retry to mint a brand-new id, and the host's own
  dedup cache is keyed only by `dedupKey` (blind to which id/target it was for), a retry could receive
  a stale success ack for an id that was never actually launched while the real one orphaned. Fixed as
  a consequence of the above: a retry now reattaches to the SAME preserved record and therefore the
  SAME target, so the host's cache and the gateway's id never diverge.
- The rollback guard is now re-checked at forget-time (not cached from earlier in the request): a
  devcontainer wake's own success signal can narrow to a shorter registration window than a slow first
  boot needs, so a "failed" wake can still go on to register and confirm moments later. The guard now
  re-reads `confirmedAt` fresh before forgetting, so a record that came alive in the meantime - through
  any attempt, not just this dispatch's own - is never destroyed by a stale failure signal.
- Accepted, not fixed this pass: `findByMintedFrom`'s ambiguity guard (falls through to a fresh mint
  rather than trusting either of two colliding records) has no recovery path - every retry against an
  already-ambiguous `mintedFrom` mints one more record instead of resolving the ambiguity, so a
  sustained retry storm against an already-corrupted/hand-edited store grows unboundedly. Low severity
  since reaching the initial ambiguous state already requires that disclaimed precondition; a full fix
  (reconciling or pruning ambiguous records) is a separate feature.
- Not touched, already tracked separately: `forget` has no `isWakeInFlight` guard (unlike its sibling
  `close_session`), so forgetting a still-launching `create_session` does not cancel the underlying
  devcontainer bring-up and the session can silently resurrect once it confirms. Pre-existing, logged
  in `plans/pain-points.md`, unrelated to this phase's collision-safety work.

**Red-team addendum, round 2 (a second pass specifically targeting the round-1 fix itself, same
empirical-reproduction bar):**
- `mayForget()`'s confirmedAt re-check read a field on the `adopted` closure's own captured record
  object, not the store's CURRENT occupant of that team key. `forget` has no in-flight guard (see
  above), so between this dispatch's launch call and its own failure settling, an unrelated later
  create_session could forget-then-recreate the SAME key - `teamOf()` is a pure function of the
  immutable spawn+id, so a stale record and a brand-new one born at that key produce an identical
  lookup. A dispatch whose own launch later failed genuinely could then forget a completely different,
  live, CONFIRMED session that happened to reuse its name. Fixed by re-fetching the record currently at
  the key (`sessionStore.getByTeam`) and requiring it be the exact object (`===`) this dispatch
  adopted, in addition to the confirmedAt check - a recycled key is no longer mistaken for survival.
- The `sessionName`-provided path's `rollbackEligible = adopted?.created === true` meant a record that
  survived an ambiguous timeout on attempt 1 became PERMANENTLY un-rollback-eligible on any retry
  (attempt 2 reattaches with `created: false`), even facing a later genuinely definitive failure - the
  record squatted the name until the 30-day TTL sweep. This class of bug was already found and fixed
  for the mint path in round 1 (provenance via `mintedFrom`); the `sessionName` path had no equivalent
  provenance mechanism. Fixed by stamping `mintedFrom: dedupKey` on the `sessionName` path's create too
  (harmless on a reattach - `create()` only reads it on a fresh record), and widening
  `rollbackEligible` to `adopted?.created === true || adopted?.record.mintedFrom === dedupKey`. An
  unrelated stranger's record - reached via reattach but never minted by this exact
  (conversationId, opId) - still has no matching `mintedFrom` and stays permanently protected.
- `tryWakeTeam` (the devcontainer create path) mapped its bare boolean result into `HostOpResult` with
  no `errorKind` at all, so a devcontainer create_session rolled back on ANY wake failure - including
  an ambiguous one (`WakeCoordinator`'s own timeout, or the host link dropping mid-wait) that a host
  target's equivalent `relayToHost` timeout/disconnect correctly leaves alone. `WakeCoordinator`
  (`gateway/wake.ts`) now resolves the same `{ok, errorKind?: "timeout"|"disconnected"}` shape
  `HostOpCoordinator` already established, threaded through `doWakeTeam`/`tryWakeTeam` and its other
  two callers (`routes.ts`'s send-wake path, the cross-Gateway `wake` relay op), so all three concur
  on one mechanism instead of a second parallel one.
- Accepted, not fixed this pass: a `SessionRecord` minted by the OLD, now-deleted deterministic-hash
  `mintedSessionId` scheme (pre-dating this diff's deploy) has no `mintedFrom` at all, so a retry of
  that exact original (conversationId, opId) landing after this diff deploys cannot find it via
  `findByMintedFrom` and mints a second, independent record - reopening the phantom-duplicate-mint
  failure mode for records that predate the deploy specifically. Bounded to the transition window
  (a retry of a specific pre-deploy op, not an ongoing exposure), non-destructive (a duplicate mint,
  never someone else's session getting deleted), and the mint path is not yet the primary Android flow
  (Phase B). Resurrecting the deleted deterministic-hash mechanism as a fallback-only lookup would close
  it but adds permanent complexity for a one-deploy-cycle gap; not worth it at this severity.

## Phase B - Android: stop minting ids from the typed name

- `ChatRepository.kt : spawnSession` - drop the `slugifySessionName(label)` call and the
  `sessionName = slug` argument; call `createSession(project, displayLabel = label)` only, letting
  the gateway mint the id (Phase A). Confirmed `slugifySessionName` has exactly this one production
  call site - delete the function and its dedicated `SlugifySessionNameTest.kt` (10 cases, all
  purely testing the function being removed).
- `wakeSession` - unchanged; it already correctly re-sends the session's real existing id to reattach,
  which is unrelated to the slugifier bug (only minting a NEW session's id was ever wrong).
- Note: the CLAUDE.md line describing create as navigating straight to the minted id on spawn does not
  match the shipped, poll-driven `spawnSession` path (confirmed: it stays on the board, never reads
  the create result's id) - a stale-doc fix worth making while touching this area.

**Red-team addendum (found and fixed post-implementation, empirically traced against the real
code):**
- The old slugifier had an accidental idempotency property this change silently removed: retyping the
  identical label re-derived the identical slug/id, so `adoptOrReattach` naturally reattached to the
  same record on a retry regardless of opId. The gateway-mint path has no such fallback - every
  `spawnSession` call drew a fresh random opId (`ConsoleClient.createSession`'s default), so
  Phase A's `mintedFrom`-based reattachment was structurally unreachable from Android's actual create
  flow. Concretely: a cold-container create's reply can take up to ~25s; if it is lost after the
  gateway genuinely minted the session (network drop, app backgrounded mid-request), the user sees a
  failure with no retained state, and a well-intentioned retry mints a second, fully redundant
  session. Fixed by giving `ChatRepository` a small in-memory `recentSpawnOpIds` map keyed by
  `(project, label)`: a retry within a 40s window (past the cold-container bound) reuses the prior
  attempt's opId, so the gateway's own already-correct logic resolves it properly - reattach if that
  attempt is still alive, mint fresh if it genuinely failed. Cleared on a confirmed success so a later,
  unrelated create with a coincidentally-matching label is not wrongly folded into an old one.
- A label `sanitizeLabel` (`session-store.ts`) rejects outright (a lone zero-width space, or any
  string containing a Unicode `Cf`/zero-width-joiner character - common in compound emoji like family
  or profession glyphs) used to fall back to the OLD slugifier's ASCII-derived slug, still somewhat
  recognizable; post-slugifier-removal it silently falls back to the fully opaque minted hex id with
  no error and no trace of what was typed. Fixed (final form, see round-2 addendum below for how the
  first cut of this fix was superseded) by a dedicated wire field, `labelSanitized`, computed once by
  the gateway directly from the request's own `displayLabel` and surfaced to a distinct client
  transient message rather than staying silent.
- A label over the wire schema's 64-character cap (`displayLabel`/`sessionLabel` in `schemas.ts`) had
  no client-side guard on either `SpawnDialog` or `RenameDialog`'s text field, so pasting a long string
  crashed the sealed envelope's zod parse inside `consoleSealer.ts`; `relayPump.ts`'s generic
  seal-open catch treated that parse failure exactly like a real crypto/auth error and replied
  `unseal failed: <raw multi-line ZodError dump>`, shown to the user verbatim (the one failure site in
  `ChatRepository.kt` that did not truncate its error message). Pre-existing (not specific to
  id-minting), but surfaced by the same audit pass and directly reachable through the exact field this
  phase touches. Fixed with a client-side 64-character cap on both text fields, matching the wire cap,
  so the invalid input is never submitted rather than fixing the server's generic error framing.
- Confirmed, not touched: the display-degradation findings this pass also surfaced (a session's
  secondary id line, the sharing screen, board ordering, and tab-collision labels all read worse with
  an opaque hex id than the old semi-readable slug) are exactly what Phase D already specifies fixing,
  independently re-derived by the audit - confirms Phase D's scope, requires no plan change.
- Logged, not fixed (pre-existing, unrelated to id-minting): `RenameDialog`'s blank-vs-prefill guard
  has a structural shape mismatch that makes it never actually blank a truly-unlabeled session's
  field; see `plans/pain-points.md`.

**Red-team addendum, round 2 (a second pass specifically targeting the round-1 fixes above, same
empirical-verification bar):**
- The round-1 `sessionLabel == id` fallback-detection heuristic had a structural TOCTOU flaw: both
  `create_session` reply sites read the record's CURRENT `sessionLabel`/`id` at reply-construction
  time (up to `CREATE_SESSION_BOUND_MS` later for a backgrounded devcontainer wake), not at the moment
  the record was created - and `rename_session` has no in-flight guard, so a rename landing on the
  same record in between could flip the verdict either way: mask a genuine fallback (the user renamed
  before the reply arrived) or fire a false positive quoting a stale label (a rename to a value that
  happens to equal the id - plausible, since `RenameDialog` literally displays `Id: $team` inviting
  copy-paste). Separately, the SAME heuristic is a live footgun for reuse elsewhere: on the
  `sessionName`-provided path, `sessionLabel === id` is the deterministic DEFAULT whenever no
  `displayLabel` is sent (nothing to do with sanitization), so applying this check to `wakeSession`'s
  result in some later refactor - a natural-looking consistency cleanup - would misfire on essentially
  every fresh record that path creates. Fixed both at the root: replaced the inferred heuristic with
  an explicit `labelSanitized` boolean on `ConsoleCreateSessionResult` (`schemas.ts`), computed exactly
  once, directly from `sanitizeLabel(op.displayLabel)`, before any launch/wait and independent of the
  record's live state entirely - immune to a later rename, and `false` whenever no `displayLabel` was
  sent at all, so it is safe to reuse on any path without re-deriving the same bug. This same redesign
  also incidentally closed two round-2 low-severity siblings for free: a `dedupLabel` collision suffix
  masking a fallback (the new flag never reads `sessionLabel`/`id` at all), and a coincidental
  valid-label-equals-fresh-id false positive (same reason).
- Confirmed, not fixed (pre-existing, self-correcting, non-destructive): `spawnSession`'s
  `runCatching` catches `CancellationException` like any other failure, so an Activity recreation
  (e.g. device rotation) while a create is in flight can show a spurious "Failed to create" Snackbar
  even when the create actually succeeded server-side; the real session still appears via the next
  `teams()` poll. Logged in `plans/pain-points.md`.
- Verified, no action needed: `sanitizeLabel`'s own code-point-based 64-cap can never truncate a label
  that already cleared the wire schema's 64-code-unit cap (a code-unit count is always >= its
  code-point count), so the two caps never actually disagree in practice; and Kotlin's `String.length`
  and zod's `.max()` both count UTF-16 code units identically, so the new client-side cap has no
  residual cross-platform unit mismatch.

## Phase C - Android: server-authoritative label

- `ChatState` (a plain data class) gains two fields: `labels: Map<String, String>` (existing) and a
  new `teamAbsenceStreak: Map<String, Int> = emptyMap()` for the vanish-counter below - as a
  `ChatState` field, not a `ChatRepository`-private `var` (the file has an existing but wrong
  precedent for that shape, `pollFails`, which would put the actual streak logic somewhere untestable
  and defeat the point of extracting this as a pure function). Persist `teamAbsenceStreak` alongside
  `labels` (`persistAbsenceStreak`/`loadPersistedAbsenceStreak`, mirroring `labels`' existing pair) -
  unlike `pollFails` (which deliberately resets on a fresh start since it tracks live-right-now
  connection health), this streak accumulates evidence against an already-durable value across
  restarts, and the device most likely to go a long stretch without the app foregrounded is also the
  one most likely to have its process killed in between observations.
- Extract the prune+streak rule as a pure `ChatState`-level function (mirroring the existing,
  already-tested `sessions()` derivation in `ChatStateSessionsTest.kt`) -
  `ChatState.withFreshTeams(freshTeams: List<Team>)`, replacing `teams` and the two label-tracking
  fields in one step.
- Wire `withFreshTeams` into BOTH the places a teams list actually gets replaced on success -
  `refreshTeams()` and the separate inline block inside `startPolling()` (the one that actually runs
  continuously for the app's lifetime; `refreshTeams()` alone is only called from a handful of
  action-triggered sites and is not on the passive polling cadence) - via one small shared helper both
  call, so the prune logic lives in exactly one place. `refreshTeams()` keeps separately calling
  `refreshLinkedPeers()` afterward exactly as it does today; nothing about that cadence changes.
  Deliberately NOT wired into `connect()`, a third, structurally similar site that on a failed fetch
  unconditionally re-applies a fallback which can itself be an empty list on a cold-start network
  failure (unlike `labels`, `teams` is not seeded from persisted state).
- Prune rule: drop `labels[team]` the moment the fresh list reports a non-null `sessionLabel` for
  `team`, whatever its value (self-heals a stale local override, including one this same device set).
  Never prune on `team` simply being absent from one fresh list alone - a momentary gap shouldn't wipe
  a legitimate pending local edit.
- Vanish-counter (for a team that disappears from `teams()` entirely - forgotten or TTL-swept
  elsewhere, which the prune rule above can never observe and so could otherwise leak the local label
  forever): at the same `withFreshTeams` site, increment `teamAbsenceStreak[team]` for every
  locally-labeled team not present in the fresh list at all, reset it on reappearance; once a team's
  streak crosses a small bound (e.g. 2 consecutive observations), prune its `labels[team]` too.
  Deliberately not pruned on the very first absence - `forget(team)` already clears the local entry
  immediately for a same-device forget, so this counter exists only for the cross-device/TTL-sweep
  case, and the grace avoids wiping a legitimate rename's local flash on a single transient miss.
- Foreign-Gateway rename guard: `rename()` currently calls `setLabel()` optimistically before the
  server round-trip, with no check on whether the target actually belongs to this Gateway - a
  federated peer's loose session can pass the board's existing (and mutually inconsistent) Rename-menu
  gates. Fix: gate the optimistic `setLabel()` on the same pattern `closeTab`/`wakeSession` already use
  elsewhere in this file to answer "is this session mine" -
  `parseTarget(team, localDomain(), state.localGatewayId)` resolving to an `Address` whose `gateway`
  AND `domain` both match local (the sibling functions check gateway only; match the gateway's own
  authoritative check, which verifies both). Withhold the optimistic write entirely when this doesn't
  resolve local; additionally still treat an outright rejection from `renameSession` (today silently
  swallowed via `getOrNull()`) as a signal to revert, as defense in depth.
- New test: `ChatStateLabelsTest.kt` (mirroring `ChatStateSessionsTest.kt`'s style) - local wins when
  both present and no fresh server value has landed; local is dropped the moment a fresh non-null
  server value lands, whatever it is; a still-absent team does not prune on one miss; the streak
  crosses its bound and prunes, and resets on reappearance before crossing it; the accepted
  same-device rename-race flicker (optimistic -> a stale poll reverts it for one cycle -> the rename's
  own success handler reapplies) actually self-corrects rather than sticking.

**Red-team addendum (found and fixed post-implementation, empirically traced against the real
code):**
- A missing `SCHEMA_WIPE_KEYS` registration for the new persisted key (every other address-keyed pref
  is listed there so the one-shot grammar migration wipes it too), a naming inconsistency
  (`teamAbsenceStreak` renamed to `teamAbsenceStreaks` to match the `labels`/`drafts`/`threads` plural
  convention), a TOCTOU bug in `rename()`'s revert path (an unconditional overwrite of a
  pre-suspension snapshot, which could stomp a fresher value a concurrent self-heal or a later rename
  already landed), and a regression where a blank-name rename on a non-local team silently did nothing
  instead of clearing the local label (the optimistic-write gate had swallowed the unconditional
  local-only clear along with it) - all found by one internal audit pass and fixed before the first
  red-team round even started.
- The dedup-reapply branch (`applied != trimmed`, a server-side "-2" suffix) had the exact same
  staleness class as the just-fixed revert branch: an unconditional `setLabel(team, applied)` with no
  check that nothing else had already changed the label since this call's own optimistic write. Fixed
  with the same atomic-CAS guard, extended to still accept the confirmed server value unconditionally
  when there was no optimistic write to protect in the first place (the `!isLocal` case).
- `applyFreshTeams`'s two persist calls (`persistLabels`/`persistAbsenceStreaks`) had no
  synchronization against a concurrent call to the same function - `refreshTeams()` (a manual
  pull-to-refresh) and `startPolling()`'s own periodic teams-refresh both run on `Dispatchers.IO`, a
  real thread pool, and `SharedPreferences.apply()` gives no ordering guarantee across genuinely
  concurrent callers, so an older fetch's snapshot could physically win the on-disk file over a newer
  one already reflected in memory. Fixed with a `Mutex` serializing one `applyFreshTeams` call at a
  time, held only around its own body (state update + both persist writes), never across the
  network fetch itself.
- Accepted, not fixed this pass: multiple rapid renames on the same team submitted before any of them
  resolves have no debounce, cancellation of a prior in-flight attempt, or per-team sequencing, so the
  final label is decided by whichever network reply happens to land last rather than by click order.
  Each individual call's own staleness guard (above) prevents any of them from corrupting a value a
  later call already established, so the failure mode is "an earlier click's result can still win over
  a later one" rather than data loss or corruption - annoying in the specific case of typing multiple
  quick corrections, not destructive. A full fix needs per-team request sequencing (a generation
  counter or a cancelling `Job` per team), a larger change than this phase's scope; logged in
  `plans/pain-points.md`.

## Phase D - Android: remove the id from casual display

- `SessionCard` - delete the `if (display != team.shortName) Text(team.shortName, ...)` secondary
  line entirely.
- `Sharing.kt` - `SessionShareScreen`'s header and each session row currently render `shortName`;
  switch both to the display label. Needs a state reference threaded in (`SharingScreen` currently
  reads `shareableSessions()` once via a non-reactive `remember{}`, not `collectAsState()` - fix that
  in the same pass so a label change is even reflected there).
- `ChatRepository.kt : peerSessions` / `shareableSessions` - switch `sortedBy { it.shortName }` to
  sort by label.
- `MainActivity.kt : sessionOrder` - the board's primary comparator's final tiebreaker,
  `.thenBy { it.name }`, sorts by the raw canonical address; switch to
  `.thenBy { state.label(it.name, state.localGatewayId) }`, matching the fix applied to
  `peerSessions`/`shareableSessions`. This is the single most-viewed session ordering in the app.
- `MainActivity.kt : tabLabelFor` - its collision-fallback path currently escalates straight to the
  bare, unlabeled opaque id the moment two open tabs happen to share a label (label uniqueness is only
  enforced per-spawn, so this is an expected collision, not a corner case). Qualify the label instead
  of falling through to raw address segments: prefix with the label, then append however many of the
  four already-canonicalized address segments (`domain.gateway.spawn.session` - every open tab's key
  is already the full canonical address, so no new data plumbing is needed) are required to
  disambiguate - `spawn.session` for a purely local collision, escalating to include `gatewayId` and
  then `domainId` only if a collision persists across Gateways or Domains (a spawn name like `host`
  repeats across every Gateway, and a default-hostname `gatewayId` can plausibly repeat across
  independent Domains, so a partial qualifier alone is not always sufficient). Keep the existing
  bare-address fallback only for the true edge case of no label at all.
- `RenameDialog` - no change; its labeled "Id: ..." line is the one deliberate, non-ambiguous place
  the raw id stays visible.
- `MainActivity.kt : localName` (project-header grouping/parsing) - no change; internal addressing
  use, never rendered raw.

**Audit addendum (found and fixed post-implementation):**
- Labels are free-form text (a user can type literal parentheses), so `tabLabelFor`'s new
  `"Label (qualifier)"` format had no check against another open tab's own raw label - a
  coincidentally (or deliberately) matching label elsewhere could render identically to a
  disambiguated tab's own text, defeating the whole point of disambiguating in an agent-dispatch
  tool. Fixed by also checking each candidate against every other open tab's label before accepting
  it, escalating the qualifier further (and ultimately falling back to the bare address, same as the
  no-label case) rather than risking a collision. `tabLabelFor` made `internal` and pinned with
  `TabLabelForTest.kt`, including the exact collision scenario found.
- `Sharing.kt`'s `people` list had the exact same one-shot, non-reactive `remember{}` gap `sessions`
  was fixed for one line above, missed in the first pass - a newly-linked person could not be picked
  in the audience list until the sheet was closed and reopened. Fixed with the same `remember(state)`
  key.
- `shareableSessions()` read two different values for "local gateway id" within the same function
  (`gw`, the pre-existing local val its own filter already used, and the newly-added
  `s.localGatewayId`, the `ChatState` snapshot's copy) - currently harmless since `label()` never
  reads that parameter, but a latent inconsistency. Fixed to reuse the one already-bound `gw`.
- Logged, not fixed (pre-existing, unrelated to id-minting): `shareableSessions()`'s filter itself
  reads the `ChatRepository`-private `localGatewayId` var rather than the `ChatState` copy Compose
  actually observes, and `shares`' (the per-session audience map) own staleness gap; see
  `plans/pain-points.md`.
- Found during the align pass: `tabLabelFor`'s escalation loop started at the bare session segment
  (`n=1`) even for a labeled collision - harmless before minted ids (a `claude`-shaped session segment
  almost always collided, forcing escalation to `spawn.session` anyway), but now that ids are random
  hex (Phase A/B) two same-labeled tabs typically have already-distinct bare ids, so the loop would
  stop at `n=1` and show a meaningless hex fragment - exactly the opaque-id-in-casual-display problem
  this phase exists to remove. Fixed: a present label always qualifies with at least `spawn.session`;
  the label-less fallback is unchanged (there is no label for an opaque id to ride alongside either
  way). Pinned by a new `TabLabelForTest.kt` case using two already-distinct hex ids.
- Found during red-team round 2 (empirically reproduced): that same fix over-corrected. Requiring
  `spawn.session` as the minimum tier removed `n=1` as an escape hatch entirely, so a small number of
  literal labels elsewhere - one planted at each of the `spawn.session`, `gateway.spawn.session`, and
  full-address tiers - could exhaust every candidate the loop tries and fall all the way through to
  the fully unlabeled raw address, a worse outcome than the pre-fix behavior would have produced for
  that exact case. Fixed by trying the preferred tiers (`spawn.session` up through the full address)
  first as before, then retrying the bare session id as a last resort before giving up - a
  labeled-but-terser tab beats an unlabeled raw one every time. Pinned by a new test reproducing the
  exact three-planted-labels exhaustion scenario.
- Logged, not fixed (low severity, negligible at this app's realistic session counts): `peerSessions`,
  `shareableSessions`, and `sessionOrder`'s sort comparators now call `label()`, which falls through to
  an `O(n)` scan whenever a session's `labels` entry has been pruned (the common case) - degrading the
  sort from `O(n log n)`; see `plans/pain-points.md`.

## Phase E - gateway: no wire-schema change needed

`ConsoleOp.createSession`'s `sessionName` is already optional on the wire - this is a client-behavior
change only (stop sending it), not a schema change. Phase A's new `mintedFrom` field lives on
`SessionRecord`, which is gateway-internal/persisted-only (never serialized to the app), so it is not
a wire type either - no Kotlin codegen run needed for either change. Confirm both hold once Phases A/B
land (re-check `schemas.ts` and `codegen-kotlin.ts` output unchanged).

**Verified, no code change:** `schemas.ts`'s `sessionName: z.string().min(1).max(64).optional()`
confirmed still optional; `mintedFrom` confirmed to never appear anywhere in `schemas.ts` (it is
read/written only by `session-store.ts` and `consoleHandler.ts`, never serialized to the console).
Re-ran `bun scripts/codegen-kotlin.ts`; `Protocol.kt` came back byte-identical (`git status` reports
no change) - `CreateSession.sessionName` remains `String? = null` in the generated Kotlin. Both of
this phase's claims hold; no wire-schema or codegen work was needed.

## Phase F - gates

- `bun run lint && bun run test` (TypeScript side), including Phase A's seven new test cases across
  `console-handler.test.ts` and `session-store.test.ts`.
- New `ChatStateLabelsTest.kt` (Phase C) passes as part of the Android unit test gate.
- Android `:app:testDebugUnitTest` local build gate (Phase B-D), per repo convention (CI does not
  compile Kotlin pre-merge).
- Manual round-trip: create a session by name, confirm the tile shows only the name with a live
  spinner through boot, no id ghost line; rename it, confirm a second phone (or leaving the app
  foregrounded and idle, to exercise the passive `TEAMS_REFRESH_MS` loop rather than just the manual
  pull-to-refresh button) picks up the new name; open Sharing from both entry points and confirm rows
  show labels, sorted by label; open two sessions from different projects with the same label as tabs
  and confirm the tab titles read as a qualified label, not a bare hex id; `crosstalk_discover` from
  another session shows "name (opaque-id-address)".

**Gate results:**
- TypeScript gate: `bun run lint` clean (189 files, no fixes needed), `bun run test` 892 passing,
  including Phase A's seven `console-handler.test.ts`/`session-store.test.ts` cases.
- Android gate: `:app:testDebugUnitTest` 191 passing (184 plus 7 new `SessionOrderTest.kt` cases, see
  below), `ChatStateLabelsTest.kt` confirmed 7/7.
- Manual round-trip: no Android emulator or physical device is reachable from this environment, so the
  five bullets were code-traced against the shipped implementation instead of executed on-device:
  - Tile shows name + spinner, no id ghost line -> traces to `MainActivity.kt`'s `SessionCard` (the
    secondary `shortName` line was deleted in Phase D).
  - Rename propagates to a second device / the passive poll -> traces to `ChatState.withFreshTeams`
    (Phase C), which self-heals from any server-supplied value and rides the existing
    `TEAMS_REFRESH_MS` loop.
  - Sharing rows are label-sorted from both entry points -> traces to `Sharing.kt`'s Phase D
    `collectAsState()` reactivity and label-keyed sort.
  - Two same-labeled tabs show qualified titles, not a bare hex id -> directly covered by
    `TabLabelForTest.kt` (6 cases, including the collision-exhaustion regression), the strongest of the
    five since it is an executed automated test rather than a trace.
  - `crosstalk_discover` shows "name (opaque-id-address)" -> traces to
    `src/mcp/bridge/bridgeDiscover.ts` (`t.sessionLabel ? \`${t.sessionLabel} (${address})\` : address`).
    This formatting predates this plan and no phase touched the file, so it is a regression check, not
    new behavior. It has zero automated coverage before or after this plan (`bridge-discover.test.ts`
    only covers `relativeAge`); the file was left as-is rather than refactored into independently
    testable pieces purely to backfill coverage, since Phase F is a verification checklist against
    already-shipped logic, not a mandate to refactor untouched code.
  Net: of the four items that trace through Phases A-D's own changes, two carry a dedicated executed
  test (rename propagation via `ChatStateLabelsTest.kt`, tab qualification via `TabLabelForTest.kt`);
  the other two (the tile/spinner line, Sharing's label sort) rest on a source read with no test of
  their own, the same evidentiary tier as the pre-existing, untouched 5th item. None of the five could
  be watched happen on a live device in this environment - a quick on-device spot-check is the only way
  to close that gap fully.

**Red-team findings and fixes:** a red-team pass over the gate results themselves (not just their
wording) surfaced real gaps beyond the five checklist items. Three were in scope for this plan (each
traces to a specific phase's own mechanism) and are fixed; the rest are real but predate this plan or
sit in an unrelated subsystem, logged to `pain-points.md` instead of fixed here. A second red-team round
targeted at the three fixes themselves (this project's established pattern for a fix that could plausibly
introduce its own bug) then caught two real problems in the fixes as first written, corrected below.

Fixed:
- **Phase B's create-retry cache could silently collapse two distinct creates.** `recentSpawnOpIds`
  keys purely on `(project, label)`, so a second create fired for the same pair while the first was
  still resolving reused the first attempt's `opId` and reattached instead of creating a genuinely
  separate session - indistinguishable from the user's side from an ordinary single success. Fixed by
  tracking in-flight `(project, label)` pairs on `ChatState.pendingSpawns`: `SpawnDialog` now refuses to
  submit a label already mid-create for that project (button disabled, inline hint), so the ambiguous
  double-submit can no longer reach `spawnSession` at all. A genuine retry after the first attempt
  settles (success or failure) is unaffected. *Round 2:* the dialog's guard is a Composable snapshot, not
  a lock - two taps landing before a recomposition disables the button (or any future caller bypassing
  the dialog) could still slip through. Added a synchronous check-and-bail at the very top of
  `spawnSession`, before any suspension point; since a single-threaded dispatcher runs one coroutine's
  synchronous prefix to completion before starting another queued on it, this is a real guard, not
  another snapshot.
- **`sessionOrder` (the board's primary, "single most-viewed" comparator per this plan's own Phase D
  text) had zero test coverage**, unlike its sibling sort/label change `tabLabelFor` which got a
  dedicated 6-case file in the same phase. Made `sessionOrder` `internal` (the same visibility change
  `tabLabelFor` already got) and added `SessionOrderTest.kt`. *Round 2:* the initial 5 cases never
  isolated the activity-vs-label clause priority (no case put them in conflict) or exercised the
  raw-session-leaf fallback tier (every test team had a label or override). Added two more cases closing
  both gaps (7 total).
- **A rejected rename of a foreign-Gateway (federated peer) session was a silent no-op.** Phase C's
  foreign-Gateway guard correctly withholds the optimistic local write for a non-local target, but the
  function's only feedback branch (`reply?.renamed == false` reverting the optimistic write) was gated
  on `isLocal`, so a foreign target's explicit server-side rejection produced no revert (nothing to
  revert) AND no error message. First fix: ungated the transient-message branch from `isLocal`. *Round 2
  found this didn't actually close the motivating case*: the gateway refuses a foreign target as a
  **thrown error**, not a clean `renamed:false` reply (there is no local record to even consider renaming
  on a Gateway that does not own it), so `runCatching { ... }.getOrNull()` collapsed it to `reply = null`,
  and `null?.renamed == false` is `false` in Kotlin - neither branch ever ran for the actual foreign-target
  case, only for a narrower client/server disagreement edge case. Fixed by keeping the full `Result` instead
  of discarding it to `null`, and treating a foreign target's thrown failure the same as an explicit
  rejection (matching `spawnSession`'s own pattern of surfacing the exception's message directly). Round 2
  also found the message write sat outside the existing staleness guard (a superseded rejection could show
  "Could not rename" for a name no longer applied anywhere, once two overlapping renames raced) - fixed by
  only raising the message when a revert actually changed something.

Logged to `pain-points.md`, not fixed here (real, but predate this plan, belong to a different subsystem
than session id/label semantics, or are pre-existing architecture too broad for a proportionate fix in
this pass):
- A host-target `create_session` clears its in-flight marker as soon as the fast tmux-launch RPC
  returns, not once the Claude CLI inside actually boots and registers - so the spinner can drop to
  plain "available" mid-boot for a freshly spawned host session specifically (a devcontainer wake is
  unaffected; it correctly awaits `wakeCoordinator`). Wake-coordination timing, not id/label plumbing.
- `Sharing.kt`'s per-row share state (`shares`) and the "trust first" roster are populated once via
  `LaunchedEffect(Unit)` and only refreshed by the screen's own mutating actions, so they can desync
  from the live, poll-driven session/people lists while the screen stays mounted (e.g. a Domain link
  added or removed elsewhere). Pre-existing `Sharing.kt` reactivity gap; Phase D's `collectAsState()`
  change only touched the `sessions`/`people` derivation, not `shares`/`trustFirst`.
- Two rapid, different share toggles on the Sharing screen can transiently revert each other's checkbox
  state (a self-healing lost-update race in `refresh()`, no per-domain merge or debounce). Same
  pre-existing subsystem as above, low severity, self-corrects on the next `refresh()`.
- Phase B's "label had unsupported characters" Snackbar has gateway-side test coverage but zero
  Android-side coverage, and Phase F's checklist never exercises a forbidden-character label. No
  `ChatRepositoryTest.kt` or `androidTest` suite exists anywhere in the module to extend consistently
  (this codebase only unit-tests pure `ChatState` functions, never `ChatRepository`'s suspend/network
  functions), so building fresh test infrastructure for this one message would be disproportionate.
- Phase C's vanish-counter is verified as a pure function (`ChatStateLabelsTest.kt`), but the actual
  ~60s on-screen window it produces (a locally-labeled team that goes missing keeps showing its stale
  label for `ABSENCE_PRUNE_STREAK` poll cycles before pruning) is not independently verified and is not
  part of Phase F's checklist. Same testing-boundary reasoning as above.
- `transientMessage` (`ChatState`) is a single nullable field written by five independent async call
  sites (`spawnSession`, `closeTab`, `wakeSession`, and now two branches of `rename`) and drained by
  exactly one consumer that only exists in composition while the board, not a thread, is on screen - so
  a close-together pair of writes can conflate, and any write while a thread is open is invisible until
  the user backs out. Pre-existing architecture; the round-2 rename fix adds a fifth writer to it rather
  than redesigning it, since a queue or an app-scoped consumer touches all five call sites, not just the
  one being added.
- `pendingSpawns` has no expiry of its own (unlike `recentSpawnOpIds`'s 40s sweep) - a merely slow create
  blocks a retry of the same `(project, label)` for as long as the call takes to settle, bounded in
  practice by `ConsoleClient`'s own ~35-60s OkHttp timeouts, not truly unbounded but with no app-level
  bound tied to the field itself.
- `label()` takes a `localGatewayId` parameter its body never reads. Not a live bug, but `sessionOrder`
  and other callers pass `state.localGatewayId` to it as if it mattered.

## Phase G - crosstalk-side creation also gets a label + minted id

- `src/mcp/bridge/bridgeSend.ts : BridgeSendSchema` - add an optional `displayLabel` field (matching
  the existing `create_session` console op's field name for the same concept). Its zod `.describe()`
  is explicit and directive per the user's own framing ("instead of label address, call it 'Human
  Readable Label'. I don't want it filling in garbage machine labels."): "Human-readable label for the
  new session (a short human name like 'Bug Investigation', never a slug/id/machine-generated string)
  - required to create a not-yet-existing target; ignored when the target already exists." The field
  name stays camelCase for schema/API consistency; the human-readable framing lives in the description
  text an agent actually reads before filling it in.
- `src/gateway/routes.ts : send` / `src/gateway/index.ts : doWakeTeam` - when the resolved target has
  no existing record: `displayLabel` present -> mint an opaque id under the addressed spawn via the
  SAME mint-and-provenance path Phase A builds (one id-minting implementation shared by both the
  console's `create_session` and this path, not a second parallel one), `sessionLabel = displayLabel`,
  proceed with the send against the newly-minted address. `displayLabel` absent -> fail fast (`error`
  response, no silent typed-text-becomes-the-id adoption), telling the caller to retry with
  `displayLabel` set.
- `crosstalk_send`'s tool description and `crosstalk_discover`'s DESCRIPTION - both currently say "an
  asleep or not-yet-existing project.session is woken / created on send" - reword to describe the new
  `displayLabel`-required creation contract.
- This phase has not yet had a dedicated adversarial audit pass the way Phases A/C did (it was drafted
  after those laps closed) - give it extra scrutiny during implementation review rather than treating
  its design as settled.

## Non-goals (explicitly out of scope)

- `workdirHint` / a session's on-disk directory - stays frozen at creation from the label, same as
  today; not re-derived on rename. Renaming a session's display label should not `mv` its working
  directory.
- `crosstalk_send`/`wake` prefix resolution - stays a discovery-driven human/agent convention, no
  server-side short-id resolution added.
- Gateway/host-daemon log readability (raw id with no label in log lines) - real, accepted; no cheap
  fix without threading a label through every log call site.

## Painpoints

Collected by a Phase F crust-collection sweep (four parallel scouts over the Android app, the gateway's
console/routing layer, and the shared wire protocol), seeded with leads from this session's own red-team
rounds. Record only, not fixed - out of scope for this plan, or too broad for a proportionate in-pass fix.
Unlike `pain-points.md`'s entries, these were not run through a second, adversarial verify pass (the
crust-collection step is a scouting pass, not a full audit), so treat each as a lead to re-check before
acting on it, not a confirmed finding. Refs are `file : namespace : name`; severity in brackets.

**High:**
- [high] `android/.../ChatRepository.kt : isAdmin / confirmedDomainId / refreshDisplayNameFromTeams` -
  **dup-logic** - all three pick "my own Team" from `state.teams` using gateway-id equality alone, no
  domain check (`(it.gatewayId.ifEmpty { gw }) == gw`) - the same class of gap `rename()`'s isLocal guard
  was written to close, and the sibling `shareableSessions()` a few lines below already ANDs a domain
  check in. Since a gateway id is only unique within a Domain (documented elsewhere in this same file) and
  defaults to the sanitized hostname, a linked peer's gateway coincidentally sharing your own gateway id
  string could make these three silently report the peer's domain id / admin flag / display name as your
  own - most dangerous if the colliding peer happens to be the admin you're a guest of.
- [high] `android/.../ChatRepository.kt : ChatState.gap` - **bug-class** - set to `true` on a dropped-
  mailbox-entries pulse but never reset anywhere (no matching `false` write, unlike `transientMessage`'s
  `consumeTransientMessage()`), even though the pulse that set it (`SyncCursor.advance`'s edge-triggered
  `gap`) resolves itself the very next poll cycle. The sticky "Some messages were dropped" banner it drives
  has no dismiss action, so the first mailbox-eviction event a device ever experiences leaves that banner
  on screen for the rest of the process's life.
- [high] `android/.../ChatRepository.kt : setDeviceName` (found independently by two scouts) - **bug-
  class** - fired the same fire-and-forget way as rename/closeTab/wakeSession/forget
  (`scope.launch { repo.setDeviceName(it) } }`, no CoroutineExceptionHandler anywhere in the app), but
  unlike its neighbor `provision()` - whose own comment explains it wraps its JSON parse specifically
  because "callers launch this from coroutines with no catch" - `setDeviceName` does not wrap its
  `JSONObject(blob).put("device", name)` at all. A corrupted stored provisioning blob throws uncaught and
  crashes the app on a routine device rename.
- [high] `android/.../TrustCompareScreen.kt : DisposableEffect(Unit).onDispose` - **bug-class** - cancels
  the rendezvous via `scope.launch { repo.trustCancel(...) }` on the plain `rememberCoroutineScope()`
  `scope`, which Compose cancels as part of the same disposal pass - so the cancel very likely never runs.
  Two sibling ceremonies (`LinkWizard.kt`, `EnrollCeremonyScreen.kt`) hit and fixed this exact bug by
  moving their own onDispose cancel onto `GlobalScope.launch` with a "must outlive this composable"
  comment; `TrustCompareScreen.kt` never got the same fix, so backing out of a trust compare leaves the
  rendezvous open until its own TTL sweep instead of tearing down immediately.

**Medium:**
- [medium] `src/gateway/console/consoleHandler.ts : dispatch` - **framework-first** - `rename_session`'s
  case body opens with the identical validate-target-and-resolve-name preamble already known to be
  hand-copied between `forget`/`close_session`; a third copy, same fix (`requireNamedLocalSession`
  helper) would close all three at once.
- [medium] `src/gateway/wake.ts : WakeCoordinator`, `src/gateway/hostOpCoordinator.ts : HostOpCoordinator`,
  `src/gateway/evie/evieClient.ts`'s `pendingCalls` - **framework-first** - three independent hand-rolled
  copies of the same "keyed waiter map with a timeout and a fail-all" primitive, aware of each other only
  through prose comments cross-referencing the siblings rather than one shared `Correlator<T>`.
- [medium] `src/gateway/routes.ts : send`, `src/gateway/console/consoleHandler.ts` (3 sites) - **framework-
  first** - the "is this address actually mine" `t.domain !== localDomain || t.gateway !== localGatewayId`
  check is hand-copied 5 times across the gateway (plus a 6th, independent copy in the Android client's
  `rename()`); `Address`/`SpawnPoint` have an `equals()` but no `isLocal(domain, gateway)` method to own
  the comparison once.
- [medium] `android/.../ChatRepository.kt : closeTab/wakeSession/forget` (vs `rename`) - **bug-class** -
  all three gate on gateway-id equality alone (no domain check), the exact gap `rename()`'s own doc
  comment names and fixes for itself; `forget` is the most consequential since it's the most destructive
  op of the three.
- [medium] `android/.../ChatRepository.kt : send/retrySend/deliver(fail)` vs `ChatState.transientMessage`
  - **bug-class** - these write one-off send-failure text into the STICKY `error` field instead of
  `transientMessage`, the exact violation `transientMessage`'s own doc comment warns against ("would bleed
  into an unrelated later health render"); `error` is only cleared at connection-lifecycle events, so a
  failed send's text can linger in the connection-health banner well past the failure.
- [medium] `android/.../ChatRepository.kt : ChatState.needsGateway` and `MainActivity.kt`'s ThreadScreen -
  **legacy-landmine** - two independent places pattern-match the free-text `error` string to recover a
  `ConnKind` classification (a `.startsWith("Add a Gateway")` check and a separate `.endsWith("retrying")`
  convention) instead of storing the enum itself; the two conventions are already inconsistent with each
  other's assumptions (some TRANSIENT messages don't end in "retrying").
- [medium] `android/.../MainActivity.kt : SessionsScreen`'s `SpawnDialog` call site - **bad-naming** -
  the one hop where the typed-label value is destructured as `session` instead of `label`, inviting a
  reader to treat pre-sanitization user text as a stable session id; every other hop of the same value
  (App's `onSpawn`, `spawnSession`'s own parameter) calls it `label`.
- [medium] `android/.../ConsoleClient.kt : listTeams` - **dead-code** - zero call sites anywhere in the
  repo (Kotlin or TS); every real caller uses `teams()` directly. Leftover from a migrated-away call site.
- [medium] `android/.../HostNetworks.kt`, `Management.kt`, `LinkWizard.kt` - **dup-logic** - three
  independent clipboard-copy implementations for the same user action (two hand-rolled via the old
  `ClipboardManager` API, one via the newer `LocalClipboard`), where a shared home for this exact
  composable family (`Federation.kt`) already exists.
- [medium] `android/.../Sharing.kt : SharingScreen.onToggleDomain` - **bug-class** - discards the result
  of its everyone-clear call entirely (no `.onFailure`/`.getOrThrow()`) before unconditionally applying
  the specific-share write, unlike the sibling `applyMode()` branch that `.getOrThrow()`s the identical
  call so a failure aborts the whole operation; a transient failure here can leave a session shared to
  both "everyone" and a named person at once, the exact overlap a neighboring comment says must never
  happen.
- [medium] `android/.../CrossDomainLink.kt : mergeLinkedDomains`'s `adminDomain` parameter - **bad-
  naming** - actually means "my own confirmed domain id" (fed from `confirmedDomainId()`), not the
  network's privileged admin Domain that `Team.isAdminDomain` (a different, wire-stamped field) refers to
  elsewhere in the same federation/cross-domain code - easy to conflate given how similarly they're
  spelled and how close together they live.
- [medium] `android/.../AppStateStore.kt : saveGatewayId`'s doc comment - **legacy-landmine** - describes
  the pre-migration `(gatewayId, name)` composite-key grammar this repo's own CLAUDE.md documents as
  retired, but the field is still load-bearing today for a different, undocumented purpose (the persisted
  fallback `ConsoleClient.kt` reads to resolve which Gateway to seal a relay op to before a fresh register
  re-learns it) - a maintainer trusting the stale comment could conclude it's dead and remove it.
- [medium] `android/.../Management.kt : AddGatewayScreen`'s Approve action (one instance of a ~9-site
  pattern) - **framework-first** - every async screen action hand-rolls its own busy/status state plus a
  bespoke `scope.launch{}` with no shared "always reset busy, always surface a message" helper; Approve
  specifically has no try/catch around a call that documents itself as intentionally throwing on a
  corrupt stored key, so that failure leaves the button stuck on "Enrolling..." forever with no error
  shown.
- [medium] `scripts/codegen-kotlin.ts : SEALED_ROOTS`'s `CrossDomainShareTargetSchema` entry - **bug-
  class** - listed as sealed (encode-side-only, per the file's own header rule) but the same schema is
  also embedded decode-side inside a gateway reply; today's Android callers happen to wrap the decode in
  `runCatching` so it fails safe, but the day a new variant ships, every not-yet-updated console's share
  checkmarks and counts will fail to decode at all - the exact forward-compat break this file's own rule
  exists to prevent everywhere else.
- [medium] `src/shared/schemas.ts : ResponseStatusSchema` - **dead-code** - documented as "the single
  truth" for response-status wire enums but never actually `.parse()`d anywhere; every real status field
  is a bare `z.string().optional()`, and at least one consumer's own comment admits the gap this schema
  was supposedly there to close ("an absent status would otherwise fall through silently").

**Low:**
- [low] `src/gateway/index.ts : doWakeTeam/relayToHost` - **dup-logic** - both hand-roll the identical
  "find the host daemon's live socket" two-liner that `websocket.ts`'s existing `getAllActiveWs(subs)`
  already does (and `routes.ts` already reuses).
- [low] `src/gateway/console/consoleHandler.ts : dispatch`'s `create_session` case - **bad-naming** - its
  local `sessionId` holds a short leaf id, while `sessionId`/`session_id` means the fully-qualified store
  key everywhere else in the same switch statement.
- [low] `src/shared/session-store.ts : SessionStore.restore` - **legacy-landmine** - its one-shot legacy-
  migration branch (marked for deletion "once every gateway has re-written session-resume.json") has no
  version sentinel gating it, unlike the codebase's other one-shot migration (a persisted schema-version
  file); it shape-sniffs on every boot indefinitely with nothing verifying its own removal precondition.
- [low] `android/.../ChatRepository.kt : ChatState.label`'s `localGatewayId` parameter - **dead-code** -
  never read in the function body; all 8 call sites thread a gateway id through for nothing.
- [low] `android/.../MainActivity.kt : SessionCard` - **dup-logic** - hardcodes `Color(0xFFD29922)` and
  `Color(0xFFDA3633)` for the verifying/working/check-terminal chip colors instead of calling
  `presenceColor(...)`, the function documented as the single owner of this exact vocabulary, which
  already yields the identical values.
- [low] `android/.../ChatRepository.kt : firstRootIfPending` - **dup-logic** - the durable
  `store.firstRooted` and the in-memory `ChatState.firstRooted` must be kept in sync by hand at each of
  four call sites instead of one setter writing both; holds today only because of call-site discipline,
  not a structural guarantee.
- [low] `android/.../proto/SessionId.kt : ParsedSessionName.project` - **bad-naming** - names the address's
  `spawn` segment `project`, while every sibling type in the same file spells the identical concept
  `spawn`; the two vocabularies meet only positionally at one call site with same-typed arguments, so a
  future field reorder could silently swap segments with no compiler error.
- [low] `android/.../SttsPlayer.kt : currentKey/currentTeam/currentAt` - **bug-class** - "what's playing
  now" is three separate `@Volatile var`s updated together only under `@Synchronized` writers, while the
  Compose-thread reader path reads all three unsynchronized - a torn read mid-transition can show a
  momentarily wrong play/stop glyph. One atomic `@Volatile var current: NowPlaying?` would close it.
- [low] `src/shared/schemas.ts : TeamInfoSchema.queue_depth` - **dead-code** - the lone snake_case field
  in an otherwise camelCase schema; both producers hardcode it to `0`, and the one consumer that branches
  on it (`bridgeDiscover.ts`) can never take its "busy" arm. Decoded and stored on the Android side too,
  but read by nothing.
- [low] `src/shared/types.ts : RegisterMessage, CatalogMessage` - **legacy-landmine** - zero references
  anywhere in the repo; `RegisterMessage` has also drifted from the real wire schema it once mirrored
  (missing several fields `WsRegisterSchema` has since gained), and `CatalogMessage` describes a message
  shape from the retired CLI-dispatch protocol.
- [low] `src/shared/session-id.ts : isConvId/MAX_CONV_ID_LEN` vs `src/shared/host-op.ts`'s
  `CONVERSATION_ID_RE`/`MAX_CONVERSATION_ID_LEN` - **dup-logic** - two independently-defined,
  byte-identical-today validators for the same conversationId concept; tightening one silently stops
  being enforced by the other.
- [low] `src/gateway/routes.ts : send/resolveLocalTarget` - **dup-logic** - both parse the same `to`
  string and re-run the identical SpawnPoint-reject-plus-locality check independently; a third,
  independent copy of the same rule lives in the Android client's `rename()`.
- [low] `src/shared/schemas.ts : MailboxEntrySchema/ChannelReplySchema`'s `session_id` field - **bad-
  naming** - actually the fully flattened `storeKey()` output (a 5-6 segment compound job/store
  correlation key), not the `Address.session` single-segment concept the name suggests to a reader
  familiar with `session-id.ts`'s grammar.
- [low] `src/shared/schemas.ts : ConsoleRegisterResultSchema.domainStatus` - **dead-code** - computed,
  wired, and codegen'd, but zero reads anywhere in the Android app; the app's actual first-root decision
  is driven by the provisioning blob's `pendingTenant` field instead, per this repo's own CLAUDE.md.
