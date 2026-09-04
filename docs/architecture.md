# Architecture

Entry points, addressing, sessions, and the state planes the console reads.

## Entry points

**`main-mcp.ts`** MCP plugin, user process.
**`main-gateway.ts`** Docker gateway and central router.
**`main-host-daemon.ts`** host `host` WS slot, devcontainer wake, session spawn, terminal view.
**`main-federation.ts`** self-hosted federation relay.

| Port | Service |
|---|---|
| 20000 | Gateway HTTP and WS, loopback only |
| 20001 | Federation Router TLS |
| 20002 | MCP connector WS |
| 20003 | Enrollment TLS, one-time nonce |

**Bootstrap values:** `GatewayBootstrap.resolve(paths, env, io)` decides the gateway's boot
(`active`, `arming`, or `standalone`) and carries the identity, Domain id, transport, allowlist,
content keys, and cached reach the federation slice reads; `composeGateway` re-resolves after a
bootstrap install. `RouterDomainBootstrap.assemble` names what the Router's constructor builds. The
phone's `PhoneIdentity` publishes `PhoneBootstrap` (`docs/console.md`). `bootstrap-residue` pins
that only the assemblers construct the values.

## Channel conversations

Every connection is channel mode. Each MCP process mints one stable `conversation_id` at startup and
keeps it across reconnects.

- The job key is `storeKey({kind:"conv", conversationId, address})`. Each sender-target pair uses one
  entry; callers never manage session ids.
- Channel entries are `persistent: true` and never TTL-swept. Transient ones expire at 600s.
- `channel_reply` may be called any number of times on a session_id. There is no finality.
- Replies push to the specific sender sub-session, so parallel windows do not cross streams.

## Addressing

**`shared/session-id.ts`** owns session/team key production, separators, slug validation, `Address`,
`SpawnPoint`, and target parsing. Kotlin mirrors it through the shared fixture vectors.

A bare project is a spawn point by catalog membership, not by dot detection. `my.app` may still be a
project. Sending to a spawn point without a session fails.

## Host spawn points

A host spawn point is a named shell, not a session. `host` is bash; `windows` is PowerShell over WSL.
Both produce ordinary host tmux sessions.

**`isHostSpawn` and `host-spawn.ts`** own host-spawn classification. `host-spawn-residue.test.ts`
rejects new classification sites.

**`kind`** identifies tmux location, not interpreter. Windows sessions still use WSL tmux.

**Discovery**: absent `HostSpawnState` means unknown, never no spawn points. Host spawn points are
discovery metadata, not presence rows, and `/discover` strips them. Unreachable gateways contribute
no spawn-point offer.

A gateway's own rows and shells come from itself; the Router's projection supplies every other
gateway's. Taking the Router's copy of its own would hide a live session behind a lost presence
write. Spawn points ride only the presence baseline, so `presenceReporter` forces a new one when
they change.

**Windows launch facts**: use `claude.exe`, append to `WSLENV`, encode `-EncodedCommand` as UTF-16LE
base64, and always use `Set-Location`. `pwsh.exe` is not assumed available.

Windows workdir paths use forward slashes. UNC paths are rejected. Browsing uses native
`Get-ChildItem`, not Linux `/mnt` paths.

`hostWorkdirHint` falls back to the session label. A label is not necessarily a path and must not be
passed to `wslpath`.

## Sessions and wake

Devcontainer sessions are loose `project.session` peers. The daemon sets `PROJECT_NAME` to the
composite name before launch.

The host is another spawn point and uses the same create, resume, and forget path. Its default
workdir is `~/projects/<label>`.

**The launch command puts the daemon's own bun bin dir ahead of PATH.** A pane inherits the tmux
server's PATH, which is whatever shell started that server, and `~/.bashrc` returns early for a
non-interactive shell, so sourcing it adds nothing. Without the export the plugin's `bun` is not found
and the session never registers.

**`host-daemon`** is reserved and must never be dispatched or registered as a session. Residue tests
enforce this at the sinks.

## Session identity binding

A bind token is delivered only through the daemon launch command and presented at registration and on
HTTP requests. Same-project panes remain mutually impersonable by OS construction.

**`sessionAuthority.ts`** owns binding resolution. `toClaim` is name-keyed and ignores undelivered
reattach tokens; `toAnswerFor` is socket-keyed and follows the registered incarnation; `toActFor`
composes live-first with record fallback.

`UNBOUND` is an explicit resolver value. A missing or unparseable subject must not become an
accidental permit.

**A host-shell session presents its launch token at registration,** matched against the record, not
through `toClaim`. A fresh launch presents its token before the binding activates, so a claim-based
rule refuses every real host session.

**`doWakeTeam` refuses to mint under a host spawn,** because `/send` accepts an unbound sender. Only
the console's authenticated `create_session` opens a host record. A reattached pane and a purged
`DATA_DIR` lose their proof and must be relaunched.

## Phone path

The phone reaches the Router through signed OwnerOps. `deliver` carries a `console_op` row.
`gateway_value` is forwarded as a `value_op` frame. The phone also sends
`consumer_register`, `inbox_read`, `inbox_advance`, `planes_read`, `report_read`, and
`capabilities_report`. Results are sealed under `opResultAadKind` or `valueResultAadKind`.

`ConsoleSocketMode.INBOX` selects the inbox socket. `PollDrain.drainTick` reads the owner inbox and
planes, then advances the inbox once when rows drain. `homeGatewayId` selects the home Gateway from
the admitted gateways. A Domain-less phone reaches the Router through the token-only transport,
whose reach answer names the Domain; the signed client exists only for a Ready boot.

## Versioned state planes

The console reads versioned server-state snapshots through OwnerOps. `shared/plane-registry.ts`
owns version identity, hash-gated bumps, held reads, and the 60s recovery tripwire.

Planes: **presence**, **linked-peers**, **read-anchors** per owner, and **cross-domain-presence** per
linked Domain.

**Wire rule:** flat, hand-named optional fields. Kotlin codegen cannot reliably type generic maps or
decode-side unions. An absent known-version ships nothing; an empty array ships current truth.
