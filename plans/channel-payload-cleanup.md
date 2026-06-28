# Channel payload cleanup

A follow-on cleanup arc from the network-addressing migration: the channel/response notification
payloads (`ChannelPushPayload`, `ResponsePushPayload`, the `channel_reply` tool) had accreted
CLI-era cruft - structured data jammed into prose, plus vestigial fields with no live consumer.
Driven by repeated produced-vs-consumed and counterfactual-removal audits.

## Shipped

- **7.1.0** - security hardening: inbound `/send` fields (`sessionId`/`returnRoute`/`dstDomainId`)
  are honored only on the trusted gateway-relay path (`trustedInbound`), so an external `/send`
  cannot forge them. The forge-guard was reviewed and KEPT (load-bearing).
- **7.1.1** - stopped jamming structured fields into the notification prose: `content` is the
  message only; structured fields ride in `meta` (the harness renders meta keys as `<channel ...>`
  tag attributes). Reply-instruction boilerplate moved once into the MCP `instructions`.
- **7.2.0** - clean-break dropped the vestigial/dead set source-to-sink (TS + Kotlin codegen):
  `request_type`, `effort`, `is_follow_up`, `discord_message_id`; the six dead `ResponsePushPayload`
  echoes; the `crosstalk_send` `type`/`effort` tool params; matching `FederatedOpSchema` +
  `MailboxEntrySchema` fields. Built + merged, NOT yet deployed.

## Counterfactual reductions

A counterfactual-removal audit ("delete the field: does the system still function identically,
degrade, or break? is its value derivable from another field?") found every remaining field earns
its place EXCEPT two trivial reductions. Both are gateway/MCP-only: they touch the routes-local
`SendRequestSchema` and the `ChannelPushPayload` TS type, NEITHER of which is zod-codegen'd, so
there is NO Kotlin/Android impact and `Protocol.kt` must stay unchanged. Fold into the pending
deploy as 7.2.1.

- [ ] **`message_id` lazy-mint.** `routes.ts` mints `messageId = crypto.randomUUID()` on EVERY send
  and sets it on the channel payload, but its sole reader is `channelNotify` as the file-bucket key,
  guarded by `&& bucketKey` and only when `files` are present. The console drops it; Android never
  sees it. Change: mint `messageId` only when `files` are present, and set `message_id` on the
  channel payload only then. Fileless sends carry no `message_id`. Verify no other consumer.
- [ ] **Remove the dead `/send` -> `replyJsonSchema` plumbing.** The ONLY producer of
  `replyJsonSchema` is the handshake (`websocket.ts`), which sets it on the `channel_push` via a
  direct `ws.send()` that BYPASSES `routes.send`. So `SendRequestSchema.replyJsonSchema`
  (routes.ts ~106), its destructure (~612), and the `channelPayload.replyJsonSchema` forward (~767)
  are a dead path - no caller ever POSTs it to `/send`. Remove those three. KEEP
  `ChannelPushPayload.replyJsonSchema` (the handshake sets it directly), the `helpers.ts` handshake
  gate, and the `channelNotify` `reply_schema` meta. Consequence: the previously-flagged
  cross-Gateway `replyJsonSchema` gap becomes moot (there is no `/send` producer to drop).

Removable-in-theory but intentionally NOT cut: the two `type` discriminants (shape-dispatch could
replace them, but it is the idiomatic discriminated union - invasive + fragile for zero real gain).

## Verify

- [ ] `bun run lint && bun run test` - full suite; `federation.test.ts` (the `isMainOrLead`
  handshake + the forge-guard) MUST stay green.
- [ ] Confirm zero codegen drift: `bun scripts/codegen-kotlin.ts` leaves `Protocol.kt` unchanged
  (these reductions touch no codegen'd schema).
- [ ] Bump 7.2.1, commit, push; deploy folds into the pending 7.2.0 cutover (gateway rebuild +
  `reload_plugins` + the APK, which is functionally unchanged).
