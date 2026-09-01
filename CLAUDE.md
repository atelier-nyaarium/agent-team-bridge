@AGENTS.md

## Starting a host session by hand

A bare `claude --resume` loses the host identity and channel subscription. Use:

```bash
PROJECT_NAME=host.<id> claude --resume <transcript-uuid> \
  --dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium
```

The MCP and harness diagnostics are in
`~/.cache/claude-cli-nodejs/<project-dir>/mcp-logs-plugin-switchboard-switchboard/`.
