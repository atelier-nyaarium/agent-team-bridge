# Reply-tool redesign: split the polymorphic `channel_reply` into two purpose-built tools

## Refresh (2026-07-09, not yet implemented)

Written 2026-06-29; still nothing built (`respondAsMarkdownString`/`respondAsStructuredData` are still
the live shape). Re-verified every file:line citation against source after 24 unrelated commits landed
in the intervening 10 days (mostly the now-fully-shipped session-id-teardown effort, Phases A-G). All
8 numbered decisions below remain sound and do not need re-litigating - "zero wire / zero Kotlin / zero
Android change" was re-confirmed directly (a live `bun scripts/codegen-kotlin.ts` run today reproduces
a byte-identical no-op diff on `Protocol.kt`). Line-number citations throughout this doc were corrected
in place. One section changed in substance, not just line numbers: **step 5** now targets a shared
`sendHandshake()` function fired from two call sites (register-time plus a 2026-07-07 heartbeat-resend
loop, up to 20 attempts over ~10 minutes) instead of one inline send. A same-day follow-up decision
(below, in "What was rejected") then simplified step 5 further: the owner accepts a coordinated
plugin + gateway restart, so the handshake wording no longer needs to be transition-safe/tool-agnostic
- it can hardcode the new tool name directly.

## Context

`channel_reply` is a single tool with a polymorphic body: mutually-exclusive
`respondAsMarkdownString` (human prose) XOR `respondAsStructuredData` (a JSON **string**
parsed into the wire field `replyAsJson`), plus optional `title`/`summary`/`attachments`, with a
`.refine()` enforcing the XOR. The two body variants were invented for an older multi-agent-CLI era;
we are Claude-only now, so the variants are being killed and re-envisioned. A 3-Opus review panel
plus a 12-dimension grounded plan audit produced this hardened plan.

Prior art that constrains this work: commit `2be4327` ("Rename reply body params") fixed an
empty-reply bug where the model reached for a field name it never guessed (`replyAsString`) or a
fictional `status` field, and silently sent nothing the phone dropped. The lessons - guessable,
well-DESCRIBED names; never make the model reproduce a magic token; reject empties loudly - are
load-bearing and every choice below is checked against them.

## Decision (settled by the user)

1. **Two tools**, not one. Kill the XOR; each tool has one closed body shape.
2. **The prose reply is a required `{title, summary, full}` triple** (`session_id` required too;
   `attachments` optional). title + summary are required - not optional as today - for a future
   multi-way-Console view that keys on a uniform per-message headline. The ack-tax is accepted.
3. **Body field is named `full`** (not `message`/`fullMessage`): it matches the `notify_human`
   `{title, summary, full}` triple and the user's mental model, and (bonus) avoids the distinct
   `RespondBodySchema.message` field. So the prose tool's body triple is now SHAPE-IDENTICAL to
   `NoticeSchema` (all three required, same `notice.ts` constraints) - only the describes differ.
4. **Drop `metaInstruction`** as a field (rejected - the `2be4327` magic-token class; the channel
   frame is ambient, see "What was rejected").
5. **Structured data is a native object**, not a JSON string.
6. **Drop `status`** from the agent-facing tools (already dead behind `.strict()`; it stays on the
   wire/poll/handshake paths that bypass the tool).
7. **Keep `session_id` snake_case** (the model echoes it verbatim from the inbound tag).
8. **Zero wire / zero Kotlin / zero Android change.** Both tools map onto the existing
   `RespondBodySchema`; the console has its own `ConsoleOp.respond` and never calls these tools.

### Accepted consequence (acknowledged by the user)
Making `full` required **removes the attachments-only reply** (`replyTool.ts:90` currently lets a
reply be just attachments with no prose). After this change `{session_id, attachments:[...]}` with no
`full` is schema-rejected; an image reply must carry a one-line caption. Consistent with "every
message has a body" for the multi-way view - locked in by a test (see Verification).

## The two tools (final shape)

Snake_case to match house style (`notify_human`, `crosstalk_send`). The prose triple reuses the
`notice.ts` field schemas for the CONSTRAINTS (min/max) only - **each `.describe()` is overridden**
for the reply context so notice/milestone framing ("4-6 sentences: what happened and what is next",
"Full markdown report") does not leak into a chat reply (audit: notice-field-reuse, major).

```ts
channel_reply                 // the ~99% prose path; flat triple, not nested under responseData
  session_id : string                              (required)   // verbatim echo from the inbound tag
  title      : NoticeTitle.describe(<reply title>)  (required)   // maps to wire `title`
  summary    : NoticeSummary.describe(<reply summ>) (required)   // maps to wire `summary`
  full       : NoticeFull.describe(<reply prose>)   (required)   // maps to wire `response`
  attachments: z.array(z.string()).optional()                  // absolute paths, read+base64 in the plugin

channel_reply_structured      // ONLY when the inbound tag carries reply_schema (handshake etc.)
  session_id  : string                             (required)
  responseData: z.record(z.string(), z.unknown())   (required)   // native object, NOT a JSON string
```

Exact `.describe()` text (these are what the model reads at tool-call time - the per-field guidance
the user confirmed must stay declared):
- `title`: "A very short one-line headline for this reply - the console's notification-bar line and
  the shortest text-to-speech tier."
- `summary`: "3-4 sentences summarizing this reply, read as the medium text-to-speech tier. No
  'Summary:' lead-in."
- `full`: "Your full prose reply for the HUMAN to read - markdown AND mermaid render on the console.
  Lead with the answer; no lead-in labels ('Short answer:', 'TLDR:'). Renders as the message body."

Tool DESCRIPTIONS (load-bearing - they are the channel-frame anchor that replaces `metaInstruction`):
- `channel_reply` (update the existing `channelReply.ts:10` string): note that `title`, `summary`,
  and `full` are all REQUIRED; prose is a stream (reply any number of times, no finality).
- `channel_reply_structured` (NEW, must be authored, do not leave to the implementer): "Reply to a
  request that carried a `reply_schema` (e.g. the bridge handshake). `responseData` is a native
  object matching that schema. Use ONLY when the inbound `<channel>` tag has a `reply_schema`
  attribute; for all other replies use `channel_reply`."

`responseData` stays `z.record`/`z.unknown` at the boundary: the inbound `reply_schema` is
per-request but an MCP tool `inputSchema` is static, so true boundary validation is impossible.
Conformance is the consumer's job (the handshake duck-types `typeof replyAsJson.isMainOrLead ===
"boolean"` at `websocket.ts:521`).

## Wire mapping (UNCHANGED wire; non-strict-strip footgun)

`RespondBodySchema` (`routes.ts:129-144`) already has `status?`, `response?`, `title?`, `summary?`,
`replyAsJson?` (plus `question?`, `reason?`, `estimated_minutes?`, `what_to_decide?`, `message?`,
`files?`). Mapping:

| Tool | → POST /respond |
|------|-----------------|
| `channel_reply{session_id, title, summary, full, attachments?}` | `{session_id, title, summary, response: full, files?}` |
| `channel_reply_structured{session_id, responseData}` | `{session_id, replyAsJson: responseData}` |

**FOOTGUN (audit: wire-mapping, major - re-framed for `full`):** `RespondBodySchema` is **NOT
`.strict()`** (plain `z.object`), so any body key it doesn't declare is **silently stripped**. There
is no `full` field on it, so if the prose registration passes `full` through a `{session_id, ...rest}`
spread (as the current factory does at `replyTool.ts:104`), `full` is dropped, `response` stays
empty, and the console (which renders only `response.response` at `routes.ts:936/914`) shows
NOTHING - the `2be4327` silent-empty class. **MUST: assign `payload.response = args.full` EXPLICITLY
and never let `full` reach the payload via a rest-spread.** Locked by a negative test (Verification).
(Naming the body `full` instead of `message` also dodges the distinct `RespondBodySchema.message`
field at `routes.ts:142`, which `bridgeSend.ts:89` consumes via `result.response ?? result.message ??
result.reason`.)

`ResponsePayload` (`types.ts:43-58`), the `/respond` handler, the mailbox append (`routes.ts:956-964`),
the console, and `proto/Protocol.kt` are otherwise unchanged. The handler already stringifies
`replyAsJson → response` when no prose is present (`routes.ts:873-878`), so a structured reply still
renders as pretty JSON on the console. (Audit confirmed `from`/`message_id` are inbound-only and were
never posted by the reply tools; `files` is preserved on the prose tool.)

## Implementation (TS only)

### 1. `src/shared/schemas.ts`
- Import `NoticeTitle`, `NoticeSummary`, `NoticeFull` from `./notice.js`.
- Replace `ChannelReplySchema` (lines 34-71) with:
  - `ChannelReplySchema` = `{ session_id, title: NoticeTitle.describe(...), summary:
    NoticeSummary.describe(...), full: NoticeFull.describe(...), attachments:
    z.array(z.string()).optional() }.strict()`.
  - `ChannelReplyStructuredSchema` = `{ session_id, responseData: z.record(z.string(),
    z.unknown()) }.strict()`.
- Remove the `.refine()` XOR and the `respondAsMarkdownString`/`respondAsStructuredData` fields.
- Keep `.strict()` on both (strict-reject of unknown keys = the loud-failure guard).
- Update `ChannelReplyArgs`; add `ChannelReplyStructuredArgs`.
- **Codegen invariant (audit: android-zero-change):** neither new schema gets `.meta({id})` and
  neither is added to `scripts/codegen-kotlin.ts` ROOTS - they are host-side tool inputs only. The
  console's reply path is the separate `ConsoleReplyBodySchema`/`ConsoleOpSchema.respond`, untouched.

### 2. `src/mcp/bridge/replyTool.ts`
- DELETE the generic `registerReplyTool` factory and the `ReplyArgsBase` interface (replaced by two
  small purpose-built registrations in `channelReply.ts`, step 3).
- KEEP `readReplyAttachment` (shared by the prose tool AND `notify_human`).
- ADD a shared internal helper `postReply(payload, {toolName, logPrefix})` owning the common skeleton:
  `routerPost("/respond", payload)`, the outer try/catch returning "Failed to send reply", the success
  `console.error` log, and the "Reply sent." return. Export it + `readReplyAttachment`.
- The dead `status` handling (`replyTool.ts:13/80/105/134`) is removed HERE (NOT in step 1 - the
  schema never had a `status` field; the dead status lived in this handler).

### 3. `src/mcp/channel/channelReply.ts` + `src/mcp/bridge/registerBridgeTools.ts`
- `channelReply.ts` OWNS both registrations (it already exports `registerChannelReply` at line 5 -
  keep that name, add the second). Do NOT create a second `registerChannelReply` in `replyTool.ts`
  (duplicate-symbol footgun, audit: factory-refactor/scope).
  - `registerChannelReply`: build `{ session_id, title, summary, response: args.full }`, resolve
    `attachments → files` via `readReplyAttachment` (with its own attachment-error catch), then
    `postReply`. NO runtime empty-guard needed (schema requires title/summary/full, all min(1)).
  - `registerChannelReplyStructured`: build `{ session_id, replyAsJson: args.responseData }`, then
    `postReply`. **REQUIRED handler guard (audit: empty-guard, NOT optional):** reject when
    `Object.keys(responseData).length === 0` - `z.record` accepts `{}` and the SDK validates the
    schema before the handler, so `{}` would stringify to the literal "{}" on the console (the
    silent-empty class). This is the SOLE protection against an empty structured reply.
- `registerBridgeTools.ts:89-91`: register BOTH and update the log line.
- Disabled-path stubs (`registerBridgeTools.ts:59-67`): the static `crosstalk_reply` stub is
  unaffected (no factory/field refs). Scope decision: leave the disabled stubs as-is for this change;
  a separate cleanup can rename `crosstalk_reply → channel_reply` and add a structured stub.

### 4. `src/mcp/index.ts` (MCP server instructions - the WHOLE `CHANNEL_INSTRUCTIONS` array, lines 22-27)
- Edit the WHOLE array, not just lines 23-25. **Line 26 currently says title/summary are OPTIONAL
  ("Omit them for short or plain replies") - the EXACT OPPOSITE of the new required schema** (audit:
  3 dimensions flagged this). Rewrite/delete it so the instructions state title + summary + full are
  REQUIRED on `channel_reply`.
- Reply guidance: "Reply with `channel_reply` (session_id + title + summary + full; renders markdown +
  mermaid). When the inbound tag carries a `reply_schema`, use `channel_reply_structured` with
  `responseData` matching it." Keep the "metadata rides as tag attributes" sentence.
- (Audit confirmed there is NO second/duplicate server-instructions string; this single block is the
  only edit unit. This block is ALSO the answer to "how does the agent know to reply on the channel"
  once metaInstruction is gone - see below.)

### 5. `src/gateway/websocket.ts` (handshake prompt, the shared `sendHandshake(ws, team, subId)`
function at lines 201-215)
- **Hardcode the new tool name (decided 2026-07-09 - see "What was rejected" for why this replaces
  transition-safe wording).** The owner accepts the "switching pain" of a coordinated plugin + gateway
  restart, so there is no deploy-skew window to design around. The body can simply name
  `channel_reply_structured` directly instead of the tool-agnostic `isMainOrLead: true/false` phrasing
  this step originally called for - simpler prompt, no dual-path duck-typing to maintain in
  `resolveHandshake` for its own sake.
  NOTE: the prompt is no longer a single inline send - commit `ac156e4` (2026-07-07, "Re-send the
  lead handshake to an unconfirmed session each heartbeat") extracted it into `sendHandshake()`,
  called from the original register-time site (now line 348) AND a new heartbeat-tick resend loop
  (lines 163-175, gated by `HANDSHAKE_MAX_ATTEMPTS = 20` at line 90) that re-sends the same prompt to
  any still-unconfirmed channel socket roughly every 30s. Editing the wording once in `sendHandshake()`
  still fixes both call sites.
- KEEP `replyJsonSchema` (inside `sendHandshake()` at `websocket.ts:211`) - it is **DUAL
  load-bearing** (audit: handshake nit): both the inbound `reply_schema` tag attribute
  (`channelNotify.ts:34`) AND the auto-reply fast-path gate (`src/mcp/bridge/helpers.ts:178-179`). Do
  not remove/rename it during the field cleanup.
- **The blast radius is confirmed (audit: rollout, minor):** `setIsMainOrLeadAgent` has zero callers
  repo-wide - reconfirmed 2026-07-09, the only match anywhere in `src/` for that symbol is its own
  definition at `src/mcp/bridge/helpers.ts:58` - so `isMainOrLeadAgent` is permanently `null` and EVERY
  handshake falls through to the LLM tool path (fallthrough comment at `src/mcp/bridge/helpers.ts:191`;
  the actual channel_push-to-LLM dispatch is `src/mcp/bridge/helpers.ts:202-207`) - the auto-reply branch is confirmed
  dead, not merely apparently so. Design for the universal-LLM-path case as the only case; no further
  confirmation needed during implementation.

### 6. Docs
- `CLAUDE.md:40` (the `channelReply.ts` bullet) + the `replyTool.ts` bullet (still says "used by
  channelReply and cliReply" - stale) → describe two tools + shared helpers.
- `CLAUDE.md:120` - delete the stale `status:"running"/"completed"` interim-update paragraph.
- `skills/crosstalk/SKILL.md` - drop/repoint the "Reply statuses" section (`SKILL.md:83-86`, status is
  no longer tool-settable for `channel_reply` - leave the separate, still-accurate "Response Statuses"
  section at `SKILL.md:45-58` alone, it documents `crosstalk_send`'s still-live `ResponseStatusSchema`
  enum and is unrelated) and add a new sentence noting the two-tool split near `SKILL.md:76` (there is
  no existing split-related text there yet - it is currently just the plain single-tool call-out
  "**switchboard:channel_reply()** with that session_id." - so this is new prose to insert, not a
  rewrite).
- `README.md:99` - add a `channel_reply_structured` row to the tool table; confirm the architecture
  diagrams (`README.md:25/35`) stay accurate.
- `src/mcp/channel/humanTools.ts:33` cross-reference to `channel_reply` stays valid (still the
  conversational reply) - note the file lives under `channel/`, not `bridge/`.

## What was rejected (panel consensus) and why
- **`metaInstruction` as a field**: the `2be4327` magic-token class (must-match constant = silent
  drop; never-read default = noise inviting mis-fill). **How the agent still knows to reply on the
  channel without it** (the user's question, recorded so it is not re-litigated): the channel frame is
  AMBIENT, carried by three things that all remain - (1) the inbound `<channel source=... session_id=...
  from=...>` tag, re-injected on EVERY turn; (2) the persistent MCP server `instructions`
  (`index.ts:22-27`, surfaced once in the system prompt - the stable how-to-reply); (3) the tool's own
  name + description (`channel_reply` = "reply to an incoming channel message"). The required
  `session_id` echo is the real re-anchoring act: to reply at all the agent must read the session_id
  back off the tag, which re-pins the frame. metaInstruction merely duplicated this ambient frame as a
  per-call constant the model had to reproduce.
- **`sessionId` camelCase rename**: breaks the verbatim-echo invariant (inbound is `session_id`).
- **`responseData` as a JSON string**: the one genuine wart; fixed by the native object.
- **One-tool-with-object-field**: rejected; the user wants the variants killed - two closed-shape
  tools is the cleaner realization.
- **Transition-safe / tool-agnostic handshake wording** (rejected 2026-07-09, superseding the
  2026-07-09 Refresh note that had bumped the associated fallback-hardening bullet to MAJOR): the
  owner accepts the "switching pain" of a coordinated plugin + gateway restart instead of engineering
  the handshake prompt to survive a rolling/skewed deploy. With no cross-version window to design
  around, the prompt can hardcode `channel_reply_structured` directly (see step 5). This also drops
  the escalation of "harden the prose fallback" (`resolveHandshake`'s `/true/i.test(response)`
  fallback, `websocket.ts:524`) - that bullet's severity was raised specifically because a skew window
  could recur the mismatch up to 20 times via the heartbeat-resend loop; with no skew window by
  design, the underlying regex fragility reverts to a pre-existing, independent nit, not required by
  this plan (`plans/pain-points.md` is the right home for it if it ever wants a dedicated fix).

## Verification
- TS gate: `bun run lint && bun run test`.
- **Rewrite `src/__tests__/strict-schemas.test.ts` WHOLESALE** (audit: test-coverage - do NOT patch in
  place; all four cases reference removed fields, the positive case hard-fails, the `.refine()` case is
  obsolete). Import BOTH schemas. Cases:
  - `ChannelReplySchema` accepts `{session_id, title, summary, full}` (and a variant with
    `attachments`) - the positive case that catches an over-tight constraint.
  - rejects missing `title`, missing `summary`, missing/empty `full` (`""`, locks `NoticeFull` min(1)),
    an unknown key (strict), and `{session_id, attachments:[...]}` with no `full` (attachments-only).
  - `ChannelReplyStructuredSchema` accepts an object `responseData`, rejects a string.
- **NEW `src/__tests__/reply-tool.test.ts`** (audit: test-coverage/empty-guard, major - the mapping +
  empty-`{}` guard live in the HANDLER, not the schema, so `safeParse` cannot cover them). Make the
  payload construction testable (extract pure `buildChannelReplyPayload`/`buildStructuredReplyPayload`
  mappers, OR `vi.mock("../bridge/helpers.js")` to capture the `routerPost` payload - note there is no
  existing precedent for mocking a local helpers.js module in this test suite today; `tmux-core.test.ts`
  mocks node:child_process's spawn() directly at line 19, a different module for a different subsystem,
  and its line 13 is just a scripted-stderr fixture variable, not a mock call. This new test would be
  the first to establish the local-module `vi.mock` pattern here.). Assert:
  - prose: POST body has `{session_id, title, summary, response}`, `response === full`, and **NO
    `full` key** on the body (the non-strict-strip negative-assert).
  - structured: body has `{session_id, replyAsJson}`, `replyAsJson === responseData`, and **NO
    `response`**; `attachments → files`; `responseData: {}` returns `isError`.
- NO Android build needed (no `proto/Protocol.kt` change). Confirm `bun scripts/codegen-kotlin.ts` is
  a no-op diff.
- Behavioral: a real handshake (agent registers, `isMainOrLeadAgent === null`) round-trips and
  resolves lead/worker correctly; a normal channel reply renders title/summary/body on the console.
- Awareness: `src/__tests__/websocket.test.ts` gained three new tests under commit `ac156e4`
  (2026-07-07) covering the heartbeat handshake-resend (asserting on `ws.data.hsAttempts` and the
  exported `heartbeatTick()`: resend-while-unconfirmed, stop-on-confirm, stop-at-attempt-cap). They
  assert on retry counters/behavior, not the prompt's exact wording or tool names, so a step-5 wording
  rewrite should not break them - but they run alongside whatever this plan changes in
  `sendHandshake()`, so treat them as expected adjacent coverage, not a surprise regression, when
  running the full TS gate.

## Deploy (gateway rebuild IS required - coordinated)
Step 5 edits `src/gateway/websocket.ts`, so **the gateway MUST be rebuilt** - this is not a
plugin-only change. Treat the plugin + gateway as a single coordinated restart (owner-accepted
"switching pain," 2026-07-09):
0. **Bump the version first** (`package.json` and `.claude-plugin/plugin.json` - the MCP server's
   own reported version reads `packageJson.version` directly, `src/mcp/index.ts:44`, so no third
   literal to edit). Per this repo's own plugin-update deploy sequence: the marketplace decides
   whether an update exists by diffing `plugin.json`'s version, so `reload_plugins` silently no-ops
   fleet-wide without this - the redesign's own coordinated-restart premise depends on it.
1. Reload all live plugins (`reload_plugins`) so agents register the new tools.
2. Rebuild the gateway (`./down.sh && ./start-gateway.sh`) so it emits the new handshake prompt.
Any session mid-handshake during the restart reconnects afterward via the existing heartbeat-resend
loop (`ac156e4`, up to `HANDSHAKE_MAX_ATTEMPTS = 20` attempts over ~10 minutes) - no graceful-transition
machinery needed since both sides restart together. No APK.

## Forward-looking (out of scope, recorded)
- **Multi-way chats rising to the Console**: the required `{title, summary, full}` triple is the
  groundwork. **Caveat (audit: rollout nit):** the cross-Gateway `response_push` relay
  (`routes.ts:915-925`) forwards only `status/response/files` and DROPS `title/summary`, so the
  uniform-headline premise holds only for SAME-gateway replies until that relay is extended to carry
  the tiers. The user flagged the multi-way view as the direction; track extending the relay as the
  paired follow-up.
- **Real structured validation**: only achievable if the request side emits a real JSON Schema,
  persisted by `session_id` and validated in `/respond` at runtime. The single current producer (the
  handshake) does not justify it.

## Gotchas
- `status` is NOT fully dead on the WIRE - the gateway synthesizes `"running"`
  (`routes.ts:460/818/1028`), the handshake auto-reply posts `"completed"`
  (`src/mcp/bridge/helpers.ts:184`, currently dead per step 5), and two response_push sites carry it:
  **`routes.ts:918` = cross-Gateway relay (inside `relayWithRetry(...)`, routes.ts:915-925);
  `routes.ts:935` = LOCAL sender push (inside the `push` object, routes.ts:934-938)**. Do NOT remove
  `status` from
  `RespondBodySchema`/`ResponsePayload`/the mailbox. Removal from the TOOL is robust independent of SDK
  strict-validation (the handler stops reading/forwarding it).
- Keep `.strict()` on both tool schemas - it converts a mis-named field from a silent empty into a
  loud rejection. (`RespondBodySchema` on the WIRE side is deliberately non-strict; that is why the
  `full → response` mapping must be explicit, see Wire mapping.)
- `readReplyAttachment` (10 MB advisory cap + base64) and the new `postReply` skeleton stay shared.
- Whitespace-only content: `NoticeTitle/Summary/Full` use `.min(1)`, which accepts `" "`/`"\n"`.
  Pre-existing; tightening to `.trim().min(1)` touches the SYNCED `notice.ts` leaf (cp to nyaaskills +
  SYNC-HASH restamp), so it is out of scope here - record only.
