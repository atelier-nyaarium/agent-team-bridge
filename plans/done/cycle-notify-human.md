# Cycle-End Notifications to the Phone

Cross-repo: nyaaskills (cycle MCP tools) + switchboard (arbiter route, MCP tool,
Android rendering). Cycles run for hours; the user wants their phone pinged at lap
ends or on completion, with tiered payloads. NO pushes: all work commits locally and
ships with the next compound deploy. The switchboard server/app halves cannot be
live-tested against the running arbiter (it predates these routes); validate with
vitest + emulator fixtures, and note live validation for the deploy.

## Architecture (decided)

- Plugins compose THROUGH the agent, never server-to-server. The nyaaskills MCP
  server cannot call switchboard tools; instead `cycleCheckpoint`'s RESULT embeds a
  ready-to-send payload plus the instruction "if a `notify_human` tool is available,
  call it with this; otherwise continue." A cycles-only user's agent sees no such
  tool and loses nothing. The `notifyCycleEnd` stub in notify.ts stays a server-side
  no-op (reserved for local effects).
- switchboard gains `notify_human`: posts to a new arbiter route that appends a
  "notice" entry to EVERY registered phone mailbox (the arbiter knows its phone
  peers; senders never need the device name). Long-poll waiters wake on append, so
  delivery is instant foregrounded and within the AFK minute otherwise. Notices are
  not respondable (never recorded as inbound sessions).

## P1 - nyaaskills: checkpoint tiers + notify option

- `cycleCheckpoint` schema: add `tiny` (required; one phrase, <= ~60 chars, the
  notification-bar line, passed through verbatim), respec `summary` to "4-6 plain
  sentences: what finished, and what is next if continuing" (the Short tier),
  add optional `full` (markdown/mermaid report) and `attachments` (absolute paths),
  and optional `whatToDecide` (critical-stop only: the specific decision a human
  must make).
- Payload body is composed as English prose, not a template: a header sentence per
  decision ("{project} has completed its run after N laps in 2h 10m." /
  "{project} ran into an issue that needs your attention." /
  '{project} completed phase "X" and is continuing on phase "Y".' /
  "{project} finished a batch (N of M items done) and is continuing." /
  "{project} finished lap N and is continuing."), a blank line, the summary, an
  optional "Decision needed: ..." line, and any authored full report below a rule.
  Phase loops pass the finished/next phase labels (first line of the phase items)
  into the composer. The cycle definition name is deliberately NOT in the header
  (jargon to the reader); urgency rides the `urgent` flag, never the tiny text.
- `cycleStartPlan` + `cycleStartItems` gain `notify: "done" | "laps"` (default
  "done"), persisted in the sidecar. Stamp `startedAt` at start for duration
  reporting.
- Checkpoint behavior: on `done`/`critical-stop` always embed the relay payload in
  the result; on `loop` embed it only when notify == "laps". Payload includes:
  decision, tiny, summary, full, attachments, whatToDecide, plus auto context the
  server already has - project dir name (basename of cwd), plan, cycle, lap,
  items-mode counts (processed/remaining/deferred), and elapsed time since
  startedAt. critical-stop maps to urgent.
- `CycleEndEvent` extended to carry the same; notify.ts signature updated, still a
  no-op body.
- Tests: extend src/cycle/tools/cycle.test.ts for the new schema fields, the notify
  option persistence/default, the relay-payload presence rules (loop+done x
  done/laps), and startedAt/duration.
- Old sidecars (no notify/startedAt) must load fine (defaults).

## P2 - switchboard server: notice route + notify_human tool

- `MailboxEntry` gains optional `title` and kind `"notice"` (phone-protocol.ts +
  mirror docs). Arbiter route `notifyHuman`: schema { from, tiny, full?, files? }
  (ChannelFilesSchema, same 10MB cap pattern as respond), appends
  { kind: "notice", session_id: "notice:<from>", from, title: tiny,
  body: full || tiny, files } to every mailbox in the DeviceMailboxStore (store
  needs an iteration accessor). Never recorded as respondable inbound.
- MCP tool `notify_human` registered for BOTH container and host agents:
  { tiny, full?, attachments? } - reads/encodes attachment files like replyTool
  does (10MB advisory), posts to the route with from = team name. Clear errors when
  the arbiter is unreachable.
- Tests: route appends to all phone mailboxes and wakes held polls; caps enforced;
  phone respond op on a notice session id is rejected; store iteration.

## P3 - switchboard app: render notices

- PhoneClient parses `title`; Message gains persisted optional `title`.
- Poll loop: notice entries thread under the SENDER (session "notice:<from>" parses
  to the from; verify teamFromSession or branch on kind) and are normal inbound for
  unread/burst purposes.
- Notifications: when a burst message has a title, use it as the notification
  content line (the body may be a long report).
- Thread rendering: body is already markdown (mermaid included); prepend nothing -
  title is notification-only. Demo fixture gains a notice-shaped message so the
  rendering laps offline.
- Emulator lap: demo notice renders; a synthetic title-bearing message produces a
  notification using the title (drive via the burst path if reachable, else unit
  reasoning + deploy-time validation note).

### Notes for implementers

- Lean passes; no pushes, local commits only; the compound deploy comes later.
- Emulator harness as before (env.sh, phone35, wm 720x1600/280, reset after).
- Keep the phone protocol additive: old apps ignore `title` and unknown kinds must
  not crash them (verify the app's parse path tolerates kind "notice").
- nyaaskills tests run with bun/vitest per that repo's setup (check package.json).
