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

## Moved out: Items 11-13 -> the host-split plan; Item 14 -> plans/plugins.md

The CLI-era teardown, the create-session button, and Copilot support are now subsumed into
`bug-class-decisions.md` Phase 6 (split the host: demote the host-agent, headless multi-session
daemon). Item 14 (app-side plugins support) moved to `plans/plugins.md` when its scoping pass
started - the nyaadot hard requirement was discharged there and that file is now the sole source
of truth. They were removed here to avoid a split source of truth.
