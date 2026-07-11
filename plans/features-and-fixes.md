# Features and fixes (backlog - not yet scoped)

A backlog of larger feature ideas, jotted for later. No items are currently scoped for
implementation; each below needs its own scoping/design pass before work starts. (The CLI teardown
+ create-session + Copilot items moved into the host-split plan, `bug-class-decisions.md` Phase 6.
Items 5 and 10 - the TTS volume slider and the 500 MB attachment cap raise - shipped and were
removed from this file; see git history for their original scoping if needed.)

---

## Item 8 - at-rest encryption on device (PIN-gated)

**Idea.** Everything on the device is encrypted at rest behind the user's PIN. Lose the PIN -> lose the setup (no recovery). The user's Evie mailbox + storage are encrypted too. The only thing an admin can do is EVICT and DELETE the account - never read it. Question to settle: is that posture practical?

**Quick grounding (not a design).**
- On-device: the app already uses EncryptedSharedPreferences for secrets, and the owner root key is generated silently on the phone and never leaves it (see `FederationManager.ownerIdentity()` in the Android tree; CLAUDE.md "Federation trust"). So device-side at-rest encryption is partly in place; a PIN gate over the keystore would extend it. "Lose PIN = lose setup" is consistent with the existing no-silent-re-root recovery stance.
- Evie-side mailbox/storage: today the `DeviceMailbox` entries and the console relay are E2E SEALED in transit (`gateway/console/`, `consoleSealer`), but evie's at-REST storage of mailbox contents is a separate question - needs a look at what evie persists (the `evie-federation` k8s Secret holds trust state, not message bodies; where do mailbox bodies live and are they encrypted at rest?).
- Admin = the operator/owner. "Evict + delete only, never read" lines up with the multi-tenant `TenantAdmin` model (operator can `remove_tenant`) - confirm the admin has no decryption path to a guest's mailbox.

**Open questions to revisit.** PIN recovery vs. hard loss (acceptable UX?); whether evie persists any plaintext message bodies at rest; key-derivation (PIN -> KEK) + rate-limiting/brute-force; what "delete account" guarantees server-side.

---

## Item 15 - Designer plugin follow-ups (framework + Designer shipped in ffa32c4)

The app-side plugin framework and the Designer plugin shipped: a dock gallery, four management
actions (reference / reattach / download / delete), chip-open, and an additive per-team card store
fed by the inbound message pipeline. Architecture is in CLAUDE.md ("Android plugin framework"); the
full build + red-team history is in git at ffa32c4. These were deliberately deferred during the
build, each its own small scoping pass:

- ~~**DesignSync-parity MCP push tool.**~~ Shipped: `designer_push_card` (inline HTML, wraps the
  existing `channel_reply`-attachment mechanism) and `designer_delete_card` (self-scoped, via the new
  generic `plugin_action` mailbox kind - see CLAUDE.md "Console Bridge") both live in
  `src/mcp/designer/designerTools.ts`. Architecture is in CLAUDE.md ("Console Bridge (Android
  channel)"); full design + red-team history in git (commits `dc28dbb`, `95e82c8`, `f35c008`).
  Residuals in `plans/pain-points.md`.
- ~~**Rendered thumbnails**~~ Shipped (PR #112): cached bitmap snapshots via one offscreen WebView
  (`plugins/designer/DesignerThumbs.kt`), rendered on demand and LRU-cached keyed by the card's
  `rel`; dock rows and the peek strip fall back to the old glyph while rendering or for a
  missing/oversize file.
- **In-chat announce chip** (the Q4 "if easy") - a tappable "here's the thingy" chip in the chat body;
  prose plus the dock is the shipped fallback. Needs a feasibility check in the thread renderer.
- **Index lifecycle** questions: a per-conversation card cap, an explicit on-device file home plus TTL
  for card bytes (`Attachments.kt` internal storage vs a plugin-owned dir), and the eventual cleanup
  pass that walks the additive index to prune pointers whose attachment was purged.
- **Toggle-state sync**: plugin enable/disable is device-local for v1; whether it ever syncs
  server-side is open.

---

## Moved out: Items 11-13 -> the host-split plan; Item 14 -> shipped

The CLI-era teardown, the create-session button, and Copilot support are now subsumed into
`bug-class-decisions.md` Phase 6 (split the host: demote the host-agent, headless multi-session
daemon). Item 14 (app-side plugins support) was scoped in `plans/plugins.md` and SHIPPED (ffa32c4);
that plan and its `plans/inbound-pipeline.md` foundation were deleted on ship, their deferred features
folded into Item 15 above and their open bug-residuals into `plans/plugin-pipeline-hardening.md`.
