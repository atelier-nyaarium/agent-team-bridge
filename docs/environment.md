# Environment variables

Every `.env` key is minted, detected, or prompted for by `start-federation.sh` and `setup.sh`. None is
hand-edited, so there is no `.env.example`. The compose files and the tuning overrides below are not
`.env` keys and are not written by either script.

## Gateway (Docker)

| Var | Meaning |
|-----|---------|
| `PORT` | HTTP/WS port, default 20000 |
| `GATEWAY_ID` | This Gateway's id, default the sanitized hostname |
| `HOST_WS_TOKEN` | Secret the host daemon presents for the reserved `host` slot. Fail-closed. Auto-provisioned into `.env` by `start-gateway.sh` |
| `FEDERATION_DOMAIN_ID` | Domain id. Not fail-closed; the enrollment-delivered `domain-id` file takes precedence |
| `DATA_DIR` | Durable state, default `/app/data`. Separate from the log volume, so clearing logs cannot wipe federation identity |
| `FEDERATION_DIR` | Keypair, allowlist, `transport.json`, `domain-id`, `content-keys.json`, transient `staging/`. Default inside `DATA_DIR` |
| `ENROLL_TLS_PORT` | Enrollment TLS port, default 20003. Set in `docker-compose.yml`, not `.env` |
| `ENROLL_NONCE` | The one-time enrollment nonce, passed through by compose. Empty when no invite is armed |
| `ENROLL_LAN_HOST` | Host advertised on the enrollment payload's LAN leg, default `0.0.0.0` |
| `MAX_BLOB_STORE_BYTES` | Blob sweep ceiling, default sixteen times the single-blob maximum. Tuning override |
| `WAKE_TIMEOUT_MS` | How long a wake may take before it is given up on, default 600000. Tuning override |
| `ALLOW_FIXTURE_IDENTITY` | `1` lets the gateway start on the committed test identity (`src/shared/fixture-identity.ts`). Only `check:boot` sets it |

## Federation Router (Docker, its own compose project)

| Var | Meaning |
|-----|---------|
| `FEDERATION_BIND` | The LAN address the Router is published on. The Router listens on every interface inside its container; this is the host side of the compose port mapping, and compose also passes it through as `FEDERATION_LAN_ADDRESSES`, which is what the Router advertises. `scripts/lib/routerStart.ts` detects and writes it on every start, never typed, so a DHCP move reaches `.env` before compose reads it. `setup-verify.ts` and `setup-provision.ts` probe the same value |
| `FEDERATION_LAN_ADDRESSES` | The LAN addresses the Router advertises. Set by compose from `FEDERATION_BIND`, never written directly |
| `FEDERATION_PUBLIC_HOST`, `FEDERATION_PUBLIC_PORT` | The Router's address from outside, the one thing setup asks. An empty host means LAN only, and the port is not asked. The port is advertised only when it differs from the Router's own |
| `FEDERATION_WS_TOKEN` | Bearer the gateway presents at the Router's WS upgrade. Fail-closed. Minted into `.env` by `start-federation.sh` |
| `CONSOLE_BRIDGE_TOKEN` | App token every console presents on the op surface. Fail-closed. Minted into `.env` by `start-federation.sh` |
| `FEDERATION_ROUTER_CERT_FP` | Persisted Router fingerprint. `setup.sh --verify` pins against it. Written at Router start and during provision |
| `ROUTER_DOMAIN_QUOTA_BYTES` | Owner state and inbox bytes per data dir, default 2 GiB. A 64 MB reserve is kept free |
| `ROUTER_BLOB_CACHE_BYTES` | Blob cache bytes per Domain, default 1 GiB. The LRU sweep skips live transfers |
| `ROUTER_MIGRATION_EPOCH` | Fallback migration epoch when the Router has no `migration-epoch` file. A positive integer raises the Router migration window |
| `ALLOW_FIXTURE_IDENTITY` | `1` lets the Router start on the committed test identity. Only `check:boot` sets it |

Router state under its `DATA_DIR`: `owner/<domainId>/<fingerprint>/` (manifest, snapshots, journals),
`blobs/` (cache and reference-held entries), `inbox-claims/` on the gateway side.

## Host daemon

`HOST_WS_TOKEN` and `BRIDGE_ROUTER_URL`, as above. The daemon announces each capability when its
corresponding CLI is found on `PATH`. No environment variable is required.

## MCP plugin (container)

`PROJECT_NAME` (required for crosstalk), `BRIDGE_ROUTER_URL` (default `http://switchboard:20000`),
`AGENT_TYPE`, `PROJECT_HOST_PATH`, `MCP_CONNECTOR_PORT`.

A delegated agent's model is a field on the request, never an environment variable.
