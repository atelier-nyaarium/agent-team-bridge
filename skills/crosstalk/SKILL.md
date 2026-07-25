---
name: crosstalk
description: Cross-team communication for agent teams in different Devcontainers. Use when you need help from another team via the bridge, such as analysis, debugging, or bugfixing.
---

# Switchboard

You have access to cross-team communication tools via the `switchboard` MCP server.
Other agent teams running in separate DevContainers are on the same network
and can be reached through these tools.

---

## Sending a Request

### Tools

- **`switchboard:crosstalk_discover()`** - List all teams on the bridge (online and available). Available teams can be woken on demand by sending them a request. Always check before sending.
- **`switchboard:crosstalk_send()`** - Send a request to another team and wait for their response. Blocks until they respond.
- **`switchboard:crosstalk_wait()`** - Wait N seconds before retrying a deferred request.

> **The human is not a crosstalk team.** `crosstalk_discover` lists agent teams only; it never lists the human's console, and you must never `crosstalk_send` to a person. Reach the human by replying on the request you received (`channel_reply` in channel mode, `crosstalk_reply` for CLI agents), or push a proactive notice to their console with `switchboard:notify_human()` (carries title/summary/full/fullSpoken).

> **Channel mode (Claude):** When you send a request to another channel-mode team, their reply is pushed back to you automatically as a `<channel>` notification. You will receive it without polling.

### How Threading Works

Each first response from the other team includes a `session_id`. This is the agent session
ID on their side. To continue the conversation (answer a clarification, follow up on a
deferred request), pass that same `session_id` back in your next `switchboard:crosstalk_send()`. Omit it to
start a fresh conversation thread.

```
# First message - no session_id
switchboard:crosstalk_send(to="cool-lib", type="question", body="...")
→ response includes session_id: "bfa069ad-..."

# Follow-up - pass session_id to continue the same thread
switchboard:crosstalk_send(to="cool-lib", session_id="bfa069ad-...", body="...")
```

Do not reuse a `session_id` across unrelated conversations. Each distinct task should be
its own thread.

### Response Statuses

**Successful:**

- **completed** - Work done. Check `response`.
- **clarification** - They need more info. Answer via a follow-up `switchboard:crosstalk_send()` with the same `session_id`.
- **deferred** - They're busy, or still working on it. Use `switchboard:crosstalk_wait()`, then retry.
- **running** - The team is still processing. Poll with `session_id` to check later.

**Problems - propagate these back to your human:**

- **needs_human** - They need a human decision on their end.
- **error** - Something went wrong. The `reason` field has details.
- **timeout** - No response in time. The other team may be down or overloaded.

### Timeout Note

Cross-team requests can take many tens of minutes. The other agent may need to implement
a feature, run tests, build, commit, PR, and merge. If you see MCP timeouts, the MCP
client timeout may need to be increased in `.mcp.json` or the client's settings.

---

## Referencing code (ref:// links)

When you are talking about a specific piece of code, link it instead of pasting it. Write a markdown
link whose destination is `ref://src/cart.ts:Cart:add`, and the file is snapshotted at send time and
attached, so the reader taps through to the real code as it was when you wrote about it.

- **Only the `full` field of `channel_reply` and `notify_human` is scanned.** A ref in `summary`,
  `title`, `fullSpoken`, or a `crosstalk_send` body arrives as a link that cannot open.
- **Paths resolve the way a shell reads them.** Bare is project-relative, a leading `/` is the
  filesystem root, `~/` is the owner's home.
- **Wrap the destination in angle brackets** when the matcher contains a space or a close paren:
  `[label](<ref://src/cart.ts:Cart:add#items.push(item);>)`. Without that, a link destination ends at
  the first space or unbalanced `)`, and the ref is silently truncated rather than reported.
- **A file-tier problem fails the send loudly** (missing, not text, a refused secret). A
  RESOLUTION miss does not: the ref still sends and opens on a text match or the whole file with a
  banner. No error does not mean the ref landed where you meant.
- **Refs in code fences or inline code are never detected**, so documenting the format costs nothing.

The full format, including the `#matcher` forms, is in this plugin's own `agent_instructions`, which
your session already carries in its instructions when the capability is on.

## Receiving a Request

How you receive requests depends on which agent is running:

### Claude (channel mode)

Requests arrive as `<channel source="bridge">` tags in your session with attributes
like `session_id` and `from`. Do the work, then reply with **`switchboard:channel_reply()`**
(session_id + title + summary + full + fullSpoken, plus optional attachments) using that `session_id`. When
the inbound tag also carries a `reply_schema` attribute (e.g. the bridge handshake), reply with
**`switchboard:channel_reply_structured()`** instead, passing `responseData` matching that
schema.

### CLI agents (cursor, copilot, codex)

Requests are injected into your session as a prompt containing a `session_id` in the header.
Do the work, then call **`switchboard:crosstalk_reply()`** with that `session_id`.
