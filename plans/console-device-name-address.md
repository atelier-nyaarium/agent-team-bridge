# Console device-name address-segment bug: use the owner id for the console's own address

## The bug

A console whose device name (`Build.MODEL`) is not a slug - e.g. **"Pixel 10 Pro XL"** (spaces +
capitals) - cannot resume/send to a chat. Error: `invalid address segment "Pixel 10 Pro XL"`.

ROOT: the address grammar is `domain.gateway.spawn.session`, each segment a slug (`assertSlug`,
`/^[a-z0-9][a-z0-9-]*$/`, `MAX_SLUG_LEN=64`). The code uses the raw DEVICE NAME as the `spawn`
segment of the console's OWN address, so any free-form device name throws.

## Decision (settled): the segment is the OWNER id, not the device name

The console's own canonical address is `domain.gateway.<ownerId>.<DEFAULT_SESSION>`, where `ownerId`
is the existing `ownerKeyId` (sha256 of the owner sign-pub, 64 lowercase hex = a valid slug, exactly
`MAX_SLUG_LEN`). The device name is a DISPLAY label only.

WHY ownerId, not the per-device conversationId: a mailbox is keyed per-OWNER (shared across the
owner's devices - the user runs two consoles). An agent->console self-push lands in that shared
mailbox and is drained by EVERY device of the owner; each device's self-thread check
(`sk.address == thisDeviceAddress()`) must agree, so the self-address must be owner-scoped, not
per-device. The ownerId is also already threaded to `routes.send` as `fromConversationId`, and both
runtimes can derive it (`shared/owner-id.ts:ownerKeyId` on the gateway; a Kotlin mirror on the
client). `storeKey.conversationId` stays the ownerId (the shared mailbox key); only the address
SPAWN segment changes from device-name to ownerId. The two ids agreeing is the point.

## Evidence (confirmed: runtime + code + audit)

- Gateway log: console registered `dev=Pixel 10 Pro XL`, local domain `a95dd4e979aa3be5`; a send to a
  live `host.test` succeeded; the failing sends to the down `host.switchboard` never reached the
  gateway (`[console poll] drained=2`, cursor stuck) - the throw is CLIENT-SIDE.
- `assertSlug` throws in `src/shared/session-id.ts` AND `android/.../proto/SessionId.kt`.
- The user's actual crash is client-side: `ChatRepository.thisDeviceAddress()` builds the self-address
  from `currentDeviceName()` (the device name as spawn) and returns null for a non-slug name;
  `fromCanonical(from)` = `runCatching{ parseTarget(from) }.getOrDefault(from)` returns the RAW device
  name, so a chat is keyed by `"Pixel 10 Pro XL"` and `send(team=...)` -> `deliver` -> `parseTarget`
  throws on the phone.

## Fix

### Gateway (TS)

1. Add a single producer `consoleSelfAddress(ownerId)` -> `Address.local(localDomain, localGatewayId,
   ownerId, DEFAULT_SESSION)` (next to `localAddress`).
2. `routes.send` must build the sender's canonical address WITHOUT calling `localAddress(deviceName)`.
   Do NOT discriminate by `isSlug(from)` - an agent's `from` can be a dotted composite
   `project.session` (not a slug) yet is legitimate. Instead, `consoleHandler` (which KNOWS the send
   is console-origin) passes an explicit pre-built sender address; `routes.send` uses it when present,
   else `localAddress(from)` for agent sends.
   - `consoleHandler.ts` case "send": pass `fromAddress: consoleSelfAddress(ownerId).canonical`
     alongside the display `from: device` and `fromConversationId: ownerId`.
   - `routes.ts:399` (sendCrossGateway): set the FederatedOp `from` from `fromAddress` when provided,
     else `localAddress(from)`. Thread `fromAddress` into `sendCrossGateway`.
3. Backstop the registry-iteration `localAddress(registry-key)` sites so a console registered under a
   non-slug device name can never throw there (the console stays registry-keyed by its device name):
   - `routes.ts:683` (the not-found error response maps `registry.keys()` through `localAddress`) -
     MISSED by the first draft. Filter non-slug keys before `localAddress` (or reuse the teams() skip).
   - `routes.ts:466` (`teams()` `touchShares`) - the `461` skip catches a console with active virtual
     sockets, but add an `isSlug(name)` backstop in case a stale/edge entry slips through.
4. `routes.ts:1014` (`/human/notify` notice sender `localAddress(from)`): `from` is agent-origin
   (notify_human), so it is a slug today; add a defensive `isSlug` guard or document it as agent-only.
   Verify `gatewayRelay.ts:80` and `consoleHandler.ts:804/831` parsed-name `localAddress` calls are
   on already-validated names (the audit judged them safe).

### Client (Android, Kotlin)

1. Add `currentOwnerId(): String` = the Kotlin mirror of `ownerKeyId(ownerSignPub)` (sha256 of the
   base64-decoded owner sign-pub -> lowercase hex). Confirm whether a Kotlin `ownerKeyId` already
   exists; if not, add it (and a cross-platform vector if warranted). The owner sign-pub is held by
   `FederationManager`.
2. `ChatRepository.thisDeviceAddress()` -> `Address.local(localDomain, localGatewayId,
   currentOwnerId(), DEFAULT_SESSION)`. It then never returns null for a spaced device name, so the
   self-thread check works and matches the gateway's `consoleSelfAddress(ownerId)` byte-for-byte.
3. Make `fromCanonical` null-safe (return `String?`, `getOrNull` not `getOrDefault`): a non-address
   `from` (a raw Device Name) now yields null instead of the raw string, so NO thread-keying path (the
   notice key, the self-thread branch, the non-conv fallback) can key a thread by a non-address. The
   drain self-thread branch KEEPS threading under the sender (`e.from?.let { fromCanonical }`) but now
   falls back to `sk.address.canonical` when `from` is a non-address - preserving the original
   thread-under-sender intent while killing the corruption at its source (better than dropping the
   sender primary outright, which would regress that grouping).
4. Confirm `send`/`deliver`/`append`/`ConsoleClient.teams()`/`canonicalTarget` never synthesize a send
   target from the device name (the audit found only `thisDeviceAddress` needs the change, but verify).

### Migration (Android)

Existing threads/labels/drafts keyed by the raw device name (the user's broken "switchboard" chat) are
persisted in `AppStateStore`. Drop them with a load-time filter (`isAddressKey`) in
`loadPersistedThreads`/`loadPersistedLabels`/`loadPersistedDrafts`: a key that no longer parses as an
address is skipped on load and dropped from the re-saved map. This is surgical (only the corrupted key
is dropped; valid chat history survives) and needs no schema-version bump or broad `KEY_THREADS` wipe.
NOTE (init-order): these run during `_state` construction, so `isAddressKey` must pass `""` (not
`localDomain()`, which reads `_state` and would NPE) - a canonical 4-segment key carries its own domain,
so the arg is unused.

## Gotchas / verified

- ownerId is exactly 64 chars = `MAX_SLUG_LEN`; `isSlug` is `<= 64`, so it passes. Confirm no other
  code assumes a segment `< 64` (the audit found none; re-check tmux-name builders that consume an id).
- No wire-schema change -> no `proto/Protocol.kt` codegen; `SessionId.kt` grammar is unchanged (ownerId
  is already a valid slug). The `tests/fixtures/session-id/vectors.json` corpus stays green.
- Rollout: gateway + APK are both needed (the user's crash is client-side). The gateway change is
  backward-compatible (an old client's local send never hit the gateway leak; a new client's local
  send is fine). Ship them together; the device's broken chat clears on the APK's migration. New
  gateway with old APK does not regress; old gateway with new APK only loses the cross-gateway
  console-from path (rare) until the gateway updates.

## Verification

- TS gate: `bun run lint && bun run test`. Add tests: a console send builds an ownerId-based sender
  address (never assertSlug-throws on a device name); `teams()`/the not-found error list never throws
  on a non-slug registry key.
- Kotlin gate: `cd android && ./gradlew :app:testDebugUnitTest` (thisDeviceAddress is ownerId-based;
  the migration drops a non-slug persisted key; a cross-platform ownerKeyId vector if added). Then
  `:app:assembleRelease` for the R8 gate.
- ON-DEVICE (the only real proof): the user is on a RELEASE build I cannot observe. Ship the APK; the
  user resumes the broken "switchboard" chat, confirms the send works and the drained-loop clears. No
  "fixed" claim until the user confirms.

## Deploy

Gateway rebuild + `reload_plugins` for the TS side; an APK rebuild + app update for the client.

## Painpoints (crust scout - record only, out of scope for this fix)

### init-order `_state`-access NPE class
`loadPersisted*` run during `_state` construction (before `_state` is assigned), so anything they
reach that reads `_state.value` NPEs and a surrounding `runCatching` swallows it silently (exactly the
`isAddressKey` bug, now fixed by passing `""`). These siblings read `_state.value` via `localDomain()`
-> `confirmedDomainId()` and are SAFE today only because nothing calls them during construction - each
breaks the moment it becomes init-reachable:
- `ChatRepository.kt : canonicalTarget`
- `ChatRepository.kt : fromCanonical`
- `ChatRepository.kt : thisDeviceAddress`
- `ChatRepository.kt : forget` (also reads `_state.value.localGatewayId` directly)
Durable fix (deferred): make `confirmedDomainId()` / `localDomain()` null-safe (return `""` when
`_state` is not yet initialized), retiring the class.

### `PROJECT_NAME` / `from` not slug-validated -> `localAddress` throws
`PROJECT_NAME` is read from env and propagated as the sender `from` with no slug check, so a non-slug
value (spaces/caps) makes `localAddress(from)` throw uncaught:
- `src/mcp/index.ts : startMcp` - the root: `PROJECT_NAME` is never asserted to be a slug
- `src/gateway/routes.ts : humanNotify` - `localAddress(from)` (the schema validates length, not slug); a non-slug `PROJECT_NAME` crashes `/human/notify`
- `src/gateway/routes.ts : sendCrossGateway` - `localAddress(from)` on an agent cross-Gateway send throws on a non-slug team field

### non-address fallback leaks
- `ChatRepository.kt : canonicalTarget` - `runCatching { parseTarget(...).canonical }.getOrDefault(team)` returns the raw `team` on failure, then used as a thread-lookup key + openTabs membership; the same class fixed in `fromCanonical` (which now returns null). A malformed team silently misses rather than corrupts, so lower severity.
