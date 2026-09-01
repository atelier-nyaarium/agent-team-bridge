# Questionaire

Vault: secrets and notes vault, phone-approved, for agents and for the owner's own terminal.
Board entry: Vault Plugin (8fcbf63f) with three children.

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
- The console has NO push path. No FCM anywhere in the app. `tierFor` in `IdlePushbackManager`:
  foreground chains long-polls (instant); under 10 min quiet polls every 60s; under 10 h polls on
  the half hour; beyond that hourly. `WATCHED_WORKING_CAP` pins a watched working session to the
  60s tier. Approval latency IS the poll tier.
- Consequence for R3: with a human at the tty, RACE the tty and the phone; first answer wins. No
  waiting window at all. Long holds belong only to the no-tty (agent-invoked) case.
- The mailbox is per-install `conversationId`. There is no cross-console sync mechanism today.

### R6 - The helper talks to the Gateway, never the MCP server

The MCP server is per-Claude-session and dies with it; the helper must work with no agent alive.
Target is the Gateway: `127.0.0.1:20000` from the host, `http://switchboard:20000` inside a
devcontainer (the `BRIDGE_ROUTER_URL` default). Precedent: the host daemon is already a host
process holding a gateway connection. The helper identifies its caller from the parent's
`/proc/<ppid>/cmdline` (world-readable even for setuid sudo; `environ` is not), so the brief can
name `sudo apt install foo` or `ssh deploy@prod`.

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

Vault consequence for Question 1: under D, derive the vault key from the owner root (HKDF), so
the existing backup covers it with no new burden and a restored phone can unwrap. A separate vault
key would need its own backup or die with the phone. A console-only second phone cannot unwrap
under D unless the vault key rides the synced keyring that `buildConsoleTransport` already ships.

### Assumption A1 - Vault is a capability id, not a marketplace plugin

Treated as a new id beside `taskboard`, `designer`, `references` in the shared capabilities
module, gated per session like the others. Not a separate plugin with its own MCP server.

## Question 1 - Where does vault authority live?

Q: Who holds the secrets at rest, and who can answer a request?

(pending)

# Plan

(written after the questionaire)
