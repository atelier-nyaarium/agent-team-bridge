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

(pending)

# Plan

(written after the questionaire)
