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

(This shape was then run through a 9-dimension audit-fan-out pass, which corrected several details -
the redelivery/idempotency contract, exception containment, the `team` field on `PluginAction`, target
scoping, the disabled-plugin limitation, cutting the two hygiene fixes, and tool naming. The `## Plan`
section below is the authoritative, audit-corrected version; treat any conflict with the bullets above
in the Plan's favor.)

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

**The generic plugin-action envelope.** `{ pluginId, actionType, payload, team }`, routed through a
new `PluginHost.pluginActions: PluginRegistry<PluginActionHandler>` a plugin claims `pluginId:actionType`
keys on. `PluginAction` carries `team: String` alongside the opaque `payload` - mirroring
`InboundMessage`'s shape (`PluginEntry.kt`), since the only named consumer (`DesignStore.delete(team,
fileName)`) requires it and `team` is already resolved in scope at the drain site. `pluginId`/
`actionType` are NOT duplicated onto the object - the registry claim key already disambiguates which
handler receives it, the same way a single `InboundMessageHandler` claim needs no redundant kind field.
Unclaimed (the plugin is disabled or the id/type is unknown) = silently skipped, no error surfaced to
the caller (see the "Known limitation" callout below for why this is fine for now, not free).

**Idempotency contract (audit finding, redelivery).** The mailbox is at-least-once: a crash between
dispatch and `mailboxSync.commit` redelivers the identical entry on the next poll. Unlike every
existing kind, this branch does NOT route through `appendInbound`'s persisted (epoch, seq) fold (that
fold renders a chat `Message` row, which a plugin action explicitly should not do), so a
`PluginActionHandler` gets AT-LEAST-ONCE dispatch, not exactly-once. Building a full persisted
at-most-once marker for this is deferred (it would mean routing through `appendInbound` with a new
`Message.isPluginAction` flag and thread-renderer suppression - real work with only one, already-
idempotent consumer to justify it). Instead: **`PluginActionHandler` carries a MANDATORY idempotency
contract** (documented in its KDoc, mirroring `InboundMessageHandler`'s own "idempotent" doc-comment) -
every implementation MUST treat a duplicate dispatch of the same payload as a safe no-op. The shipped
consumer already satisfies this: `DesignStore.delete` checks list-size-before-write, so deleting an
already-gone filename is a true no-op (no `teamGen` bump, no write, no resurrection risk). Revisit the
heavier persisted-marker approach only if a future action type cannot be made naturally idempotent.

**Exception containment (audit finding).** Dispatching to `host.pluginActions` means running
PLUGIN-supplied code synchronously inside the same per-entry drain loop that runs before
`mailboxSync.commit` - unlike the `"sent"` branch this shape is modeled on, which only calls
first-party code. Wrap the claimed handler's invocation in `runCatching { ... }.onFailure {
DebugLog.log("Drain", "plugin action threw: $it") }`, mirroring the existing `inboundMessages`
fan-out's guard (`Plugins.kt`), so a throwing handler cannot abort the drain for every team - load-
bearing the moment a second, less-trivial action type exists.

**Transport: a new mailbox entry kind, not a new command channel** (see Questionaire #3 for the full
adversarial-debate rationale). Concretely:
- `src/shared/schemas.ts` - add `"plugin_action"` to `MailboxEntrySchema.kind`'s enum; add optional
  `pluginId: z.string()`, `actionType: z.string()`, `payload: z.record(z.string(), z.unknown())`
  fields (mirror the existing `replyAsJson` pattern - no new record shape, confirmed schema/codegen-
  safe by audit). Regenerate `proto/Protocol.kt` (`bun scripts/codegen-kotlin.ts`); `kind` stays
  open-String decode-side per the existing codegen rule, so an old console build degrades safely into
  the existing bodyless-entry skip.
- `src/shared/federation-protocol.ts` - `FederatedOpSchema`'s `console_push.entry` is a SEPARATE,
  narrower inline schema (the cross-Gateway relay wire shape), not `MailboxEntrySchema` itself; add
  `"plugin_action"` to its own `kind` enum plus the same three fields, mirroring how `notice`/`peer`
  already carry their own fields there. Without this, `fanOutConsolePush`'s entry does not even
  type-check as a `ConsolePushEntry`, and a real receiving Gateway's `FederatedOpSchema.parse` (a
  throwing parse) would reject the relay - this is not optional for the multi-gateway case (Phase 1
  align-audit finding: the plan omitted naming this file, though the implementation correctly
  included it; now documented).
- `src/gateway/routes.ts` - a new `landMailboxEntry`-based composer (mirroring `mirrorPeer`/
  `consolePush`'s append shape), `session_id` built the same way `mirrorPeer` does
  (`storeKey({kind:"conv", conversationId: owner, address: threadAddr})`), so team resolution on the
  Android side works for free (confirmed by audit: needs zero new drain-loop resolution logic).
- Byte-cap accounting and eviction-priority for the new kind were both considered and CUT (audit
  finding: negligible at this app's realistic scale - a filename-sized payload against a 2 GB/10,000-
  entry cap, and the payload's own reasoning for "evict like peer" doesn't even hold since delete is
  the canonical mutation, not a redundant display copy like `peer` is; default FIFO priority is already
  the correct behavior with no code change). Revisit only if a future action type carries a
  genuinely large payload.

**Target scoping - no field to pick a target OTHER than your own `from` (real, but bounded, guarantee -
corrected by a Phase 1 red-team pass).** The composer derives `threadAddr` SOLELY from the request's
own `from` field (`localAddress(from)`) - the wire body carries no separate "to"/"target"/"team" field
a caller could add ON TOP of `from` to reach a different conversation. `PluginActionRequestSchema` is
`.strict()`, and Phase 1's vitest suite pins that no combination of fields lands under any address
other than `localAddress(from)`.

This is NOT a new authentication boundary, and the plan originally overstated it as one. `from` itself
is an unauthenticated, client-supplied string - EXACTLY the same trust level as `send()`'s own `from`
(read `send()`'s body: it is never cross-checked against the registry). The whole MCP-to-gateway HTTP
surface is same-docker-network trust, not per-team authenticated (every project on the host shares one
`switchboard` network and can reach the gateway directly) - a pre-existing, already-tracked gap
(`plans/gateway-auth-surface.md`), not something this feature introduces or was ever going to close.
So the real guarantee here is narrower than "a caller can only act on its own conversation": it is "a
plugin action has no MORE room to pick an unrelated target than `send()`/`respond()`/`notify_human`
already have today." Closing the underlying impersonation gap (a compromised or malicious co-tenant
container claiming someone else's `from`) is `gateway-auth-surface.md`'s job, not this plan's - do not
re-litigate it here, and do not build per-project auth as part of shipping delete.

**Payload hardening (red-team finding, fixed).** `payload` had no size limit and `entryBytes()` never
counts it, so an oversized or pathologically nested payload could reach the mailbox and stall the
gateway's shared event loop on the durable-store snapshot timer (a synchronous `JSON.stringify` +
`writeFileSync` every few seconds over the WHOLE mailbox store). Fixed with a small byte cap
(`MAX_PLUGIN_ACTION_PAYLOAD_BYTES`, proportionate to "a plugin action payload is meant to be tiny," not
`MAX_RESPONSE_FILE_BYTES`'s file-sized ceiling), enforced at both the origin composer and the
`consolePush` landing side (so a relayed federated entry gets the same defense-in-depth, not just a
locally-composed one).

**Composite-key collision (red-team finding, fixed).** `pluginId`/`actionType` had no character
constraint, unlike every other identifier that feeds a composite key in this codebase. Since the
framework's own convention is a colon-joined `pluginId:actionType` claim key (`PluginRegistry.kt`'s
doc), an unconstrained colon inside either half could let two DISTINCT wire payloads collapse onto the
same composite key once Phase 2 builds dispatch. Fixed: both fields are now slug-constrained (reusing
`isSlug`/`SLUG_RE` from `session-id.ts`, the same gate every other composite-key identifier in this
codebase already goes through), enforced at both the origin schema and federation-protocol.ts's
relayed-entry schema.

**Known limitation - a disabled plugin silently and permanently drops the action (audit finding, not
fixed here).** "Unclaimed = silently skipped" is the same best-effort posture the mailbox already gives
`mirrorPeer`/`consolePush`/`notify_human` - but those are all REDUNDANT DISPLAY COPIES of state
delivered correctly elsewhere, so dropping them loses nothing canonical. A delete-card action IS the
canonical mutation (nothing else deletes a card), so if Designer is disabled when the action is
delivered, the delete silently no-ops, the card survives, and the agent gets no signal the deletion
never took effect (the gateway only knows the mailbox WRITE succeeded, not whether a plugin ever
claimed it). This is the same bug class as `plugin-pipeline-hardening.md`'s "disabled-plugin-forget
gap" and is explicitly NOT solved by this plan - a real fix (a persisted pending-action ledger, or
running lifecycle handlers even for a disabled plugin) belongs with that tracked item, not bundled
into shipping delete. Documented here so the limitation is known, not silently inherited from a
precedent (`mirrorPeer` et al.) that doesn't actually apply to this consumer.

**Android console.** A FOURTH early-exit branch in `ChatRepository.kt`'s drain loop, structurally
close to the existing `kind == "sent"` branch (early continue before the body/files/status skip-gate,
so it never depends on a nonempty body) but with the exception guard above added: resolve `team` the
normal way, `continue`, then dispatch to the new `host.pluginActions` registry inside `runCatching`.
NOT the existing `inboundMessages`/`InboundMessage` - that extension point only fires downstream of
the same skip-gate, from an already-rendered `Message`, and cannot carry the new envelope. New
`PluginActionHandler`/`PluginAction` types in `PluginEntry.kt` (with the idempotency contract KDoc),
bridged in `Plugins.kt` the same size/shape as the existing `inboundMessages` bridge (built this
session - see git ffa32c4). Designer's handler for `"designer":"delete-card"` just calls the
already-existing `DesignStore.delete(team, fileName)`.

**MCP tool surface.** Two purpose-named tools, not one multi-verb dispatcher (clearer for an agent to
discover and call correctly than a stringly-typed verb param), named `designer_push_card` and
`designer_delete_card` - no `switchboard_` prefix (audit finding: every existing tool in `src/mcp/`
already lives under the `switchboard` MCP server's own namespace at the protocol level - `crosstalk_*`,
`channel_*`, `notify_human`, `reload_plugins` - none double-prefixes with the server name):
- **Push** (`designer_push_card`): wraps the EXISTING mechanism - constructs a `@dsCard`-marked `.html`
  attachment and sends it the same way a manual attachment already does (`channel_reply` attachments).
  No new wire surface; this tool is a convenience wrapper, not new plumbing. Same filename as an
  existing card = update in place (today's behavior, unchanged).
- **Delete** (`designer_delete_card`): composes and sends the new `plugin_action` mailbox entry
  (`pluginId: "designer"`, `actionType: "delete-card"`, `payload: { fileName }`) via the gateway's new
  scoped composer above. Takes no target/team/session argument - it always acts on the calling
  conversation.

### Deploying

Matches every other console-bridge wire change (CLAUDE.md "Deploying the console bridge"): merging
Phase 1 to `main` does not make it live. The target gateway container(s) need a restart
(`./down.sh && ./start-gateway.sh` or equivalent) before the new mailbox kind is understood end to end,
and Phase 3's two new MCP tools need the plugin.json version bump + `reload_plugins` sequence (per the
user's standing "Plugin Update Deploy Sequence" instructions) before any Claude session actually sees
them. "Merged to main" and "works end-to-end" are separate milestones here, same as every prior
wire-shape change in this repo.

## Phase 1 - wire + gateway

The `plugin_action` mailbox kind (schema + codegen), the gateway composer (self-scoped to the
caller's own conversation, no client-suppliable target), and its vitest coverage (including the
scoping-invariant test). No `device-mailbox.ts` changes needed - the hygiene fixes considered during
refinement were cut as unnecessary at this payload's scale. Vitest-testable independent of the
Android side.

## Phase 2 - Android framework + Designer consumer

`PluginHost.pluginActions` registry, the `ChatRepository.kt` drain branch, `PluginEntry.kt`/
`Plugins.kt` types + bridge, `DesignerPlugin`'s delete handler. Android-unit-testable + the R8 minify
gate, same as every prior phase this session.

## Phase 3 - MCP tools

The two agent-facing tools (push wrapper, delete via the new envelope), registered in `src/mcp/`.
End-to-end testable once Phase 1+2 are live: an agent calls delete, the card disappears from the
phone's dock without the human touching it.

### Notes

- Phase 1 and 2 are cross-repo but independently mergeable/testable; Phase 3 depends on both.
- No user-facing UX decisions remain - straight to `plan-refinement` then `audited-implementation`
  cycles per phase.
- After delete ships: clean up this plan file (trim the Questionaire trail the way `plans/plugins.md`
  and `plans/inbound-pipeline.md` were condensed/retired after their own ship), matching the session's
  established convention - either fold residuals into `pain-points.md`/`features-and-fixes.md` and
  delete this file, or trim it to a short "shipped" summary if it stays as a reference for the next
  plugin-action consumer.
