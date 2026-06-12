# Android Background Service + Long-Poll

Follow-up to `android-status-board.md`. The app currently only works as a direct
foreground: screen-off kills polling (stale "Working..." chips, red Offline banner,
blank WebView on resume, false FAILED badges on in-flight sends) and there are no
message notifications at all. This plan moves the poll loop into a foreground service
with notifications and adaptive cadence, then upgrades the wire to long-poll.

Approved direction (user): "I think I want FGS and long-poll" + AFK burst batching.
Personal sideloaded app: no Play policy constraints, lean passes, fix obvious security
only.

## Verified current state

- Transport is plain CA-pinned OkHttp HTTPS through the k8s apiserver service-proxy;
  nothing about it requires a foreground Activity. The constraint is Android execution
  (doze cuts network; FGS exempts execution but NOT deep-doze network - the battery
  optimization exemption covers that).
- Evie's phone bridge holds each relay HTTP request `DEFAULT_TIMEOUT_MS = 35_000`
  (`evie-bot/app/features/bridge/PhoneBridgeServer.ts`, constructor accepts
  `timeoutMs`). The apiserver proxy default request timeout is 60s. The arbiter's send
  bound (25s) was chosen to fit under evie's hold.
- The phone's OkHttp client: connect 15s / read 35s / write 60s (`PhoneClient.kt`).
- `phoneHandler` "poll" drains synchronously; `DeviceMailbox` has no append waiters.
  Reads run fresh (not opId-cached), so a held poll retried after a lost reply is safe.
- Lifecycle findings (emulator-reproduced): home-and-back is fine (process + WebView
  survive, polls continue); screen-off dozes the network within ~1 min, accumulates
  poll failures (red banner), kills the WebView render process (blank until re-feed),
  and kills in-flight send sockets (false FAILED badge even though the op landed
  server-side - the agent answered it).
- Sends/retries are idempotent per (conversationId, opId); `Message.opId` is persisted.
  The arbiter replays the cached op result for a reused opId, so re-delivering an
  unsettled echo with its original opId can never double-deliver.
- Mailbox accumulation means AFK burst batching needs NO server presence signal: the
  client just switches cadence; a single poll drains everything queued.

## P1 - Foreground service backbone (app only)

- `SwitchboardService`: foreground service, manifest type `remoteMessaging`
  (`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_REMOTE_MESSAGING` permissions),
  `exported=false`. It owns the poll loop via the process-wide `Repo` singleton; the
  Activity stops driving polling and only binds/observes state. Service starts when
  provisioned (app launch) and on boot (`RECEIVE_BOOT_COMPLETED` receiver, only if
  provisioned).
- Notifications (`POST_NOTIFICATIONS` runtime request on first run):
  - channel `status`, min/low importance: the mandatory persistent FGS notification
    showing bridge state + unread count.
  - channel `messages`, default importance: posted per poll burst when the app is not
    visible - grouped per team ("recipe-app: 2 messages" + snippet), tap opens that
    thread (intent extra -> openTeam). Cleared when the thread is opened.
- Cadence policy owned by the service, driven by Activity visibility (foreground
  lifecycle callbacks on the repo/service):
  - visible: current 5s loop (P2 swaps this to continuous long-poll).
  - background/AFK: one plain poll every 60s, drain as burst. Optional Settings knob
    later (1 min / 5 min / off); default 60s.
- Battery: Settings row requesting `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  (sideloaded; just ask) with a one-line explanation of why screen-off delivery needs
  it.
- Resume kick: when the Activity comes to the foreground, immediately poll + refresh
  teams, and reset the poll-failure streak display so a doze-corpse "Offline.
  Retrying..." banner clears at once.
- Unsettled-send reconciliation: `loadPersistedThreads` stops demoting "pending" to
  "error"; instead the service, on start and on each foreground transition, re-delivers
  any fromMe row still "pending" ONCE using its stored opId (idempotent: arbiter
  replays if it landed, re-fails to "error" if it never did). "error" rows stay manual
  tap-to-retry. Invariants: no duplicate delivery to the agent, no silent loss, a row
  never stays "pending" past one reconcile attempt.
- Renderer: on foreground transition, if the WebView render process died in the
  background, recreate + re-feed immediately rather than waiting for the next state
  change (kills the blank-void window).

## P2 - Long-poll wire + AFK burst

- `phone-protocol.ts`: poll op gains `holdMs` (optional, zod-capped at 45_000).
- `DeviceMailbox`: append waiters - `waitForAppend(timeoutMs)` resolved by `append`,
  eviction, or epoch reset (never leaks a waiter past mailbox teardown).
- `phoneHandler` poll case: drain; if empty and holdMs > 0, await
  `waitForAppend(min(holdMs, HOLD_CAP))`, then drain again. HOLD_CAP 45s.
- CRITICAL check before holding: the relay pump (`relayPump.ts` /
  `evieClient.onPhoneRelay`) must process frames concurrently. If it awaits each frame
  sequentially, one held poll would block every other phone op behind it. Verify and
  fix to fire-and-forget per frame if needed.
- Evie `PhoneBridgeServer`: raise relay hold to 55_000 (still under the apiserver 60s)
  so a 45s arbiter-side hold fits with headroom. One-line constructor/default change +
  its test.
- `PhoneClient.kt`: `poll(cursor, epoch, holdMs)`; per-call OkHttp timeout for poll
  calls = holdMs + 15s (call.timeout or a dedicated client), other ops keep current
  timeouts.
- Service cadence with hold: visible = continuous long-poll (re-poll immediately after
  each response); AFK = 60s interval, holdMs 0.
- Smoke the LKE proxy before trusting it: a held poll (~45s) against an empty mailbox
  through the real apiserver proxy must return 200 on timeout, not a proxy 5xx. The
  curl-as-phone pattern from `evie-bot/deploy/phone-bridge-smoketest.sh` works for
  this.

## P3 - Lifecycle matrix + deploy

- Emulator matrix: screen off -> message -> screen on (expect: notification while off
  if FGS survives, instant catch-up on resume); home -> back; app swiped from recents
  (service should keep running or restart); reboot (boot receiver); deep doze via
  `dumpsys deviceidle force-idle` with and without the battery exemption.
- Live pass against the real bridge (blob injection harness as before).
- Deploy, cross-repo order per the phone-bridge ritual: push evie FIRST and await its
  rollout (CI builds + rolls out the pod with the 55s hold) - an old 35s evie under a
  40s-holding chain would 504 every idle long-poll. The app tolerates that window
  anyway (a 504 during a hold is treated as an empty poll, not a failure), but the
  order avoids it entirely. Then push switchboard (version 3.9.0 in plugin.json +
  package.json; CI refreshes the `android-app` release). Arbiter restart is user-owned
  (P2 hold lands arbiter-side). P1 app behavior must degrade cleanly against the
  pre-P2 arbiter (holdMs ignored = plain poll, floored cadence). Timeout chain, each
  layer ordered before the next: arbiter reply <= 40s, evie 504 at 55s, phone read
  timeout at 58s, apiserver proxy at 60s.

### Notes for implementers

- Personal app. Lean passes; the cycle steps are implement, red-team, fix, commit.
- The emulator harness: `source ~/android-dev/env.sh`, AVD `phone35`,
  `wm size 720x1600` + `density 280` for readable screenshots (reset after). The
  provisioning blob injects via the `provisioning_b64` intent extra; build it from the
  cluster secrets (see session history) - never commit it.
- recipe-app is the designated live guinea pig; stop its container after tests.
- Keep the phone protocol additive: old app against new arbiter and new app against
  old arbiter must both keep working (holdMs optional, ignored when absent).
