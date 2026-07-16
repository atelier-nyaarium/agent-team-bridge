# Console hardening (extracted from the idle-pushback crust sweep, prioritized)

The four above-low items from `plans/pain-points.md`'s idle-pushback section (2026-07-16),
extracted here as a real plan. The three low/cosmetic siblings (ENROLL_POLL vs evie-bot TTL, the
SwitchboardService notification extraction, the `Repo.get` relocation) stay in pain-points.md.

Phases A and B are independent. C is a prerequisite for D: consolidating the duplicated
request shape first means the transport change in D lands in 2 chokepoints instead of 11.

Refined through a plan-refinement cycle (see `## Audit` at the bottom): round 1 found two
blockers (Phase B's original pin guarded the wrong relationship; Phase D's original rationale
ignored that the poll loop's catch swallows CancellationException) plus a live disk leak Phase A
must now cover. Everything below is the post-audit state.

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
  attachment-bearing send, independent of forget. Corollary: when the mirror is byteless
  (metadata-only), the echo's files carry null `src` and the replace makes `out-<ms>` the ONLY
  copy of the user's own sent thumbnails - unreachable via any row.
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
2. **Kill the ongoing out-bucket leak at its source:** when `reconcileSent` replaces the
   optimistic row AND the replacing echo carries its own decoded bytes (non-null srcs), delete
   the old row's now-unreferenced out-bucket files. When the mirror is byteless, KEEP the
   optimistic row's files on the replaced row instead (preserves the user's sent thumbnails and
   keeps the bucket referenced) - fixing the byteless-mirror thumbnail loss in the same move.
3. **Orphan-bucket sweep as the completeness backstop:** on cold start (an IO coroutine after
   threads load), enumerate `attachments/*` bucket dirs, compute the referenced-bucket set from
   ALL surviving rows across threads, delete unreferenced buckets. Skip buckets younger than a
   generous age threshold (e.g. 10 min) so the sweep can never race a send's store-then-append
   gap. This heals: historical reconcileSent orphans, crash-between-persist-and-delete windows
   (the row shrink is durable via `apply()`, the file delete is a best-effort coroutine - a kill
   in between leaks until the next sweep, an accepted-and-healed posture rather than a permanent
   one), and any future decode-without-row case (plugin_action).

**Tests:** keep the dropped-row derivation pure (the `threadsAfterForget` test pattern);
temp-dir JVM tests on the delete helper (dropped row's files gone, sibling bucket untouched,
empty dir removed, occupied dir kept) and the sweep (orphan deleted, referenced kept,
young-bucket skipped); a reconcileSent test for the byteless-mirror file-preservation rule.
Note: target the purge/sweep helpers (pure `java.io`), not `Attachments.decode` - decode uses
`android.util.Base64`, which under Phase C's `returnDefaultValues` test option returns null
rather than throwing, silently weakening any test that leans on it.

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
  (e.g. `HELD_READ_MARGIN_MS`).
- Add a documented ceiling constant (e.g. `PROXY_CEILING_MS = 60_000`) whose comment states it
  mirrors untracked infra (documentation-as-code: an infra change must update it) - then pin
  `LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS < PROXY_CEILING_MS` in `ChatRepositoryConstantsTest`
  (the current 58 < 60 headroom is deliberately thin; pin strict `<` and say so).
- Unify the gateway's two independent 45_000 literals: define one exported constant in
  `schemas.ts`, use it in the zod `.max()` AND import it as `HOLD_CAP_MS` in consoleHandler (or
  drop the redundant `Math.min` with a comment) - derive, don't duplicate. Pin
  `LONG_POLL_HOLD_MS <= <that constant>` from both sides (`<=`: `Math.min`/`.max` honor
  equality) in the two constants-test files that already do this for other pairs.
- Also pin the client's internal derived ordering: held callTimeout > held read timeout > hold
  (pure arithmetic on ConsoleClient constants; a bare JUnit test).
- Update ALL THREE in-repo prose restatements of the chain to point at the pins:
  `ConsoleClient.poll`'s comment, `consoleHandler.ts`'s `HOLD_CAP_MS` comment, and
  `src/gateway/index.ts`'s `HOST_OP_TIMEOUT_MS` comment ("evie ~55s, apiserver 60s").
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

**Payoff:** Phase D's transport change becomes 2 edits (relay + this helper) instead of 11, and
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
   a CancellationException rethrow before any classification (`classifyConnError` must never see
   one); sweep the 18 `runCatching { client()... }` sites and make each rethrow cancellation
   (`.onFailure { if (it is CancellationException) throw it }` or convert to try/catch). The
   main-catch rethrow is the one that closes the wakelock-reacquisition path; the runCatching
   sites are hygiene ensuring no swallowed cancel anywhere.
4. **Comment sweep (same commit - these become false the moment the transport changes):**
   SwitchboardService.kt's destroyed-flag block and onDestroy comments ("blocking, not suspend,
   so scope.cancel() cannot interrupt"); ChatRepository.clearAll's cancelAndJoin rationale (the
   JOIN stays - it still serializes the post-poll drain against the state reset - but the
   stated worst case changes from "waits out the call timeout" to "returns on cancel unwind");
   SttsClient.kt's "Blocking OkHttp like ConsoleClient" analogy (SttsClient stays blocking by
   design; the cross-reference is what dies); ConsoleClient's own class/relay/poll/send KDocs;
   CLAUDE.md's idle-pushback section if it restates blocking-ness.
5. **Explicitly NOT touched:** `IdlePushbackManager`'s PASS_*/BURST_JOIN constant math - it
   sizes wall-clock completion of a normally-finishing pass (the enqueue path consumes the same
   wall-clock; the wakelock must stay up for the round trip regardless of which thread waits),
   and BURST_JOIN bounds STTS work, not transport (audit-verified; do not "re-derive").

**Then, separately (not in the same commit):** re-evaluate the destroyed-flag +
scheduler-null teardown defenses, under CONCRETE removal conditions (audit round 1): they may
go only if (a) the poll loop provably rethrows cancellation so `decide()` is unreachable after
a cancel, and (b) a red-team pass confirms no other path from a cancelled pass reaches the
scheduler (the burst `joinAll` is itself cancellable, so the poll coroutine unwinds even while
stale STTS children linger on their own blocking calls - those children never touch the
scheduler). Until both are demonstrated, the defenses stay. **The alarm-PendingIntent revival
path (PollAlarmReceiver + companion passLock) is orthogonal to cancellability - a system kill
skips onDestroy entirely and revives a fresh process - and is NOT part of this re-evaluation.
Do not touch it.**

**Verification:** MockWebServer tests (on Phase C's infrastructure): a cancellation test
(server holds the response; cancel the calling job; assert the OkHttp call is cancelled and the
coroutine unwinds promptly instead of waiting out the timeout) and a per-call-timeout test
(delayed body > callTimeout -> throws). Plus both build gates, as always.

## Notes

- All four phases are Android-console-side plus small same-repo TS edits in B. No user-facing
  UX decisions anywhere - straight to `audited-implementation` cycles per phase when picked up.
- Order: A and B in either order (independent); C strictly before D; D's rethrow discipline and
  comment sweep land in the SAME commit as the transport change, the defense re-evaluation in a
  later one.
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
out-bucket orphan (a live leak today) + byteless-mirror thumbnail loss; forget's local-gated IO
launch trap; the enqueue wrapper's error-routing/leak requirements (send()'s null callTimeout
makes a lost resume a permanent hang); the telemetry deviation ledger for Phase C; the
MockWebServer + returnDefaultValues + construction-seam verification upgrade; the stale-comment
sweep list; the 4 private suspend helpers. Notes recorded: constants unchanged by D;
alarm-PI path out of scope; membership list confirmed complete; drafts are text-only.