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

## Phase E - gateway: no wire-schema change needed

`ConsoleOp.createSession`'s `sessionName` is already optional on the wire - this is a client-behavior
change only (stop sending it), not a schema change. Phase A's new `mintedFrom` field lives on
`SessionRecord`, which is gateway-internal/persisted-only (never serialized to the app), so it is not
a wire type either - no Kotlin codegen run needed for either change. Confirm both hold once Phases A/B
land (re-check `schemas.ts` and `codegen-kotlin.ts` output unchanged).

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
