# Plugin actions (generic agent-initiated dispatch; Designer push/delete as the first consumer)

Extracted from `features-and-fixes.md` Item 15's "DesignSync-parity push tool" once scoping revealed
it needed a genuine framework, not a one-off wire addition (user: "Let's think framework first. We
could do SO MANY things if we had custom protocols").

## Questionaire

**1. Build the DesignSync-parity MCP tool, or is attach-a-file-with-a-marker enough?**
Both. An agent can push/update a card either by attaching a marked `.html` file (today's mechanism,
unchanged) or by calling an explicit tool - same underlying effect, parity between the two paths.
Card management (not just creation) should also be tool-reachable: "That design sucked so bad, forget
about it" -> the agent calls a delete tool, not just the human tapping Delete on the phone.

**2. How does an agent-initiated action (starting with delete) reach the phone, when today only the
phone can delete a card locally?**
Recommendation was reconsidered mid-questionaire: not a one-off "designer delete" wire message, but a
GENERIC plugin-action dispatch - `{ pluginId, actionType, payload }`, routed by a new `PluginHost`
registry a plugin claims `pluginId:actionType` keys on; unclaimed (plugin disabled/missing) = silently
skipped, no error. "Designer: delete card" is the first action type, not the only one this framework
will ever carry.

**3. Transport: ride the existing mailbox as a new entry kind, or a separate device-wide command
channel (like the terminal-view's `peek`/`tmux_send`)?**
Settled by a 2-advocate adversarial debate + 3 independent judges (2 completed, both "A", high
confidence, having independently re-verified the code themselves rather than trusting either
advocate) - **ride the mailbox as a new `MailboxEntry.kind`**. The judges corrected the framing along
the way: the mailbox is per-OWNER, not per-conversation (verified in `consoleHandler.ts`,
`device-mailbox.ts`'s own class doc) - conversation-scoping comes from the `session_id` field on every
entry, the same way `notice`/`sent`/`peer` already resolve their team, not from the container. That
correction doesn't change the verdict: the against-A case's own proposed alternative (a sibling
`pluginActions` array + a dedicated queue) needs the identical field for scoping AND has to re-derive
`DeviceMailbox`'s dedup/epoch/cursor invariants a second time in parallel - strictly more new wire
surface for one action type, the over-engineering the judge criteria explicitly warned against.
Literal "separate command channel" (a `host_op`-style live-socket push) was confirmed DEAD on arrival
by both judges and conceded by the against-A advocate itself: the console has no live WebSocket at
all (`ConsolePeer.send()` always appends to the mailbox - `consolePeer.ts`); `host_op`'s
`HostOpCoordinator` requires the host daemon's real, persistent, token-authenticated socket, which the
console structurally does not have.

**Corrected implementation shape** (both judges converged on this independently):
- `src/shared/schemas.ts`: add `"plugin_action"` to `MailboxEntrySchema.kind`'s enum, plus optional
  `pluginId`/`actionType`/`payload` fields (mirror the existing `replyAsJson: z.record(...)` pattern,
  not a new record shape). `kind` decodes as an open String on Android (codegen rule), so an old
  console build degrades safely (falls into the existing bodyless-entry skip, not garbage).
- `src/gateway/routes.ts`: compose the entry through the SAME `landMailboxEntry` /
  `mailboxStore.ensure(owner).append(...)` path every other kind uses, `session_id` composed the same
  way `mirrorPeer` does (`storeKey({kind:"conv", conversationId: owner, address: threadAddr})`) so team
  resolution works for free. Best-effort delivery, consistent with the feature's own "silently skipped
  if unclaimed" posture and every other mailbox-writer's documented "never load-bearing" stance.
- `android/.../ChatRepository.kt`: a FOURTH early-exit branch in the drain loop, structurally identical
  to the existing `kind == "sent"` branch - resolve team the normal way, `continue` BEFORE the
  body/files/status skip-gate (so it never depends on a nonempty body), dispatch to a NEW
  `host.pluginActions` registry. NOT the existing `inboundMessages`/`InboundMessage` - both judges
  independently confirmed that extension point only fires downstream of the same skip-gate, from an
  already-rendered `Message`, and cannot carry the new envelope as-is.
- `android/.../plugins/PluginEntry.kt` + `Plugins.kt`: new `PluginActionHandler`/`PluginAction` types, a
  `pluginActions: PluginRegistry<PluginActionHandler>` on `PluginHost`, bridged in `Plugins.kt` the same
  size/shape as the existing `inboundMessages` bridge. The Designer's delete handler just calls the
  already-existing `DesignStore.delete(team, fileName)`.
- Two small hygiene fixes worth doing at the same time (cheap, in scope): fold the new payload field's
  length into `device-mailbox.ts : entryBytes()`'s cap accounting (today only counts `body` + files);
  make a deliberate, one-line, reversible call on whether `evictOneForCapacity` treats `plugin_action`
  like `"peer"` (evict-first) or leaves it at default priority.
- Do NOT build a parallel `pluginActions` array + dedicated queue on the poll result - that duplicates
  `DeviceMailbox`'s invariants a second time for a single action type.

**4. Tool surface, and are the other Item 15 sub-items in scope?**
Thumbnails, the in-chat announce chip, index lifecycle/TTL, and toggle-state sync stay OUT of this
plan - backlogged in `features-and-fixes.md` Item 15, picked up separately later. This plan is push +
delete only. Tool naming (one tool per verb vs. a multi-verb dispatcher) has no real ambiguity to ask
about: "update" needs no separate verb (push is already create-or-update, same filename = newest
wins), so it settles to two purpose-named tools, decided directly below rather than asked as a
question.

## Plan

**Scope:** an agent can push (create-or-update) or delete a Designer card via an explicit MCP tool,
in parity with the existing attach-a-marked-file mechanism (which stays, unchanged, for push). Delete
is genuinely new - nothing today lets an agent remove a card - built as the FIRST instance of a
generic, reusable plugin-action dispatch, not a one-off wire message.

### Design

**The generic plugin-action envelope.** `{ pluginId, actionType, payload }`, routed through a new
`PluginHost.pluginActions: PluginRegistry<PluginActionHandler>` a plugin claims `pluginId:actionType`
keys on. Unclaimed (the plugin is disabled or the id/type is unknown) = silently skipped, no error
surfaced anywhere - matching the mailbox's existing "purely additive, never load-bearing" posture for
non-chat traffic (`mirrorPeer`/`consolePush`/`notify_human`).

**Transport: a new mailbox entry kind, not a new command channel** (see Questionaire #3 for the full
adversarial-debate rationale). Concretely:
- `src/shared/schemas.ts` - add `"plugin_action"` to `MailboxEntrySchema.kind`'s enum; add optional
  `pluginId: z.string()`, `actionType: z.string()`, `payload: z.record(z.string(), z.unknown())`
  fields (mirror the existing `replyAsJson` pattern - no new record shape). Regenerate
  `proto/Protocol.kt` (`bun scripts/codegen-kotlin.ts`); `kind` stays open-String decode-side per the
  existing codegen rule, so an old console build degrades safely into the existing bodyless-entry skip.
- `src/gateway/routes.ts` - a new `landMailboxEntry`-based composer (mirroring `mirrorPeer`/
  `consolePush`), `session_id` built the same way `mirrorPeer` does
  (`storeKey({kind:"conv", conversationId: owner, address: threadAddr})`), so team resolution on the
  Android side works for free, no new addressing concept.
- `device-mailbox.ts` hygiene: fold the new `payload` field's length into `entryBytes()`'s cap
  accounting (today only counts `body` + files' bytes); decide (one line, reversible) whether
  `evictOneForCapacity` treats `plugin_action` like `"peer"` (evict-first under OOM pressure) or leaves
  it at default priority.

**Android console.** A FOURTH early-exit branch in `ChatRepository.kt`'s drain loop, structurally
identical to the existing `kind == "sent"` branch: resolve `team` the normal way, `continue` BEFORE
the body/files/status skip-gate (so it never depends on a nonempty body - unlike ordinary chat), then
dispatch to the new `host.pluginActions` registry. NOT the existing `inboundMessages`/`InboundMessage`
- that extension point only fires downstream of the same skip-gate, from an already-rendered `Message`,
and cannot carry the new envelope. New `PluginActionHandler`/`PluginAction` types in `PluginEntry.kt`,
bridged in `Plugins.kt` the same size/shape as the existing `inboundMessages` bridge (built this
session - see git ffa32c4). Designer's handler for `"designer":"delete-card"` just calls the
already-existing `DesignStore.delete(team, fileName)`.

**MCP tool surface.** Two purpose-named tools, not one multi-verb dispatcher (clearer for an agent to
discover and call correctly than a stringly-typed verb param):
- **Push** (`switchboard_designer_push_card` or similar naming to settle during implementation): wraps
  the EXISTING mechanism - constructs a `@dsCard`-marked `.html` attachment and sends it the same way a
  manual attachment already does (`channel_reply` attachments). No new wire surface; this tool is a
  convenience wrapper, not new plumbing. Same filename as an existing card = update in place (today's
  behavior, unchanged).
- **Delete** (`switchboard_designer_delete_card` or similar): composes and sends the new
  `plugin_action` mailbox entry (`pluginId: "designer"`, `actionType: "delete-card"`,
  `payload: { fileName }`) via the gateway's new composer above.

### Phasing

- **Phase 1 - wire + gateway.** The `plugin_action` mailbox kind (schema + codegen), the gateway
  composer, and the `device-mailbox.ts` hygiene fixes (byte-cap accounting, eviction-priority call).
  Vitest-testable independent of the Android side.
- **Phase 2 - Android framework + Designer consumer.** `PluginHost.pluginActions` registry, the
  `ChatRepository.kt` drain branch, `PluginEntry.kt`/`Plugins.kt` types + bridge, `DesignerPlugin`'s
  delete handler. Android-unit-testable + the R8 minify gate, same as every prior phase this session.
- **Phase 3 - MCP tools.** The two agent-facing tools (push wrapper, delete via the new envelope),
  registered in `src/mcp/`. End-to-end testable once Phase 1+2 are live: an agent calls delete, the
  card disappears from the phone's dock without the human touching it.

### Notes

- Phase 1 and 2 are cross-repo but independently mergeable/testable; Phase 3 depends on both.
- No user-facing UX decisions remain - straight to `plan-refinement` then `audited-implementation`
  cycles per phase.
- After delete ships: clean up this plan file (trim the Questionaire trail the way `plans/plugins.md`
  and `plans/inbound-pipeline.md` were condensed/retired after their own ship), matching the session's
  established convention - either fold residuals into `pain-points.md`/`features-and-fixes.md` and
  delete this file, or trim it to a short "shipped" summary if it stays as a reference for the next
  plugin-action consumer.
