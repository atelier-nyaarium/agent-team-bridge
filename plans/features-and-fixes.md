# Features and fixes (backlog - not yet scoped)

A backlog of larger feature ideas, jotted for later. No items are currently scoped for
implementation; each below needs its own scoping/design pass before work starts. (The CLI teardown
+ create-session + Copilot items moved into the host-split plan, `bug-class-decisions.md` Phase 6.
Items 5 and 10 - the TTS volume slider and the 500 MB attachment cap raise - shipped and were
removed from this file; see git history for their original scoping if needed.)

`android/.../` below abbreviates `android/app/src/main/java/com/atelier_nyaarium/switchboard/`
(package `com.atelier_nyaarium.switchboard`).

---

## Item 8 - at-rest encryption on device (PIN-gated)

**Idea.** Everything on the device is encrypted at rest behind the user's PIN. Lose the PIN -> lose the setup (no recovery). The user's Evie mailbox + storage are encrypted too. The only thing an admin can do is EVICT and DELETE the account - never read it. Question to settle: is that posture practical?

**Quick grounding (not a design).**
- On-device: the app already uses EncryptedSharedPreferences for secrets, and the owner root key is generated silently on the phone and never leaves it (see `FederationManager.ownerIdentity()` in the Android tree; CLAUDE.md "Federation trust"). So device-side at-rest encryption is partly in place; a PIN gate over the keystore would extend it. "Lose PIN = lose setup" is consistent with the existing no-silent-re-root recovery stance.
- Evie-side mailbox/storage: today the `DeviceMailbox` entries and the console relay are E2E SEALED in transit (`gateway/console/`, `consoleSealer`), but evie's at-REST storage of mailbox contents is a separate question - needs a look at what evie persists (the `evie-federation` k8s Secret holds trust state, not message bodies; where do mailbox bodies live and are they encrypted at rest?).
- Admin = the operator/owner. "Evict + delete only, never read" lines up with the multi-tenant `TenantAdmin` model (operator can `remove_tenant`) - confirm the admin has no decryption path to a guest's mailbox.

**Open questions to revisit.** PIN recovery vs. hard loss (acceptable UX?); whether evie persists any plaintext message bodies at rest; key-derivation (PIN -> KEK) + rate-limiting/brute-force; what "delete account" guarantees server-side.

---

## Item 14 - app-side plugins support (bake-in a few, toggle on/off)

**Idea.** Add a plugins layer to the Android app: extra app-side capabilities the user can turn on/off from settings. For now, BAKE IN a few good ones (ship them in the APK) behind per-plugin toggles, rather than a full third-party install story. The toggle-able set is the MVP; a dynamic install/marketplace path is later.

**HARD REQUIREMENT for the follow-up.** When this item is actually picked up, it must FIRST `git clone` the user's `nyaarium/nyaadot` project into `/tmp/` and base the plugin model **100% on the schema modularity defined there**. Do not design a bespoke plugin schema for switchboard - adopt nyaadot's schema verbatim as the source of truth for how a plugin is described, declared, and toggled. The clone-and-read step is a precondition to any scoping or design work on this item.

```bash
git clone https://github.com/nyaarium/nyaadot /tmp/nyaadot
# then read its schema/modularity model and base the plugin design entirely on it
```

**Quick grounding (NOT a design - revisit after the nyaadot clone).**
- The app already has a settings surface (`MainActivity.kt:App`, the TTS settings composable with `autoPlayOptions`, voice picker, etc.) and a persistence layer (`AppStateStore.kt` over EncryptedSharedPreferences with the lowercase-underscore `KEY_*` convention) - a per-plugin enabled flag fits the existing `var x: Boolean` property pattern there.
- The thread renderer is already an extensible WebView (`assets/thread/thread.js` + `thread.html`, vendoring markdown-it) with a `@JavascriptInterface` bridge - a likely host for any render-side plugin behavior.
- Decide once nyaadot's schema is in hand whether a "plugin" here is a render/transform hook, a settings-driven behavior toggle, or a sandboxed module - nyaadot's modularity schema dictates this, not a fresh switchboard invention.

**Open questions to revisit (after reading nyaadot).** What exactly nyaadot's schema models a plugin as (manifest shape, capability surface, enable/disable semantics); which baked-in plugins to ship first; where toggle state persists (likely `AppStateStore`) and whether it needs to sync server-side or stay device-local; sandboxing/trust if any plugin can touch message content or the bridge; whether the eventual dynamic-install path reuses the same schema.

---

## Moved out: Items 11-13 -> the host-split plan

The CLI-era teardown, the create-session button, and Copilot support are now subsumed into
`bug-class-decisions.md` Phase 6 (split the host: demote the host-agent, headless multi-session
daemon). They were removed here to avoid a split source of truth.
