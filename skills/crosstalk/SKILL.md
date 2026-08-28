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

### Sending Files

Pass absolute paths in `attachments` when the other team needs to see the artifact itself rather
than your description of it, such as a screenshot or a failing log.

```
switchboard:crosstalk_send(to="cool-lib", body="repro attached", attachments=["/tmp/shot.png"])
```

They arrive on the recipient's disk, listed as a `[FILES]` block of paths to Read. Replies carry
attachments back the same way, so this is the channel for round-trip visual verification. A body is
still required. Attachment bytes are not retained after delivery: if the reply reaches you as a
poll rather than a live push, you get the filenames and have to ask for a re-send.

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

Only `full` on `channel_reply` and `notify_human` scans markdown links. Other fields, crosstalk, code
fences, and inline code do not scan.

**Path:** bare is the host's workspace root, `/x` the filesystem root, `~/x` home.

**Chain:** colon-separated scope and name segments. `[n]` takes the nth same-named declaration in
document order. `arguments` names a parameter list, `arguments:name` one parameter.

**Text:** `#` searches the chain's declaration, or the whole file with no chain, the form for a
symbol-less file or a path outside the root.

- `#text` first occurrence
- `#from..to` line range
- `#text@before:anchor` or `#text@after:anchor` occurrence nearest that anchor

Escape spaces and close parentheses, or wrap the destination in angle brackets.

**Refused, naming the fix:** a chain outside the root, a missing or ambiguous name, a matcher that
finds nothing. The refusal lists complete candidate refs, or the declarations at the chain stop.
`exact` requires one hash-verified declaration.

**Degraded to `fuzzy` or `unresolved` with a notice:** only lexicon UNABLE TO ANSWER, meaning absent,
incompatible, warming, a dead daemon, or an index refusing the workspace or file.

Examples: [App.tsx : render](ref://src/App.tsx:App:render),
[util.js : second deepHandler](ref://src/util.js:deepHandler[2]),
[Svc.cs : Compute](ref://src/Svc.cs:Acme.Services:Service:Compute),
[engine.cpp : step](ref://src/engine.cpp:Physics::World::step),
[cart.ts : qty](ref://src/cart.ts:Shop:Cart:add:arguments:qty),
[notes](ref://NOTES.md#Checkout),
[cart.ts : region](<ref://src/cart.ts:Shop:Cart:add#this.items.push(item);>),
[cart.ts : range](ref://src/cart.ts:Shop:Cart:add#this.items..reset),
[cart.ts : anchor](ref://src/cart.ts:Shop:Cart:add#this.count@after:reset),
[nginx.conf : text](ref:///etc/nginx/nginx.conf#server),
[bashrc : text](ref://~/.bashrc#export%20PATH).

## The owner's task board

When the `taskBoard*` tools are present, the owner shares a live task list with you and watches it on
their phone. Prefer it over Claude's built-in task tools for anything worth surviving the turn; those
stay useful for scratch steps inside one.

- **`taskBoardList`** the backlog plus your own entries, **`taskBoardClaim`** to take one,
  **`taskBoardCreate`** to add one (`assignTo: "self"` or `"backlog"`, no default on purpose),
  **`taskBoardUpdate`** to change what you hold, **`taskBoardRelease`** to hand it back, and
  **`taskBoardClear`** to trash your finished entries.
- **Claim a backlog entry before working it or nesting under it.** A claim on one another session
  holds refuses, so repeating a claim whose reply you lost is safe.
- **Break work down as children of the entry it belongs to** and tick them as you go. That tree is
  the only progress the owner can see.
- **A follow-up you will not do goes to the backlog**, or it dies with your session.

The full guidance comes from `switchboard_capabilities`, the same as refs above.

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
