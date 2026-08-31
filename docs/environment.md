# Environment variables

Every key is minted, detected, or prompted for by `start-federation.sh` and `setup.sh`. None is
hand-edited, so there is no `.env.example`.

## Gateway (Docker)

| Var | Meaning |
|-----|---------|
| `PORT` | HTTP/WS port, default 20000 |
| `GATEWAY_ID` | This Gateway's id, default the sanitized hostname |
| `HOST_WS_TOKEN` | Secret the host daemon presents for the reserved `host` slot. Fail-closed. Auto-provisioned into `.env` by `start-gateway.sh` |
| `FEDERATION_DOMAIN_ID` | Domain id. Not fail-closed; the enrollment-delivered `domain-id` file takes precedence |
| `DATA_DIR` | Durable state, default `/app/data`. Separate from the log volume, so clearing logs cannot wipe federation identity |
| `FEDERATION_DIR` | Keypair, allowlist, `transport.json`, `domain-id`. Default inside `DATA_DIR` |

## Federation Router (Docker, its own compose project)

| Var | Meaning |
|-----|---------|
| `FEDERATION_BIND` | The LAN address the Router binds and advertises. `scripts/lib/routerStart.ts` detects and writes it on every start, never typed, so a DHCP move reaches `.env` before compose reads it. `setup-verify.ts` and `setup-provision.ts` probe the same value |
| `FEDERATION_PUBLIC_HOST`, `FEDERATION_PUBLIC_PORT` | The Router's address from outside, the one thing setup asks. An empty host means LAN only, and the port is not asked. The port is advertised only when it differs from the Router's own |
| `FEDERATION_WS_TOKEN` | Bearer the gateway presents at the Router's WS upgrade. Fail-closed. Minted into `.env` by `start-federation.sh` |
| `CONSOLE_BRIDGE_TOKEN` | App token every console presents on the op surface. Fail-closed. Minted into `.env` by `start-federation.sh` |

## Host daemon

`HOST_WS_TOKEN` and `BRIDGE_ROUTER_URL`, as above. The daemon announces each capability when its
corresponding CLI is found on `PATH`. No environment variable is required.

## MCP plugin (container)

`PROJECT_NAME` (required for crosstalk), `BRIDGE_ROUTER_URL` (default `http://switchboard:20000`),
`AGENT_TYPE`, `PROJECT_HOST_PATH`, `MCP_CONNECTOR_PORT`, `MODEL_SIMPLE`, `MODEL_STANDARD`,
`MODEL_COMPLEX`.
