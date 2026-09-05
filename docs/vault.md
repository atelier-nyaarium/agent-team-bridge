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
  eight hours pass.
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
  delivered through `deliverToOwner` into the session's conversation thread, or the gateway's own
  vault thread for the helper. The row is volatile: a restart drops it, because the waiting answer
  lived in the process that died.
- The `vault_answer` value op carries the decision and, for a typed request, the value sealed to the
  request id. Deny and the deadline refuse alike. An unknown or settled request answers
  `request expired`.
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
- `/vault/capture` (session): creates an entry from a value a session captured, trimming one
  trailing newline, and notifies the owner.
- `/vault/askpass` (helper): an askpass command line. A lone entry whose public title equals the
  shape goes through the grant road. Anything else opens a typed request.
- `/vault/helper-token`: gated by the host token. Mints a helper token, hashed at rest in
  `DATA_DIR/vault-helper.json`.
- The answer is `VaultValueAnswer`: `approved` with the decision and the value, `refused` with a
  reason, or `pending`.
- **The value leaves the gateway only in an approved answer.**

**File map:**

- `src/gateway/compose/composeVault.ts` - the stage: stores, request delivery, routes, console handlers.
- `src/gateway/router/vaultClient.ts` - sealing, opening, the delta copy, the create.
- `src/gateway/vault/decisions.ts`, `requests.ts`, `helperTokens.ts`, `vaultRoutes.ts` - grants, requests, helper tokens, routes.
- `src/shared/schemasVault.ts` - wire shapes, the request row, the loopback shapes, the constants.
- `src/federation-server/vault/` - the Router service.
