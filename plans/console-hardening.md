# Console hardening (extracted from the idle-pushback crust sweep, prioritized)

The four above-low items from `plans/pain-points.md`'s idle-pushback section (2026-07-16),
extracted here as a real plan. The three low/cosmetic siblings (ENROLL_POLL vs evie-bot TTL, the
SwitchboardService notification extraction, the `Repo.get` relocation) stay in pain-points.md.

Phases A and B are independent. C is a prerequisite for D: consolidating the duplicated
request shape first means the transport change in D lands in 2 chokepoints instead of 11.

## Phase A - `forget(team)` per-team attachment purge (privacy)

**Facts (from code):**

- Attachments live under `filesDir/attachments/<bucket>/`, one bucket per mailbox entry:
  inbound `"<epoch>-<seq>"` (`Attachments.decode`), outbound `"out-<timestamp>"`
  (`Attachments.storeOutgoing`). A mailbox entry lands in exactly one thread, and a gateway
  peer-mirrored exchange is two separate entries with two separate buckets - so no bucket is
  ever shared across teams. Deleting a dropped row's files can never orphan another team's.
- `forget()` drops rows in MULTIPLE threads, not just `threads[key]`: `threadsAfterForget`
  removes the team's own thread AND sweeps every remaining thread for peer-mirror rows
  (`it.isPeer && (it.from == key || it.to == key)`). The purge set must cover all of them.
- `MessageFile.src` is `"https://appassets.androidplatform.net/attachments/<bucket>/<name>"`;
  the existing extraction idiom is `src?.substringAfter("/${Attachments.DIR}/", "")` +
  `Attachments.resolve(filesDir, rel)` (traversal-safe, see `rebuildFiles`).
- `clearAll()` and the schema wipe both call `Attachments.purgeAll`; `forget()` deletes nothing.

**Fix direction:** derive the purge set from the dropped rows themselves - the message file refs
ARE the index, so there is no new index to maintain and nothing to drift. Restructure
`threadsAfterForget` to also return the dropped rows (or extract its predicate so drop-and-collect
share one source of truth - never a second hand-copied predicate). Map each dropped row's
`files[].src` through the existing rel-extraction + `resolve()` idiom, delete the files on an IO
hop (`forget()` is a main-thread UI callback; it already has a `pollScope` IO launch for the
gateway call), then remove now-empty bucket dirs. A null `src` (metadata-only chip) has nothing to
delete.

**Tests:** keep the dropped-row derivation a pure function (the `threadsAfterForget` /
`IdlePushbackManagerTest` pattern) so it tests without Android; plus a temp-dir JVM test on the
delete helper (files of a dropped row gone, sibling bucket untouched, empty dir removed).

## Phase B - long-poll timeout chain: pin the same-repo half

**Facts:** the chain, in required strict order:

| layer | value | where | pinnable from this repo? |
|---|---|---|---|
| gateway hold | 40s `LONG_POLL_HOLD_MS` | `ChatRepository.kt` | yes |
| gateway cap | 45s `HOLD_CAP_MS` | `src/gateway/console/consoleHandler.ts` (private) | yes |
| evie relay hold | 55s | evie-bot repo | no (comment only) |
| client read timeout | 58s (`holdMs + 18_000`) | `ConsoleClient.poll` | already derived, no drift risk |
| apiserver proxy | 60s | untracked infra config | no (comment only) |

**Fix direction:** export `HOLD_CAP_MS`; pin `LONG_POLL_HOLD_MS < HOLD_CAP_MS` from both sides
(`ChatRepositoryConstantsTest.kt` and `consoleHandler.test.ts` both exist and already do exactly
this for other constants - follow that pattern). Update the two prose restatements to point at the
pins. The 55s/60s layers stay comment-documented with an explicit note that they live outside
this repo; add an evie-bot-side pin whenever next working that repo.

## Phase C - consolidate the 10 duplicated evie-direct request shapes

**Facts:** `enroll`, `postConsoleApproval`, `firstRoot`, `requestGatewayTransport`,
`enrollHandshake`, `roster`, `trustHandshake`, `trustPending`, `provisionTenant` (members) share
an identical 6-step skeleton, hand-copied ~30 lines each:

1. build envelope, POST `$proxyBase/relay` with the same two auth headers
2. `DebugLog` the POST (per-site tag + descriptor)
3. try `execute()`, log + rethrow a transport error
4. `resp.use`: read text, log HTTP code + truncated body
5. 2xx: decode `<R>`, else `R(ok=false, error="unexpected response (HTTP code)")`
6. non-2xx: try decode `<R>` (coordinator reject carries a typed body), then
   `BounceBody.error`, then `R(ok=false, error="HTTP code")`

Per-site variation is exactly: envelope construction, result type `R`, `R`'s ok=false
constructor, log tag, log descriptor. The companion's `postPublicApproval` is a genuine variant:
`publicClient` (not the pinned client), caller-supplied `reachUrl`, NO auth headers, and no
`isSuccessful` branch (it decodes any response body first).

**Fix direction:** one private helper, roughly
`inline fun <reified R> postEvieDirect(tag: String, describe: String, body: RequestBody, fail: (String) -> R): R`,
then migrate the 9 members one at a time. This is the most security-sensitive file in the app:
each migration must be a behavior-preserving diff verified against the 6-step skeleton above
(decode ORDER matters on the non-2xx path - typed body before bounce before fallback).
`postPublicApproval` either gets parameterized in (client/url/no-headers/skip-successful-branch)
or is deliberately left out with a comment naming why - decide during implementation, do not
force-fit it. No unit tests exist for this file; the audited-implementation red-team step plus
both build gates carry verification.

**Payoff:** Phase D's transport change becomes 2 edits (relay + this helper) instead of 11, and
so does every future fix to the shape.

## Phase D - cancellable transport (the root cause behind the teardown defenses)

**Facts:**

- Every ConsoleClient network call is blocking `OkHttp Call.execute()`; no `suspend` in the file.
  `scope.cancel()` cannot interrupt an in-flight call - the reason `SwitchboardService`'s
  `destroyed` flag + scheduler-null teardown defenses exist (see that file's onDestroy comments).
- `relay()` serves ~21 of ~32 internal sites; after Phase C, `postEvieDirect` serves the rest.
- All external call sites live in `ChatRepository.kt` (~50 references, every one already inside a
  coroutine: the poll loop, `scope.launch(Dispatchers.IO)`, `withContext(Dispatchers.IO)`).
  `SwitchboardService.kt`/`SttsClient.kt` mention ConsoleClient in comments only (verified).
- The per-call config added 2026-07-16 (`callTimeoutMs`, `readTimeoutMs`) must survive: `send()`
  opts out of callTimeout for its unbounded upload; `poll()` derives both from its hold.

**Fix direction:** wrap the call in `suspendCancellableCoroutine` around `enqueue()` with
`invokeOnCancellation { call.cancel() }` (transport-level cancel, works mid-connect and
mid-read). `relay()` and `postEvieDirect()` become `suspend`; the public functions become
`suspend`; ChatRepository call sites are compile-mechanical (already in coroutines). Keep the
response-body read inside the callback or on IO - `enqueue` moves the wait off the thread but
`body.string()` still blocks briefly.

**Then, separately (not in the same commit):** re-evaluate the teardown defenses with a red-team
pass. Once `poll()` is cancellable, `scope.cancel()` in onDestroy interrupts the in-flight pass,
so the "one more cycle against a dead instance" race closes at the source - the `destroyed` flag
and the `IdlePushbackManager.scheduler` null-write may reduce to belt-and-suspenders or become
removable outright (framework-first: derive, don't defend). Decide with evidence, not by
assumption; the wakelock/alarm leak this defends against is exactly the class of bug the
idle-pushback red-team caught live.

## Notes

- All four phases are Android-console-side (plus one exported TS constant in B). No user-facing
  UX decisions anywhere - straight to `audited-implementation` cycles per phase when picked up.
- Order: A and B in either order (independent, small); C strictly before D.
- `SttsClient` shares the blocking-OkHttp pattern by explicit design ("callers own the dispatcher
  boundary") and now has a real callTimeout; it is deliberately out of scope here.
