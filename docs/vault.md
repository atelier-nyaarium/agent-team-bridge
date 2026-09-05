# Vault

The owner's secrets. Sealed on the phone, held on the Router, handed to a session only after the
owner approves the use.

## Where the vault lives

The Router keeps one entry set per owner and opens no field. The record shape, the phone's writes,
and the delta list are in `docs/federation.md` under Owner state.

## Gateway client

`gateway/router/vaultClient.ts` is the gateway's only door.

- **It is the sole sealer and opener of vault fields:** `vault-door-residue.test.ts` fences the
  directory. Every field seals under `vaultAadKind(kind, id)`, so a field opens only under its own
  entry.
- `refresh()` reads `vault_read` after the held revision and merges the delta. A full list or a
  lower Router revision replaces the held copy. A `durability_uncertain` answer reads as unavailable.
- `view` opens every field but the value. `openValue` opens the value. `openTyped` opens a value the
  owner typed for one request, under that request's id.
- **The sealed `gateways` field is the allowlist:** A JSON array of gateway ids. An absent field
  admits every gateway. A field this gateway cannot open or parse admits none.
- `create` seals a title, a value, and an optional description, then writes `vault_create` at
  revision 0. A gateway never updates an entry.

## Grants

`gateway/vault/decisions.ts`, under `DATA_DIR/vault-decisions.json`.

- `once` leaves no grant. `window` covers one entry, one operation shape, and one session for 30
  minutes. `session` covers every shape of one entry for one session, until the session ends or
  eight hours pass. **A helper's session tap records a window:** every process on the host shares
  the helper's token, so a whole-session grant there would cover them all.
- **The shape is the program plus its first argument:** `operationShape` takes the program's
  basename. When the first argument is a flag, the whole line is the shape, since a flag's value
  could hide the target.
- The store opens through `openDurable`, so a poisoned file starts fresh. A revocation or a
  session-end drop is written with `saveChecked` and reported once the snapshot is installed.
  Grants and expiry sweeps are best effort.
- `vault_grants` lists the live grants. `vault_revoke` drops a grant or a helper token by id.

## Request road

`gateway/vault/requests.ts`.

- A request carries an id, the operation text, its shape, the session target, and a deadline nine
  minutes out. It names an entry, or it is `typed` and asks the owner for a value.
- **It reaches the phone as a `plugin_action` row:** `pluginId` `vault`, `actionType` `request`,
  delivered through `deliverToOwner` into the session's conversation thread, or the console's own
  conversation for the helper. The row is volatile: a restart drops it, because the waiting answer
  lived in the process that died.
- The `vault_answer` value op carries the decision and, for a typed request, the value sealed to the
  request id. A typed answer settles as `once` whatever tier was named. Deny and the deadline refuse
  alike. An unknown or settled request answers `request expired`.
- An approval on an entry request also records the grant. The answer waits for its collector until
  the deadline, and the first collector takes it.
- A session's end refuses its open requests and drops its grants.

## Loopback routes

`gateway/vault/vaultRoutes.ts`, mounted on the gateway's loopback HTTP beside the agent routes.

- **Each route resolves one principal:** A bound session by its session token, or the helper by
  `x-vault-helper-token`. A route names the kinds it serves. An unknown token answers 404, none
  answers 401, as the agent routes do.
- `/vault/search` (session): public title, public description, and whether the entry holds a value,
  for the entries this gateway may use.
- `/vault/use` (session): an entry id and the operation. A covering grant answers at once. Otherwise
  a request opens and the route waits up to `waitMs`, capped at `VAULT_ROUTE_WAIT_CAP_MS`. A wait
  that runs out answers `pending` with the request id and deadline.
- `/vault/collect` (session or helper): waits on a pending request the caller opened.
- `/vault/withdraw` (session or helper): closes a pending request the caller opened. A late answer
  from the phone then reads as expired and records no grant.
- `/vault/capture` (session): creates an entry from a value a session captured, trimming one
  trailing newline, and notifies the owner.
- `/vault/askpass` (helper): an askpass command line. A lone entry whose public title equals the
  shape goes through the grant road. Anything else opens a typed request.
- `/vault/helper-token`: gated by the host token. Mints a helper token, hashed at rest in
  `DATA_DIR/vault-helper.json`.
- The answer is `VaultValueAnswer`: `approved` with the decision and the value, `refused` with a
  reason, or `pending`.
- **The value leaves the gateway only in an approved answer.**

## Askpass helper

`src/main-vault-askpass.ts`, bundled to `dist/main-vault-askpass.js` beside the MCP entry. sudo, ssh,
and git run it with the prompt as its one argument and read the value from stdout. The decision is
`vault-askpass/askpass.ts`, over a gateway port, a tty port, and a clock.

- The brief is the caller's `/proc/<ppid>/cmdline`, joined on spaces, with `/proc/<ppid>/exe` in
  place of its first word, so a renamed binary shows where it lives. sudo's `-A` ahead of the
  command is dropped, so `sudo -A apt install foo` briefs as `/usr/bin/sudo apt install foo` and
  shapes as `sudo apt`. Without `/proc`, the prompt is the brief. The brief names the operation. It
  does not authenticate the caller: a process may claim any command line.
- **Only a secret prompt reaches the phone:** one naming a password, passphrase, secret, token, or
  PIN, or an empty one. ssh's host-key confirmation and git's username prompt are served at the tty
  alone, so a grant never answers a yes/no.
- **The opening `/vault/askpass` call asks for no wait,** so the request id is known before anyone
  can win; every later `/vault/collect` holds. A collect that ends without an answer is followed
  by another until the request's deadline.
- **A human at the tty races the phone and the first value wins:** the helper opens `/dev/tty`
  when it can, prints the prompt there, and reads one line with echo off through an `sh` child;
  collects hold 25 seconds. When the tty wins, the phone's request is withdrawn, bounded to three
  seconds. When the phone wins, the read is abandoned, half-typed input is drained, and echo
  restored. An empty line asks again; a closed tty leaves the phone road running and says so.
  Ctrl-C ends both roads and withdraws.
- **With no tty the helper holds for the phone:** collects hold `VAULT_ROUTE_WAIT_CAP_MS`. This is
  the road for an agent's own commands and for ssh with no tty.
- A gateway that cannot be reached, a token it does not know, or an owner who declined all leave
  the tty as the only road. With no tty either, the helper exits 1. It prints nothing but the value
  to stdout; notes go to stderr. Loopback calls go through `node:http`, so a proxy variable cannot
  divert them.
- A withdrawn request is closed on the gateway only. The phone's row stays until its deadline, and
  answering it reads as expired. Any local process holding the token can withdraw a helper request;
  that denies one prompt and diverts nothing, since an answer is sealed to its request id.
- The token file is `VAULT_ASKPASS_TOKEN_FILE`, which the wrapper sets, or
  `~/.config/switchboard/vault-askpass.token`; the gateway is `BRIDGE_ROUTER_URL`, default
  `http://127.0.0.1:20000`. The helper needs a token but no session.
- `scripts/install-vault-askpass.ts` mints the token with the host token from `.env` (an unenrolled
  gateway refuses), copies the bundle under `~/.local/share/switchboard/`, writes the token 0600
  under `~/.config/switchboard/`, writes the `~/.local/bin/vault-askpass` wrapper with the bun that
  ran the installer, the token path, and the gateway baked in, and prints the `SUDO_ASKPASS`,
  `SSH_ASKPASS`, and `GIT_ASKPASS` exports. sudo asks the helper only under `-A`, so plain sudo is
  unchanged. `SSH_ASKPASS_REQUIRE=force` is optional: without it ssh asks the helper only when it
  has no tty. `vault_revoke` on the phone drops the token by id.

## Phone

`android/.../vault/` and `VaultOps.kt`. The `vault` plugin gates the tab and reports the capability.

- **`VaultSealing` is the phone's only door:** a `ContentSealing` under `vaultAadKind`, the twin of
  the gateway client. A typed value seals under the request id.
- `VaultManager` holds the Router's entries under one store key and folds every list through
  `foldVersionedList`, the rule the gateway client and the board share: a full list replaces, a
  delta merges in held order, an entry never moves backward, a delta from a Router behind the held
  revision restarts from zero, and a full list behind it is a late answer. A write's own entry lands
  at once unless a newer one is held; the held revision advances only when nothing was skipped. A
  wipe bumps a generation, so work begun before it lands nothing after.
- **A save keeps every field this phone cannot open:** `sealDraft` is the rule, tested on its own.
  The gateway chips never widen a scope by emptying it; only Every gateway clears it.
- `VaultRouterWriter` posts `vault_list`, `vault_put`, and `vault_delete` as signed owner ops.
- **A revision plane is acknowledged once its list has landed:** the Router pushes the `vault`
  plane on every applied write and reports it in `planes_read`. The phone answers a bump with a list
  after its held revision and acknowledges the version only when the held revision reaches it, so
  an unacknowledged bump is offered again, and fetched at most once a minute. A bump the socket
  pushed is not offered again, so the refresh retries twice on its own.
- A request reaches `VaultPlugin` as the `vault:request` action and is held with the conversation
  it landed in; that conversation's gateway segment answers it. A duplicate dispatch and a request
  past its deadline are dropped. A restart drops expired ones.
- **One notification per pending request:** swipe denies. Once and 30 min buttons exist only while
  Vault approvals is off. Tap opens the sheet. The sheet answers with `vault_answer` through the
  gateway value op. Save as entry puts a typed value as a new entry after the answer.
- Vault approvals, under Settings and Security: Off, Every approval, 30-minute unlock.
  `ApprovalGate` is the one gate: it runs before an entry approval, a reveal, and a save that
  changes a stored value; a typed value never prompts. Tightening the policy is free, loosening it
  asks the owner, and any change ends the window.
- Grants are read per admitted gateway through `vault_grants` when the tab opens and after an
  approval. The session card shows YOLO for a whole-session grant and vault for a window. The tab
  lists them with Revoke.

**File map:**

- `src/gateway/compose/composeVault.ts` - the stage: stores, request delivery, routes, console handlers.
- `src/gateway/router/vaultClient.ts` - sealing, opening, the delta copy, the create.
- `src/gateway/vault/decisions.ts`, `requests.ts`, `helperTokens.ts`, `vaultRoutes.ts` - grants, requests, helper tokens, routes.
- `src/main-vault-askpass.ts`, `src/vault-askpass/askpass.ts` - the helper entry and its decision over ports.
- `scripts/install-vault-askpass.ts` - the helper's installer.
- `src/shared/schemasVault.ts` - wire shapes, the request row, the loopback shapes, the constants.
- `src/federation-server/vault/` - the Router service.
- `android/.../vault/` - sealing, the held entry set, the writer, the tab, the editor, the request sheet.
- `android/.../VaultOps.kt`, `plugins/vault/VaultPlugin.kt` - repository operations and the plugin's claims.
