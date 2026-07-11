# Reply newline lint (escaped-newline hazard, all agents)

A live incident: an agent (this one) authored a `channel_reply` mixing real newlines with typed
two-character `\n` escape sequences in one string; the literal characters were delivered and the
console faithfully rendered "backslash-n" mid-prose. The pipeline was correct end to end - the
authoring layer was wrong. The owner wants the fix structural ("a way to make it work for ALL
agents"), not a per-agent memory note.

## Questionaire

**1. Where should the fix live?** A + B layered, chosen from three options:
- A) Tool-description guidance ("use real newlines; literal backslash-n renders as text") - reaches
  every agent on every call, but advisory only.
- B) A narrow pre-send lint in the shared MCP reply path that REJECTS structural escape patterns
  outside code, with a clear resend instruction. Channel conversations have no finality, so the
  sending agent just fixes and resends; the human never sees a mangled message.
- C) Auto-convert escapes to real newlines - REJECTED as destructive: messages here routinely
  contain code snippets discussing printf formats, regexes, and escape sequences; a transformer
  cannot reliably distinguish "meant a newline" from "meant these two characters", and a wrong
  guess corrupts content silently instead of failing loudly.

User: "ok plan it out and refine."

## Plan

### Design

**The lint (pure, one owner).** A pure function in `src/mcp/bridge/replyTool.ts`:
`literalEscapeHazard(text: string): string | null` - returns a short human-readable description of
the first hazard found (the offending snippet, abbreviated), or null when clean. Detection rule,
deliberately NARROW so false positives stay near zero:

- Exempt code first - escape sequences inside code are always legitimate content. The algorithm is
  a LINE-BASED scan in document order (the red team disproved the earlier strip-then-scan regex
  layering twice over: deleting a code span glues its neighbors and manufactures adjacency the
  author never wrote, and counting raw ``` occurrences lets a mid-line fence MENTION skew the
  count and silently swallow later hazards). Per real-newline line: a fence delimiter (``` or ~~~,
  up to 3 spaces indent, info string allowed) at a LINE START opens a block; per CommonMark's
  strict closing rule, only a line holding the MATCHING delimiter and nothing but whitespace
  closes it (a second red-team round proved the loose version both bypassed a hazard glued onto a
  closer line and false-positived on delimiter-plus-text lines that a real renderer keeps inside
  the block) - an unterminated fence runs to end-of-string, for free; lines inside a fence are
  skipped; on a prose line, inline backtick spans are BLANKED TO A SPACE (never deleted, which
  would glue neighbors into manufactured adjacency), run-length aware so double-backtick spans
  exempt correctly, then the hazard regex runs on that line alone. A hazard never spans real
  newlines by construction (an author who typed a real newline already has the break).
  Fence-length-aware nesting and 4-space indented code blocks stay out of scope per the
  narrow-rule philosophy.
- In the remaining prose, flag a literal backslash-n (the two characters) ONLY when followed by
  markdown STRUCTURE: another literal `\n`, `- `, `* `, `+ `, `#`, `|`, or `>`. A stray prose
  mention like "use \n in printf" (no structural follow) passes, and a Windows path like
  `C:\new-folder` passes (the follow is a letter) - the goal is catching an author who meant line
  breaks, not policing every escape.
- Also treat a literal `\t` followed by `- `/`* ` the same way? NO - out of scope; newlines are the
  observed failure class, and each added pattern widens the false-positive surface. One class,
  done well.

**Enforcement points (every prose-bearing send, one check each):**
- `postReply` (`replyTool.ts`): lint the payload's `title`, `summary`, and `response` fields before
  the POST - checking a field ONLY when `typeof payload[field] === "string"` (an absent or
  non-string field is clean; this is what makes `designer_push_card`'s title-less payload and
  `channel_reply_structured`'s replyAsJson-only payload pass with no tool-specific special-casing).
  On a hit return `toolError` naming the field and snippet. Covers `channel_reply` and
  `designer_push_card`'s message in one place (both route through `postReply`).
- `notify_human` (`humanTools.ts`): same check on `title`/`summary`/`full` as the FIRST statement
  after destructuring args - before attachment materialization (which reads and base64-encodes
  files) and before the POST, so a reject wastes no file IO. Reuse the shared `toolError` (the
  file already imports from `replyTool.ts`).
- `crosstalk_send` (`bridgeSend.ts`): lint `displayLabel` only - it becomes a persistent
  human-rendered session label on the console board, unlike `body`. The `body` stays UNLINTED:
  it is agent-to-agent content consumed by another model that reads escapes fine, and rejecting
  cross-team traffic over the console's secondary mirror copy is the wrong trade.
- The bridge handshake auto-reply (`helpers.ts`'s `connectToRouter`) also posts to `/respond`
  directly, bypassing `postReply`, but only ever carries a structured boolean flag, never prose -
  correctly out of scope. No other prose-bearing send sites exist in `mcp/` (verified by sweep).
- NOT enforced on `channel_reply_structured` (`responseData` is a machine-consumed object, not
  rendered prose).

**The error shape.** The reject is an ordinary `toolError` (flat string, `isError: true`) naming
the TOOL-FACING field the agent filled in - `channel_reply`'s `full` and `designer_push_card`'s
`message`, not the `response` wire key they map to (`postReply` takes a `responseFieldLabel`). The
offending snippet rides inside a code span with its own backticks swapped for apostrophes, so an
agent quoting the reject back to the human verbatim does not trip the lint a second time (the
red team demonstrated that loop empirically). The escape-hatch clause matters: it gives a model
hitting a rare false positive an actionable second path instead of pushing it to destructively
rewrite content that was correct as typed. The agent retries immediately; nothing is sent on a
reject.

**Implementation hazard (the lint must not have its own bug).** The FIXED portion of the reject
text mentions `\n` - authored as a raw `\n` inside a TS template literal, that compiles to a REAL
line feed, not the two characters. Escape it in source (`\\n`) or build via `String.raw`, and add
a test asserting the returned error text contains the two literal characters, so a future edit
cannot silently regress the message into demonstrating the very bug it describes.

**Guidance (scope A).** Appended to the prose-field `.describe()` strings of `channel_reply` and
`notify_human`, owner-worded for token cost (agents do not need to know about the lint engine):
"Use REAL newlines for line breaks, not \n. Wrap intentional escapes in backticks or code spans."
(In TS source the `\n` there must be the escaped two-character form - the same implementation
hazard as the reject text.) Schema descriptions reach every agent on every call.

**No wire, gateway, or Android changes.** Pure MCP-plugin-side; ships to all containers on the
next plugin version bump + reload, per the standard deploy sequence.

**Known limitations (accepted).** The lint only guards sends through this MCP plugin's tools - a
console message from any other source (a human typing literal escapes, a foreign bridge peer) is
out of scope; the renderer keeps faithfully displaying what it is given, which is correct. And the
rule is narrow-but-not-zero false positive: UNFENCED prose where a literal `\n` happens to sit
before a structure character - the classic case is an unfenced regex like `\n|\r` (pipe is a
trigger) - trips the reject. Accepted collateral: the fix is "fence your code", the error text
says so explicitly, and the guidance sentence teaches it up front.

## Phase 1 - guidance + lint

`literalEscapeHazard` (pure, exported for tests) + enforcement in `postReply`, `notify_human`'s
handler (first statement), and `crosstalk_send`'s `displayLabel` + the description-line guidance.
Vitest coverage in `src/__tests__/reply-tool.test.ts`: structural hazards caught (literal `\n-`,
`\n\n`, `\n#`, and the live incident's exact strings), fenced (``` and ~~~) and inline-code
escapes pass, the unbalanced-fence case passes (unclosed fence = code to end), non-structural
prose mentions and Windows paths pass, real newlines pass, absent/non-string payload fields pass,
enforcement returns the flat `toolError` shape containing the two literal escape characters and
does not POST.

### Notes

- After ship: retire this plan per convention (fold residuals into `pain-points.md`), and bump +
  deploy the plugin so live sessions actually inherit the lint.
