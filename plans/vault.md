# Questionaire

Vault: secrets and notes vault, phone-approved, for agents and for the owner's own terminal.
Board entry: Vault Plugin (`bd_1b5ca0e9`) with three children. Points refreshed 2026-09-04 on
the Router-hub substrate (main at `eb193ead`); R5 to R8 below carry the re-checked facts.

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
revision, tombstone. Sealed: public title and description, private title and description, value,
the gateway allowlist. At least one title required. Public fields are the only ones ever served
to an agent; a note is an entry with no value, so an agent can find it and never read it. The
Router sees the envelope only.

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

(pending)

# Plan

(written after the questionaire)
