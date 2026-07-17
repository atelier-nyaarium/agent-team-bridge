# Console hardening (extracted from the idle-pushback crust sweep, prioritized)

The four above-low items from `plans/pain-points.md`'s idle-pushback section (2026-07-16),
extracted here as a real plan. The three low/cosmetic siblings (ENROLL_POLL vs evie-bot TTL, the
SwitchboardService notification extraction, the `Repo.get` relocation) stay in pain-points.md.

Phases A and B are independent. C is a prerequisite for D: consolidating the duplicated
request shape first means the transport change in D lands in 2 chokepoints instead of 10
(relay + the 9 migrated members; the 2 intentionally-left-blocking calls are never converted).

Refined through a plan-refinement cycle, two audit rounds (see `## Audit` at the bottom):
round 1 found two blockers (Phase B's original pin guarded the wrong relationship; Phase D's
original rationale ignored that the poll loop's catch swallows CancellationException) plus a
live disk leak Phase A must now cover; round 2 then overturned three of the round-1 rewrite's
own designs (the reconcileSent delete rule, the sweep's race guard, and the conditional
defense-removal framing). Everything below is the post-round-2 state.

## Phase A - `forget(team)` per-team attachment purge (privacy)

**Facts (from code, audit-corrected):**

- Attachments live under `filesDir/attachments/<bucket>/`. Inbound buckets `"<epoch>-<seq>"`
  (`Attachments.decode`) are structurally entry-unique: one mailbox entry lands in exactly one
  thread, and a gateway peer-mirrored exchange is two separate entries with two separate buckets.
  Outbound buckets `"out-<System.currentTimeMillis()>"` (`Attachments.storeOutgoing`) are only
  wall-clock-keyed - nothing structural prevents two concurrent sends to different teams landing
  in one bucket. Today's single-composer UI serializes sends, so no collision exists in practice,
  but the delete mechanics below must not assume bucket-per-team.
- **The rows are NOT a complete index of on-disk buckets** (audit round 1, verified): on the
  sending device, `send()` stores the optimistic echo's files in an `out-<ms>` bucket, then the
  gateway mirrors the send back as a `sent` entry whose bytes decode into a second `<epoch>-<seq>`
  bucket, and `reconcileSent` REPLACES the optimistic row in place (`it[idx] = echo.copy(...)`,
  ChatRepository.kt reconcileSent). After the replace nothing references `out-<ms>` - it is an
  orphan that today survives until a full `clearAll`. This is a live leak on every
  attachment-bearing send, independent of forget.
- **`sentEchoMatch` gives the replace THREE distinct old/new bucket shapes** (audit round 2,
  verified) - any bucket-deletion rule must be correct on all three: (1) first drain: old row
  references `out-<ms>`, echo references `<epoch>-<seq>`; (2) same-`(epoch, seq)` re-drain fold:
  the old row was ALREADY upgraded, old and new reference the SAME `<epoch>-<seq>` bucket -
  deleting "the old row's files" here destroys files the replaced row still needs; (3) fresh-seq
  re-send fold (opId match across a gateway restart): old references `<epoch>-<seq1>`, echo
  references `<epoch>-<seq2>` - the orphan is an inbound-style bucket, not an out-bucket.
- A `sent` mirror that is byteless or partial is NOT currently producible (audit round 2 traced
  the full path: `ConsoleClient.send` base64-encodes every file unconditionally, the gateway
  mirrors `op.files` verbatim, and only the reply path strips bytes) - so per-file byteless
  handling below is defensive future-proofing, not a live-bug fix. The live bug on the replace
  path is shape (2) above.
- `forget()` drops rows in MULTIPLE threads, not just `threads[key]`: `threadsAfterForget`
  removes the team's own thread AND sweeps every remaining thread for peer-mirror rows
  (`it.isPeer && (it.from == key || it.to == key)`). The purge set must cover all of them.
- `forget()`'s existing `pollScope?.launch(Dispatchers.IO)` is INSIDE
  `if (t is Address && t.gateway == localGatewayId)` - correct for the gateway RPC (a remote
  session has no local record to forget), wrong for file deletion (the files are local no matter
  where the session lives). **The delete must run in its own unconditional IO launch, never
  nested in that gate.**
- `MessageFile.src` is `"https://appassets.androidplatform.net/attachments/<bucket>/<name>"`;
  extraction idiom: `src?.substringAfter("/${Attachments.DIR}/", "")` +
  `Attachments.resolve(filesDir, rel)` (traversal-safe, see `rebuildFiles`).
- Drafts are `Map<String, String>` (text only) - no file refs outside thread rows, except the
  latent case below.
- Latent: the drain runs `Attachments.decode` for every entry BEFORE the kind branch, so a future
  `plugin_action` entry carrying files would materialize a bucket no row ever references. Not
  triggered today (Designer's plugin_action carries no files); the sweep below covers it.

**Fix direction (three pieces, one mechanism each):**

1. **Row-derived purge on forget:** restructure `threadsAfterForget` to also return the dropped
   rows (shared predicate, never a hand-copied second one). Map dropped rows' `files[].src`
   through the existing rel-extraction + `resolve()` idiom. Delete per-file; remove a bucket dir
   only when it is empty afterward. NEVER `deleteRecursively()` a bucket derived from a row - a
   colliding out-bucket could hold a sibling team's file. Unconditional IO launch (see facts).
2. **Kill the ongoing out-bucket leak at its source, with a SET-DIFFERENCE rule (audit round 2
   corrected the round-1 "delete the old out-bucket" wording, which was wrong on two of the
   three replace shapes):** extract a pure module-level function (the `threadsAfterForget`
   pattern - Context-free, so Phase A's tests never need a ChatRepository instance):
   `(oldFiles, echoFiles) -> (mergedFiles, deletePaths)`. Pair files BY NAME (both sides derive
   names through the same `safeName` + `uniqueName` chain, so names are stable; index pairing
   drifts when a `storeOutgoing` write fails and `mapNotNull` drops it). Per pair: an echo file
   with a non-null `src` wins (its src goes into merged; the old copy becomes deletable); an
   echo file with null `src` keeps the old row's src (stays referenced, never deleted).
   `deletePaths` = old files' paths MINUS merged files' paths - on shape (1) that is the
   out-bucket copies, on shape (2) it is EMPTY (old == new, nothing deleted, no data loss), on
   shape (3) it is the orphaned `<epoch>-<seq1>` copies. `reconcileSent` then replaces with
   `echo.copy(id = old.id, files = merged)` and deletes `deletePaths` on an IO hop.
3. **Orphan-bucket sweep as the completeness backstop:** on cold start, run the sweep TO
   COMPLETION strictly BEFORE `startPolling` in the same startup coroutine
   (`connect(); reconcilePending(); sweep(); startPolling(scope)`) - the dangerous race is not
   the send store-then-append gap (append persists synchronously) but a PRIOR session's
   decoded-but-uncommitted inbound bucket: unreferenced and old at enumeration time, then
   re-referenced by the two-phase re-drain before a concurrent sweep's delete lands. Sequencing
   before the poll loop eliminates that interleave outright; if the sweep is ever made
   concurrent instead, it must re-stat mtime AND re-check referenced-set membership immediately
   before each delete. Mechanics: enumerate `attachments/*` bucket dirs, compute the
   referenced-bucket set from ALL surviving rows across threads, delete unreferenced buckets.
   Age guard: dir `File.lastModified()` (updates on child create/rename/delete, which is the
   right signal for these append-only buckets); skip buckets younger than a generous threshold
   (e.g. 10 min) as a backstop for any not-yet-persisted reference; treat `lastModified() == 0L`
   (stat error) as UNKNOWN - never delete-eligible - since 0L would otherwise read as ancient.
   This heals: historical reconcileSent orphans, crash-between-persist-and-delete windows (the
   row shrink is durable via `apply()`, the file delete is a best-effort coroutine - a kill in
   between leaks until the next sweep, an accepted-and-healed posture rather than a permanent
   one), and any future decode-without-row case (plugin_action).

**Tests:** keep the dropped-row derivation pure (the `threadsAfterForget` test pattern); the
merge/delete rule of piece 2 is a pure function - test all three replace shapes (out-bucket
deleted; same-bucket fold deletes NOTHING; fresh-seq fold deletes the old inbound copies) plus
the byteless/partial arms; temp-dir JVM tests on the delete helper (dropped row's files gone,
sibling bucket untouched, empty dir removed, occupied dir kept) and the sweep (orphan deleted,
referenced kept, young-bucket skipped, zero-mtime kept). All of these are pure logic +
`java.io` (org.json is already a real test dependency if row shapes are needed) - Phase A's
tests depend on nothing from Phase C, keeping "A and B in either order" true.

## Phase B - long-poll timeout chain: pin the BINDING same-repo relationships

**Facts (from code, audit-corrected):** the chain, in required strict order:

| layer | value | where | notes |
|---|---|---|---|
| client requested hold | 40s `LONG_POLL_HOLD_MS` | `ChatRepository.kt` | client-side; the gateway has no 40s knob |
| gateway hard gate | 45s | `src/shared/schemas.ts` `holdMs: ...max(45_000)` | zod REJECTS a larger hold outright (every foreground poll would throw) |
| gateway defensive cap | 45s `HOLD_CAP_MS` | `src/gateway/console/consoleHandler.ts` | `Math.min` - identity for every schema-valid value, so it can never actually truncate; redundant layer |
| evie relay hold | 55s | evie-bot repo | comment only (verified absent from this repo) |
| client held read timeout | 58s = `holdMs + 18_000` | `ConsoleClient.poll` | foreground only; background (hold=0) polls use the base 35s read timeout |
| apiserver proxy | 60s | untracked infra config | comment only |
| client held callTimeout | ~83s = read + margin + connect | `ConsoleClient.poll` | deliberate backstop ABOVE every other layer; only binds on a pathological slow-trickle |

**The binding constraint** (audit round 1 blocker): the client's held read timeout must return
before the proxy resets the socket - `LONG_POLL_HOLD_MS + 18_000 < 60_000`, i.e. hold < 42s. The
originally-proposed `hold < cap(45s)` pin left [42s, 45s) green while the real ordering
inverted. Note `DEFAULT_RELAY_CALL_TIMEOUT_MS` evaluates to exactly 60_000 - coincidence, not a
constraint; do not "unify" them.

**Fix direction:**

- Name the margin: the bare `18_000` in `ConsoleClient.poll` becomes a named constant
  (e.g. `HELD_READ_MARGIN_MS`). **Visibility (audit round 2): the pins below read ConsoleClient
  companion constants from separate test classes, so `HELD_READ_MARGIN_MS`,
  `PINNED_CONNECT_TIMEOUT_MS`, and `CALL_TIMEOUT_MARGIN_MS` must be `internal`, not `private`
  (the ChatRepository companion already made exactly this move for the same reason - copy its
  explanatory comment style). As `private` the prescribed tests do not compile, and that is the
  grep-invisible Kotlin breakage CI cannot catch.**
- Add a documented ceiling constant `PROXY_CEILING_MS = 60_000` (internal, in ConsoleClient's
  companion beside the margin it bounds) whose comment states it mirrors untracked infra
  (documentation-as-code: an infra change must update it) - then pin
  `LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS < PROXY_CEILING_MS` in `ChatRepositoryConstantsTest`
  (the current 58 < 60 headroom is deliberately thin; pin strict `<` and say so).
- Unify the gateway's two independent 45_000 literals: define ONE exported constant in
  `schemas.ts`, use it in the zod `.max()`, and import it into consoleHandler as `HOLD_CAP_MS`
  (keep the now-derived `Math.min` as a harmless belt - audit round 2 verified the schema parse
  strictly precedes every read of `op.holdMs`, so the min never truncates a valid value; its
  comment updates to say the schema is the real gate, and the chain-restatement rationale
  currently on `HOLD_CAP_MS` moves with the surviving comment, not deleted). No import cycle:
  consoleHandler already imports from schemas.ts, and schemas.ts imports nothing from gateway/.
  Pin `LONG_POLL_HOLD_MS <= <that constant>` from both sides (`<=`: `Math.min`/`.max` honor
  equality) in the two constants-test files that already do this for other pairs.
- Also pin the client's internal derived ordering: held callTimeout > held read timeout > hold
  (pure arithmetic on the now-internal ConsoleClient constants; a bare JUnit test).
- Update ALL THREE in-repo prose restatements of the chain to point at the pins:
  `ConsoleClient.poll`'s comment, consoleHandler's hold-cap comment (wherever it lands per the
  unification above), and `src/gateway/index.ts`'s `HOST_OP_TIMEOUT_MS` comment
  ("evie ~55s, apiserver 60s").
- The 55s evie layer stays comment-only; add an evie-bot-side pin whenever next in that repo.

## Phase C - consolidate the 10 duplicated evie-direct request shapes

**Facts (from code, audit-verified):** the evie-direct membership is exactly `enroll`,
`postConsoleApproval`, `firstRoot`, `requestGatewayTransport`, `enrollHandshake`, `roster`,
`trustHandshake`, `trustPending`, `provisionTenant` (members) + companion `postPublicApproval`.
Nothing on the list uses `relay()`; no evie-direct member was missed; `apiReachable` is correctly
excluded (single-header GET /health that throws, a different shape).

**The RETURN contract is byte-identical across all 9 members** (steps 5-6: 2xx decode-or-
"unexpected response"; non-2xx typed-body THEN BounceBody.error THEN "HTTP code" fallback, in
that order). The consolidation is sound. The TELEMETRY is not identical - the exact deviation
ledger (audit round 1, each verified):

- POST log line present in 5 (enroll, postConsoleApproval, firstRoot, enrollHandshake,
  provisionTenant), absent in 4 (requestGatewayTransport, roster, trustHandshake, trustPending).
- trustHandshake + trustPending share tag `"Trust"` and disambiguate ONLY via `"handshake"` /
  `"pending"` prefixes on their transport-error and resp lines.
- provisionTenant has NO try/catch around execute() (a transport throw propagates unlogged),
  reuses tag `"Enroll"`, and prefixes its resp line `"provision resp"`.
- Body truncation splits 120 (enroll, provisionTenant) vs 160 (the other seven).

**Fix direction:** one private helper, roughly
`inline fun <reified R> postEvieDirect(tag: String, describe: String, body: RequestBody, fail: (String) -> R): R`.
**Decision (made): normalize the telemetry rather than parameterize it** - the variance is
accidental drift, not design; it is debug-log-only surface. The helper emits all three log lines
(POST, transport-error, resp) in one consistent format, with `describe` woven into each line so
the Trust pair (and provisionTenant vs enroll) stay distinguishable; one truncation length (160).
Document in the commit that 4 sites gain a POST line, provisionTenant gains transport-error
logging (both strict improvements), and the line formats normalize. The RETURN-path decode order
must be preserved exactly - that is the behavior contract.

`postPublicApproval` is deliberately LEFT OUT (different client, no auth headers, no
isSuccessful branch); it keeps a comment naming this. Migrate the 9 members one at a time,
each diffed against the ledger above.

**Verification (audit round 1 upgraded this from red-team-only to required tests):**

- Add `testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")` (same version as the
  pinned okhttp).
- Add `testOptions { unitTests.isReturnDefaultValues = true }` - without it, `DebugLog.log`'s
  `android.util.Log.d` throws `RuntimeException("Stub!")` in any pure-JVM test that touches
  ConsoleClient paths. (Existing tests touch no Android API; unaffected.)
- Shape `postEvieDirect` to be drivable without a Context-backed ConsoleClient (take the
  OkHttpClient + url + headers as parameters, `internal` visibility), then a MockWebServer
  matrix test pins the decode contract: 2xx typed; non-2xx with typed body -> typed result
  (FIRST); non-2xx with only `{error}` -> bounce error; non-2xx with neither -> "HTTP code"
  fallback. This is the test the build gates structurally cannot replace: a decode-order
  transposition is type-identical Kotlin that compiles clean.

**Payoff:** Phase D's transport change becomes 2 edits (relay + this helper) instead of 10, and
so does every future fix to the shape.

## Phase D - cancellable transport (the root cause behind the teardown defenses)

**Facts (from code, audit-corrected):**

- Every ConsoleClient network call is blocking `OkHttp Call.execute()`; no `suspend` in the file.
  `relay()` serves ~21 of ~32 internal sites; after Phase C, `postEvieDirect` serves 9 more.
  `apiReachable` and `postPublicApproval` are the two remaining execute() calls - **intentionally
  left blocking** (bounded: connect 15s + read 35s/20s; `postPublicApproval` also has a 40s
  callTimeout), named here so "2 edits" is honest.
- All external call sites live in `ChatRepository.kt`; `SwitchboardService.kt`/`SttsClient.kt`
  reference ConsoleClient in comments only (verified). No public non-suspend ChatRepository
  entry point changes: the launch-wrapped ones (`closeTab`, `wakeSession`, `forget`) stay
  non-suspend, the rest are already suspend - **zero Compose-side ripple** (audit-verified).
  Four PRIVATE helpers do need `suspend` added: `deliver()`, `firstRootIfPending()`,
  `submitConsoleAdmission()`, `submitOwnerFact()` - and `submitOwnerFact`'s parameter type
  changes to `submit: suspend (T) -> EnrollResult`. All compiler-forced, all terminate in
  already-suspend callers.
- **The blocker the audit caught:** the poll loop's `catch (e: Exception)` (and 18
  `runCatching { client()... }` sites) would SWALLOW the CancellationException a cancellable
  call throws. JVM CancellationException extends Exception; `runCatching` catches Throwable.
  A swallowed cancel today would set `failed = true`, fall through to `pushback.decide(...,
  lastPassFailed = true)`, and in the MINUTE tier run `exitDeepSleep()` ->
  `acquireWakeLock()` - re-acquiring an UN-TIMED wakelock after onDestroy already released it.
  Cancellability delivers its unwind ONLY with the rethrow discipline below; without it the
  change is worse than useless.
- The per-call config added 2026-07-16 must survive: `send()` opts out of callTimeout
  (`callTimeoutMs = null`) for its unbounded upload; `poll()` derives both timeouts from its
  hold. Because send() has no callTimeout, ANY error path that fails to resume its continuation
  hangs that send FOREVER - the wrapper's error-routing is load-bearing, not a nicety.

**Fix direction (one commit, all of it):**

1. **The wrapper:** `suspendCancellableCoroutine` around `enqueue()` with
   `invokeOnCancellation { call.cancel() }`. Inside `onResponse`, read the status + full body
   text within `resp.use { }` and resume with that small value; do ALL parsing/unsealing after
   resume on the caller's dispatcher. Wrap the read in try/catch and route every failure to
   `resumeWithException`. Reading-to-String inside the callback makes the cancel race leak-free
   (once the body is consumed and closed, a no-op resume abandons only a String) and keeps all
   socket I/O on OkHttp's pool regardless of the caller's dispatcher (execute()'s
   NetworkOnMainThreadException tripwire is lost either way; this recovers the safety it
   provided). `onFailure` -> `resumeWithException`.
2. **Suspend propagation:** `relay()` and `postEvieDirect()` become suspend; public functions
   become suspend; the four private ChatRepository helpers + `submitOwnerFact`'s functional
   parameter as listed above.
3. **Cancellation-rethrow discipline (load-bearing, same commit):** the poll loop's catch gains
   a CancellationException rethrow as the FIRST statement of the catch (ahead of the HTTP-504
   branch, so both branches are provably covered; `classifyConnError` must never see one); sweep
   the 18 `runCatching { client()... }` sites and make each rethrow cancellation
   (`.onFailure { if (it is CancellationException) throw it }` or convert to try/catch). The
   main-catch rethrow closes the cancel-surfaces-as-exception route to `decide()`; the
   runCatching sites are hygiene ensuring no swallowed cancel anywhere. Optionally add an
   `ensureActive()`/`isActive` break at the top of the loop tail (before `decide()`) - it
   narrows the residual window below but can never close it.
4. **Comment sweep (same commit) - SURGICAL, not wholesale (audit round 2):** each of these
   comments' stated MECHANISM ("poll is blocking, scope.cancel() cannot interrupt") dies with
   the transport change, but the destroyed-flag comments' CONCLUSION ("the loop can still run
   one more decide() after onDestroy returns") remains true via the non-suspend tail (below) -
   rewrite the reason, keep the conclusion and the defense justification. Sites:
   SwitchboardService.kt's destroyed-flag block and onDestroy comments (rewrite mechanism to
   the non-suspend-tail rationale); ChatRepository.clearAll's cancelAndJoin rationale (the JOIN
   stays - it still serializes the post-poll drain against the state reset - but the stated
   worst case changes from "waits out the call timeout" to "returns on cancel unwind");
   SttsClient.kt's "Blocking OkHttp like ConsoleClient" analogy (SttsClient stays blocking by
   design; the cross-reference is what dies); ConsoleClient's own class/relay/poll/send KDocs;
   CLAUDE.md's idle-pushback section if it restates blocking-ness.
5. **Explicitly NOT touched:** `IdlePushbackManager`'s PASS_*/BURST_JOIN constant math - it
   sizes wall-clock completion of a normally-finishing pass (the enqueue path consumes the same
   wall-clock; the wakelock must stay up for the round trip regardless of which thread waits),
   and BURST_JOIN bounds STTS work, not transport (audit-verified; do not "re-derive").

**The teardown defenses are PERMANENT - there is no later removal commit (audit round 2
overturned round 1's conditional-removal framing):** Kotlin cancellation is cooperative, and
`decide()` is a non-suspend call sitting after the try with no suspension point between the
try's close and the `decide()` call. A cancel that lands in the loop's non-suspend tail (drain
bookkeeping, the empty-burst common case, the try-exit gap) completes the try NORMALLY - no
exception, the catch and its rethrow never run - and `decide()` executes to completion,
scheduler side effects included. No rethrow, and no checkpoint placed before `decide()`, can
make "decide() unreachable after cancel" true (a cancel arriving between any check and the
call still lets the non-suspend `decide()` finish). Cancellability therefore shrinks the
stale-decide window from an entire blocking poll round trip to these tail instants, but the
destroyed flag + scheduler-null write remain the mechanism that makes the residual harmless -
they stay, with their comments rewritten per step 4. **The alarm-PendingIntent revival path
(PollAlarmReceiver + companion passLock) is likewise untouched - a system kill skips onDestroy
entirely and revives a fresh process; it was never defended by cancellation in the first
place.**

**Verification:** MockWebServer tests (on Phase C's infrastructure): a cancellation test
(server holds the response; cancel the calling job; assert the OkHttp call is cancelled and the
coroutine unwinds promptly instead of waiting out the timeout) and a per-call-timeout test
(delayed body > callTimeout -> throws). Plus both build gates, as always.

## Notes

- All four phases are Android-console-side plus small same-repo TS edits in B. No user-facing
  UX decisions anywhere - straight to `audited-implementation` cycles per phase when picked up.
- Order: A and B in either order (independent, and A's tests deliberately depend on nothing
  from C); C strictly before D. ALL of Phase D (transport change, rethrow discipline, comment
  sweep) is one commit; there is no later defense-removal commit - the defenses are permanent.
- `SttsClient` keeps its blocking pattern by design ("callers own the dispatcher boundary") and
  now has a real callTimeout; out of scope here.

## Audit

**Round 1 (2026-07-16):** 9 opus dimensions (attachment-exclusivity, forget-purge-race,
poll-chain-pin, shape-identity, suspend-blast-radius, enqueue-semantics, teardown-defense,
stale-comment-sweep, verification-gaps), 30 findings returned, every load-bearing claim
independently re-verified against code before adoption - zero hallucinated findings this round.
Confirmed blockers: (1) the original Phase B pin (`hold < cap`) guarded a non-binding
relationship while the real constraint (`hold + margin < proxy ceiling`) stayed unpinned;
(2) the original Phase D rationale ("scope.cancel() interrupts the pass, the race closes at the
source") was false as written - the poll loop's catch swallows CancellationException and would
re-acquire the wakelock through decide(). Major serious findings folded in: the reconcileSent
out-bucket orphan (a live leak today); forget's local-gated IO launch trap; the enqueue
wrapper's error-routing/leak requirements (send()'s null callTimeout makes a lost resume a
permanent hang); the telemetry deviation ledger for Phase C; the MockWebServer +
returnDefaultValues + construction-seam verification upgrade; the stale-comment sweep list; the
4 private suspend helpers. Notes recorded: constants unchanged by D; alarm-PI path out of
scope; membership list confirmed complete; drafts are text-only.

**Round 2 (2026-07-16, targeted at the round-1 rewrite's own new claims):** 5 opus dimensions
(byteless-mirror-rule, orphan-sweep-race, unwind-and-defense-conditions, phase-b-arithmetic,
rewrite-completeness), 14 findings, again every adopted claim re-verified (one agent premise
was itself corrected during triage: org.json IS a real test dependency, so the true blocker for
a reconcileSent test was Context coupling, resolved by the pure-helper extraction). Round 2
overturned three round-1-rewrite designs: (1) the "delete the old out-bucket" reconcileSent
rule was wrong on two of three replace shapes (a same-(epoch,seq) re-drain fold would DELETE
FILES THE ROW STILL REFERENCES) - replaced with the per-file set-difference merge; (2) the
sweep's age threshold guarded the wrong race - replaced with strict sweep-before-poll
sequencing plus the zero-mtime guard; (3) the conditional defense-removal framing was
unsatisfiable (cooperative cancellation cannot make a non-suspend decide() unreachable) - the
defenses are now stated permanent with surgical comment rewrites. Also caught: the byteless
mirror is not currently producible (the arm stays as future-proofing); the pins' `internal`
visibility requirement; "instead of 11" -> 10; the Math.min-vs-comment instruction conflict;
Phase A's accidental test dependency on Phase C. Round 2's positive verifications: Phase B
arithmetic (58 < 60, 83 = 58+10+15), the schemas.ts unification is cycle-free, Math.min is
genuinely redundant (schema parse precedes every op.holdMs read), and the 504-branch cannot
swallow a cancel regardless of rethrow placement.

## Painpoints

Light touch after Phases A, B, and C; the six entries directly below are unchanged from that pass.
Phase D's crust-collection then ran the full scouting-workflow sweep across the whole Android app (5
dimensions, ~38 files) - its findings follow in their own subsection, each verified against the
actual code before being recorded (not taken on the audit's confident tone alone). Nothing in this
whole section is fixed by this plan; it is triage input for whatever picks it up next.

- **`plugins/designer/DesignerCards.kt : relOf`** - a third, independently-written copy of the
  same "strip a src down to its attachments-relative path" parse Phase A just consolidated
  inside `Attachments.kt` (`private fun relOf`, shared by `fileFor`/`bucketOf`). This copy has
  already drifted from the shared one: it takes a non-null `String` and has no
  `takeIf { isNotEmpty() }` guard, so a malformed src silently becomes `""` instead of failing
  safely. DesignerCards.kt already imports `Attachments` and reaches into `Attachments.DIR`
  directly, so delegating instead of re-deriving is a one-line change - deliberately left
  untouched this pass (out of Phase A's actual file set, and Designer plugin behavior deserves
  its own look before touching it, not a drive-by while focused on attachment purge).
- **`ConsoleClient.kt : DEFAULT_RELAY_CALL_TIMEOUT_MS` vs `PROXY_CEILING_MS`** - both evaluate to
  exactly `60_000L` (`PINNED_CONNECT_TIMEOUT_MS + PINNED_READ_TIMEOUT_MS + CALL_TIMEOUT_MARGIN_MS`
  = `15_000 + 35_000 + 10_000`, verified still true post-Phase-B). Phase B's own framework-fan-out
  flagged this as a numeric coincidence, not a design relationship - the plan's Phase B facts
  table already says as much ("do not unify them"), and no reachable op currently exercises
  `DEFAULT_RELAY_CALL_TIMEOUT_MS` under conditions where the proxy ceiling would matter (it bounds
  the non-held `relay()` path, which never holds the connection anywhere near 60s). Left alone: a
  same-value assertion would either be a tautology (both sides recompute the same arithmetic) or
  an accidental coupling (pinning two independently-justified budgets together for no functional
  reason). Noted so a future coincidental drift is not mistaken for a regression.
- **`ConsoleClient.kt : relay()` - a latent Phase D logging footgun, not a live bug.** Phase C's
  `postEvieDirect` redaction fix only applies to the 9 evie-direct ops, whose response bodies are
  PLAINTEXT JSON. `relay()` (Phase D's target) is structurally different and today logs nothing at
  all - but several of the ~21 ops it serves DO carry genuine plaintext secrets once unsealed
  (`crossDomainRequest.sas`, `crossDomainListenState.pin`/`.sas`, `crossDomainListen
  .listeningToken`, `poll`'s mailbox message bodies, `peek`'s raw terminal text). The raw HTTP body
  `relay()` reads is always `SealedEnvelope` ciphertext - safe to log as-is - but `unsealReply()`
  decrypts it LOCALLY into a plaintext `ConsoleReplyBody`. A naive Phase D trace line placed on the
  raw response text would be safe; the identical-looking line placed on the unsealed/decoded result
  would leak. Phase D must place any new tracing strictly on the sealed side of the unseal
  boundary, or redact per-op on the plaintext side - not a live leak today (nothing logs there yet)
  but the exact trap the postEvieDirect fix just closed on the evie-direct side.
- **`ConsoleClient.kt : postPublicApproval` - one unredacted resp-body log line, low risk.** The
  lone body-logging path Phase C's redaction rule doesn't cover (`"public resp HTTP ${resp.code}
  ${text.take(160)}"`, unchanged by this phase). Confirmed low-risk by two independent audit
  passes: `ConsoleApprovalResult.join` is public keys + a display name, and `.sealed` is opaque
  ciphertext (the actual onboarding bundle plaintext never appears in this response's own body).
  Noted for consistency with the new `logBody` discipline, not because it currently leaks anything.
- **`proto/Protocol.kt : TrustPendingResult.rendezvousId` - a naming trap, not a bug.** Confirmed
  SAFE to log (it is evie-served broker data, not a bearer secret - FLOW-2 defends via mutual
  owner-key anti-substitution + human SAS compare, unlike FLOW-1's genuinely-secret out-of-band
  pin). But `ChatRepository.kt`'s own `trustExchange` comments call it "the pin" when passing it to
  `EnrollCeremony.sas`, which reads as alarming out of context. Worth a one-line comment on
  `trustPending()` someday explaining why this "pin" is not secrecy-load-bearing, so a future
  refactor doesn't infer a secrecy dependency that was never there and misclassify it.
- **`DebugLog.kt : log()` - a real, pre-existing thread-safety bug, unrelated to this plan.**
  `fmt.format(Date())` (the shared `SimpleDateFormat`) runs OUTSIDE the `synchronized(lock)` block
  that guards everything else in this function - `SimpleDateFormat` is documented non-thread-safe,
  and this codebase already calls `DebugLog.log` concurrently from independent `Dispatchers.IO`
  coroutines (the poll loop, the trust/enroll-handshake loops, roster fetches). A race can corrupt
  the timestamp or throw, and the throw is unguarded - it would abort whichever evie-direct op
  triggered it. Confirmed by red-team as NOT introduced or worsened by Phase C (the same call
  pattern already existed pre-consolidation); flagged only because Phase C's own POST-line
  normalization means MORE call sites now share this exact log path than before. Fix is small
  (move the format call inside the lock, or switch to a `ThreadLocal<SimpleDateFormat>` /
  `java.time` formatter) but touches a file entirely outside this plan's scope.

### Phase D crust-collection findings

The cancellation-rethrow bug class Phase D just fixed in ChatRepository.kt/ConsoleClient.kt turned
out to recur at the UI layer (never touched by Phase D's own scope), and the sweep also surfaced
independent, unrelated bug classes across the rest of the app. Verified by direct code read, not
trusted on tone; five of fifteen (including all three marked high) were spot-checked line-for-line
and held up exactly as described.

- **`TerminalView.kt : TerminalView.fire`** - high. `fire()` wraps the suspend `onSend` callback
  (bound to `ChatRepository.tmuxSend`, a bare throwing suspend fun) in a plain
  `runCatching { onSend(...) }.onFailure { sendError = it.message ?: "send failed" }` with no
  cancellation guard - the exact bug class Phase D fixed in ChatRepository.kt/ConsoleClient.kt,
  recurring here because this UI call site was outside that phase's scope. Closing the terminal tab
  or navigating away mid-`tmux_send` cancels the composable's `rememberCoroutineScope` job; the
  resulting `CancellationException` gets caught and misreported as `sendError = "send failed"`
  instead of propagating as a clean cancel, on the app's most-exercised terminal interaction path.
- **`EnrollCeremonyScreen.kt : EnrollCeremonyScreen.ComparePanel.onDiffer`** - medium. Re-wraps
  `repo.enrollCancel(...)` - which already applies `runCatchingCancellable` internally and
  deliberately lets a genuine cancellation propagate - in a second bare `runCatching { }` whose
  `Result` is discarded entirely. This re-swallows the very `CancellationException` the Phase D
  helper exists to let through, and separately drops every genuine (non-cancellation) `enrollCancel`
  failure with zero signal, on a mismatch/tamper-warning path where the broker window failing to
  close actually matters.
- **`TrustCompareScreen.kt : TrustCompareScreen`'s dispose cleanup uses the wrong coroutine scope** -
  medium. `DisposableEffect(Unit).onDispose` fires `scope.launch { repo.trustCancel(rendezvousId) }`
  on the composable's own `rememberCoroutineScope` - the scope being torn down by this same disposal
  - unlike its two near-identical siblings (`LinkWizard.kt`'s `crossDomainCancel` cleanup,
  `EnrollCeremonyScreen.kt`'s own `enrollCancel` cleanup two call sites away), both of which
  explicitly launch on `GlobalScope` with a comment stating the call "must outlive this composable."
  Confirmed via direct read: both siblings say so in as many words; TrustCompareScreen's copy is the
  odd one out. The FLOW-2 rendezvous close likely never completes - the launched child job dies with
  its cancelling parent before the network round trip finishes - leaving the broker window open
  until the gateway's own TTL sweep instead of being actively closed like its two siblings.
- **(cross-file) the "outlive this composable" cleanup pattern is hand-rolled three times with no
  shared helper** - low. `LinkWizard.kt`, `EnrollCeremonyScreen.kt`, and `TrustCompareScreen.kt` each
  independently re-derive "best-effort cancel this rendezvous on leaving, on a detached scope" - and
  that is exactly how the TrustCompareScreen.kt copy silently picked the wrong scope (previous
  entry). A single shared "detached best-effort cleanup on dispose" composable utility would make
  that mistake structurally impossible instead of relying on three authors independently remembering
  the same subtle rule - the same shape of gap `Cancellation.kt` just closed for the rethrow idiom.
- **`SwitchboardService.kt : SwitchboardService.enterDeepSleep`** - high, verified. The
  `AlarmManager.setExactAndAllowWhileIdle`/`setAndAllowWhileIdle` calls have no try/catch, and
  `decide()` (which calls into this via `IdlePushbackManager`) is invoked from
  `ChatRepository.startPolling`'s poll loop textually AFTER that loop's own per-pass `catch` block
  closes, still inside `while (isActive)` - confirmed by reading both files. If either `AlarmManager`
  call throws (the file's own comment already acknowledges OEM quirks that can revoke
  `USE_EXACT_ALARM`), `releaseWakeLock()`/`releasePassLock()` right below never run (both locks leak
  indefinitely) and the exception is uncaught by the poll loop's coroutine body. `startPolling` is
  called exactly once, from `SwitchboardService`'s `onCreate` (confirmed - no other call site),
  so a single such exception permanently and silently kills background polling for the life of the
  service instance, with no restart path short of the app being killed and relaunched.
- **`SwitchboardService.kt : SwitchboardService.wakeLock`** - medium, verified. The field is a plain
  `private var wakeLock: PowerManager.WakeLock? = null` with no `@Volatile`, yet it is mutated from
  the main thread (`onCreate`/`onDestroy`) and from the poll loop's `Dispatchers.IO` thread (via
  `enterDeepSleep`/`exitDeepSleep`/`holdPass`) - unlike the companion object's `passLock` three lines
  away, which correctly uses `@Volatile` plus synchronized double-checked locking for the identical
  cross-thread access shape. Confirmed by reading both declarations side by side. A release racing an
  acquire across threads can leak a freshly-created WakeLock nothing will ever release, or make the
  poll loop believe a lock is held at the exact instant it was released.
- **`AppUpdater.kt : AppUpdater.downloadAndStage`** - medium. Blocks on OkHttp's synchronous
  `.execute()` with no cancellation wiring - the same blocking-call shape Phase D just removed from
  ConsoleClient's transport. Its only caller (`MainActivity`'s `AppUpdateRow`) launches it on a
  `rememberCoroutineScope()` job with no join/wait, so leaving the update screen mid-download does
  not stop the network call - it runs to completion (up to its 10-minute `callTimeout`) on a stray
  thread regardless of the coroutine's own cancellation, for a result nobody will consume.
- **`FederationManager.kt : FederationManager.ownerIdentity`** - high, verified. Returns the raw
  owner Ed25519/X25519 PRIVATE keypair - the sole root-of-trust key signing every admission,
  revocation, and Domain deletion - with default (public) visibility, despite zero callers anywhere
  outside `FederationManager` itself (confirmed by grepping the whole android tree: no external
  `.ownerIdentity(` call exists). Every sibling accessor (`ownerSignPub`, `ownerBoxPub`, `ownerSas`,
  `ownerKeysForDisplay`) is deliberately narrowed to public material only, showing the intent was to
  keep the raw private key inside this one class - an intent not actually enforced, since
  `FederationManager`/`AppStateStore` both have public constructors, so any code in the module could
  build its own `FederationManager(AppStateStore(context))` over the same store and read the raw
  private key straight out. Marking it `private` would compile clean today and turns this into a
  compile-time guarantee instead of an unenforced convention.
- **`FederationManager.kt` : the `signRosterRequest`/`signTransportRequest`/`signTrustPendingRequest`
  family** - medium. ~16 functions hand-repeat the same "fetch an identity, mint/accept a nonce,
  build a proto object, sign it" shape with no shared helper - the same kind of duplication
  `Cancellation.kt` just extracted elsewhere in this effort. Concrete evidence it already risks
  drift: two of the three near-identical possession-proof functions in this trio carry an explicit
  "(not the console key)" warning in their own doc comment - the authors already consider the
  console-vs-owner identity choice a mistake-in-waiting a comment has to guard against, not something
  the type system prevents.
- **`FederationManager.kt : consoleAdmission` vs `admitConsole` naming** - low. `admitGateway`/
  `admitConsole` form a clear `admitX(subjectKeys...)` family for owner-attesting a THIRD party's
  scanned/approved keys, but `consoleAdmission(nowMs)` - which instead self-admits THIS device's own
  identity with no subject-key parameters - sits in the same section with an easily-confused name. A
  future editor could call the zero-arg `consoleAdmission()` where `admitConsole(newSignPub,
  newBoxPub, now)` was intended; it would compile and silently re-sign this device's own admission
  instead of admitting the new device. All current call sites are correct today - forward risk, not
  a live bug.
- **`SttsPlayer.kt : SttsPlayer.playFile`'s MediaPlayer listeners** - medium. The
  `setOnCompletionListener`/`setOnErrorListener` callbacks unconditionally do
  `loudness?.release(); loudness = null` before checking `currentKey == k`, unlike the
  `player = null; clearNowPlaying()` lines right next to them, which ARE gated by that check. Since
  these callbacks land on the main Looper while a new `playFile()` call can run concurrently on the
  dedicated "stts" executor thread, a stale completion/error callback for a just-superseded track can
  release and null the NEW track's `LoudnessEnhancer` mid-playback, silently killing its volume boost
  with no error surfaced. The "release loudness + release player" shape is hand-copied across four
  sites; only these two listener copies are missing the guard the other two already have.
- **`Attachments.kt : Attachments.storeOutgoing`** - medium. Writes each outgoing attachment straight
  to its final path (`File(dir, name).writeBytes(...)`) with no tmp-file-plus-rename, unlike
  `decode()`'s documented atomic write for inbound files a few lines above in the same object. A
  process death mid-write leaves a truncated file at that exact final path; since
  `ChatRepository.reconcilePending` -> `rebuildFiles` re-reads bytes from that same path to resend a
  failed message, retrying after such a crash would silently transmit the truncated bytes instead of
  failing loudly.
- **`DebugLog.kt : DebugLog.init`** - low. Installs `Thread.setDefaultUncaughtExceptionHandler` by
  wrapping whatever handler is currently set, with no re-installation guard, yet it is called from
  three independent entry points (`BootReceiver.onReceive`, `PollAlarmReceiver.onReceive`,
  `MainActivity.onCreate`) each apparently written as an either/or fallback, not "may also run
  alongside the others." `MainActivity` declares no `android:configChanges`, so `onCreate` (and thus
  `init()`) re-runs on every Activity recreation (e.g. rotation) within one process, chaining one
  more handler layer each time - a single eventual crash would then log "CRASH" once per accumulated
  layer instead of once.
- **(framework-first) the "is this parsed Address my own (domain, gateway)" predicate is hand-copied
  six times, and only one copy has the fix the rest lack** - medium. `ChatRepository.kt`'s
  `closeTab`/`wakeSession`/`forget` each re-derive
  `runCatching { parseTarget(...) }.getOrNull()` then test `t.gateway == localGatewayId` alone (no
  Domain check). The sibling `rename()`, parsing the identical team string one screen away, tests
  `t.domain == localDomain() && t.gateway == localGatewayId` - gateway AND domain.
  `MainActivity.kt` echoes the gateway-only half three more times (the board's working-poke effect,
  `ThreadScreen.terminalEligible`, and `SessionsScreen`'s `adminDomainId` derivation - the value
  every later peer/mine grouping decision in that screen builds on). The codebase's own comment on
  `MainActivity`'s `GatewayGroupKey` states the invariant outright: a gateway id is unique only
  within a Domain, so two linked friend Domains running an identically-named gateway must group
  separately. A gateway-id collision across two Domains would make `closeTab`/`wakeSession`/`forget`
  treat a foreign-Domain session as local, and would seed `adminDomainId` from the wrong session -
  `rename()` alone already carries the fix the other six copies lack, the same kind of drift
  `Cancellation.kt`'s own sweep found in `spawnSession`'s dead redundant guard.
- **(framework-first) clipboard access is hand-rolled per-file and has already drifted in UX** - low.
  `Management.kt`'s private `copyToClipboard`, `HostNetworks.kt`'s independent `copyInvite`, and
  `MainActivity.kt`'s `readClipboard` each redo the same `getSystemService(CLIPBOARD_SERVICE)`
  cast-and-use dance. Because the write helper is file-private rather than shared, the three call
  sites have already drifted in user-visible behavior: `HostNetworks.kt`'s invite-copy button sets a
  "Copied." status after copying; neither of `Management.kt`'s two `copyToClipboard` call sites shows
  any confirmation, even though one of those two screens already renders a `status` Text slot for
  other messages one line above the button. A shared helper would make that feedback contract
  structural instead of independently re-decided (or forgotten) at each call site.