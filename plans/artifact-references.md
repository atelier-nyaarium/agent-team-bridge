# Artifact References (ref:// links)

A message body can reference a symbol in a host project file via a `ref://` link. The MCP plugin
detects these refs in the outgoing body, resolves each against the local filesystem at send time,
and auto-attaches a snapshot artifact (the resolved snippet + metadata). The console renders the
ref as a live link; tapping it opens a code viewer showing the referenced scope.

## Questionaire

**Locked from initial brief (user's opening message):**

- Detection + resolution happen MCP-side at send time. The tool scans the full message body and
  auto-sends a copy of the artifacts for the references. (Snapshot semantics: the artifact is what
  the code looked like when the agent sent the message.)
- Link format sketch: `[Filename : Classname : Methodname : Symbol](ref://filepath:classname:methodname:extra)`.
  The scope chain after the filepath is dynamic depth: could be a namespace, a namespace in a
  namespace, a class, a method, a typedef, a variable.
- Pointing at a scoped thing shows that scope's body to the user.
- Pointing at a symbol below scope granularity needs a line matcher.
- Language whitelist for now: TS/JS/C++/C#/GDScript/PY.
- Needs basic scope detection and basic language coloring.

**Research findings (pre-questionaire):**

- Phone side needs NO parser regardless of resolution strategy: resolution happens host-side in the
  MCP at send time, and the artifact ships pre-resolved (snippet text, language, line range, scope
  chain). The vendored highlight.js already colors TS/JS/C++/C#/PY; GDScript is the one gap (needs
  a small vendored hljs grammar).
- The phone's two-tier link rendering (blue standard / red unhandled) means `ref://` goes live by
  adding the scheme to `OPENABLE_SCHEMES` plus one dispatch branch in `openLink` - the rendering
  side is already future-proofed for this.
- Outbound attachment plumbing exists end to end (`channelReply.ts` payload.files -> gateway ->
  mailbox -> `Attachments.kt`); the Designer plugin is the precedent for specially-marked
  attachments ingested by a phone-side plugin into its own store.

**1. How does the MCP resolve a scope chain to a code range?**

Answer: **A) tree-sitter.** One library (web-tree-sitter); each language is a vendored WASM grammar
data file, not a separate dependency. Official grammars for TS/JS/C++/C#/PY, community grammar for
GDScript. Recommendation chosen because it dissolves the "many parser libraries" concern and
resolves nested scopes correctly even in C++. The line matcher is still built regardless: it is
the resolution tier for below-scope symbols and the fallback when AST resolution fails (file
drifted since the agent wrote the ref), with the artifact marked as fuzzy-resolved.

**Transport (default, offered with veto):** artifacts ride as a reserved-name JSON attachment on
the existing `ChannelFile` plumbing, same pattern as the Designer's `@dsCard` files. No new wire
field, no schema codegen. Not vetoed.

**2. What does the artifact contain?**

Answer: **B) Whole-file snapshot.** One copy of each referenced file per message, plus a manifest
entry per ref (scope chain, resolved line range, resolution quality). Size cap falls back to
snippet mode for oversized files. User's reasoning: "it means multiple references to the same file
are free."

**Path default (offered with veto):** filepaths in refs are project-relative, resolved against the
MCP's project root. Not vetoed.

**3. The ref URL grammar?**

Answer: **B) Colons for scopes, hash for matcher.** `ref://src/foo.ts:MyClass:myMethod#dragDeltaX`.
Everything before `#` must resolve as scopes; the URL-encoded fragment is always the line matcher,
searched inside the innermost resolved scope. Trivial forms supported: bare `ref://path` opens the
file, `ref://path:Scope` shows that scope's body. Chosen over the pure colon chain because the
matcher is never inferred: a typoed scope is a resolution failure, never silently a text search.

**Scanned-tools default (offered with veto):** v1 scans `channel_reply` full and `notify_human`
full. Agent-to-agent crosstalk bodies are skipped. Not vetoed.

**4. Send-time failure semantics?**

Answer: **C) Split by failure class.** A missing or unreadable file is a hard error back to the
agent (a typo, and the agent is right there to fix it). A scope that fails to resolve degrades:
line-match the failed segment inside the file, mark the artifact fuzzy, ship it. The phone renders
fuzzy refs visually distinct (amber, between blue and red).

**5. Where does this live on the phone?**

Answer: **B) References plugin** (Designer pattern) plus a new `linkHandlers` extension point in
the plugin framework (a plugin claims a URL scheme; `OPENABLE_SCHEMES` becomes core schemes plus
plugin-claimed schemes). Disabled plugin degrades ref links to red-unhandled. User adds: "But we
have to redo the foundation." The gateway/daemon must know the maximum capabilities across the
owner's consoles - "If at least 1 phone lists Designer, then the MCP for that is enabled next
wake." Accepted consequence: a session adopts plugin changes only on tab close + reopen (fresh
spawn).

**Foundation exploration (console capability propagation):** the user suspected the MCP cannot ask
the gateway and proposed env injection ahead of the wake call. Findings: the MCP CAN ask the
gateway - it already holds an HTTP line (`routerGet`) and connects at startup, so a bounded
capability fetch before tool registration works for EVERY launch style, including manually-opened
host windows that env injection would miss (the wake-env path only covers daemon-spawned
sessions). Precedents: PROJECT_NAME env override for the wake path, the handshake role cache for a
disk-cached fallback when the gateway is briefly unreachable. Gateway side: console `register` op
gains an enabled-plugins list (re-register on toggle), gateway persists per-device caps durably
and serves the union across non-forgotten consoles. Restart-to-adopt semantics hold either way.

**6. Capability propagation mechanism?**

Answer: **B) Startup fetch.** The MCP fetches the console capability union from the gateway at
startup (bounded 1-2s wait before tool registration, disk-cached last-known fallback when the
gateway is briefly unreachable, handshake-role-cache pattern). Uniform across every launch style,
including hand-launched host windows the wake-env path would miss. Restart-to-adopt: a session
picks up plugin changes on tab close + reopen.

**Rendering default (offered with veto):** the viewer is a WebView page in the thread assets
family, reusing the vendored highlight.js and theming. Not vetoed.

**7. What does tapping a ref open?**

Answer: **A) Full-screen viewer.** Attachment-viewer presentation family: whole file with line
numbers, auto-scrolled to the resolved range, range highlighted, breadcrumb header
(`file : Class : method`), amber banner on fuzzy-resolved refs. User adds: "if an extra matcher
wasn't supplied, then it's the whole scope to highlight" (matcher supplied = that line gets the
strong highlight within the scope band).

**UX iteration:** via Switchboard's own Designer dock (`designer_push_card`), per user, not Claude
Designer.

**Highlight language (design iteration on the mock):**

- Blue line bands = the resolved line range (scope).
- Amber character highlight = the exact inline target (a parameter, a symbol, a text match).
- Fuzzy state = the amber banner ONLY (dismissible via an X to reclaim real estate); the match
  itself is lit normally (line blue, matched text amber). No whole-line amber.
- User rule, generalized into the unified highlight rule: a resolved target spanning full lines
  gets blue lines; an inline target smaller than its line gets its line blue plus its exact
  characters amber. User's parentheses example falls out: single-line parens = line blue + contents
  amber; multi-line parens = line scope, blue only.

**Grammar extension: structural pseudo-segments (reaching into parameters).**

`:` segments navigate the AST. Besides named declaration scopes, a small whitelist of structural
pseudo-segments per language: `arguments` (the parameter list of the innermost function scope),
and a parameter NAME under it (`:arguments:url` = the parameter node named url). Precedence: a
real named child wins over a pseudo-segment keyword (code that literally contains a member named
`arguments` resolves to that member, which is also the plain reading).

`:` vs `#` both kept, they answer different questions:
- `:arguments:url` = AST navigation, "the parameter NAMED url". Precise, participates in hard/fuzzy
  failure semantics, immune to `url` appearing 50 times in the body.
- `#url` = text matcher, "the first occurrence of the text url inside the innermost resolved
  node". Fuzzy by nature. Also gets the character-amber treatment since the match position is
  known. Composable after any scope/pseudo chain.

Both-kept ruling, the `arguments` pseudo-segment, the unified highlight rule, and the
dismissible-banner fuzzy treatment all confirmed by user ("that sounds good").

**8. How long do file snapshots live on the phone?**

Answer: **A) Ride the attachment lifecycle.** Artifacts are files in the message's existing
attachment bucket, living exactly as long as the message row (forget purges, orphan sweep
backstops). Within-message dedupe is inherent (one file copy, many manifest entries).
Content-hash dedupe across messages noted as a later optimization if storage ever hurts.

**Accepted defaults (offered, not objected):** handled ref links render blue in chat like standard
links; the link label is agent-freeform convention (`[File : Class : method]` taught, not
enforced); a small GDScript grammar is vendored for highlight.js.

**Capability listing carries instructions (user addition, mid-audit):** each capability entry the
MCP fetches is not a bare id but `{id, instructions}` - agent-facing usage guidance surfaced to
the session. User's Designer example: "Switchboard renderer for Claude Designer. When mocking up
designs, ask if they would like 'Claude Designer over Switchboard'. Prefer Switchboard unless they
state otherwise." Direction: the phone-side plugin manifest owns its instruction text and ships it
in the register op, so a future plugin delivers its agent guidance without an MCP update;
latest-writer-wins per capability id when devices disagree. Surfaced to the agent via the MCP
server's own instructions mechanism (or appended tool descriptions - implementation detail).

**Rollout ruling (user, after lap 1 report): hard clean break.** "when we update, we update
everything all at once. Only 1 PC anyways." Gateway, MCP plugin, and APK ship together; no
cross-version compatibility machinery (no legacy-default union synthesis, no 404-from-old-gateway
handling, no deploy-order analysis). Resilience rules that are NOT version compat stay minimal:
the register field stays `.optional()` purely so a not-yet-updated phone cannot brick its
register during the minutes of an update pass, and the MCP keeps one cold-start rule (fetch
fails -> disk cache -> else fail-open to core capabilities) for a briefly-down gateway. Phase 2.5
(gateway drain paging) is dropped from this plan and recorded in `plans/pain-points.md` as the
pre-existing exposure it is; the per-message 2 MB aggregate artifact budget stays feature-side in
Phase 2.

**Adaptation round (post-refinement, user-driven).** User closed the refinement cycle ("no need
for more refinement. but let's talk more and adapt it") and raised three grammar questions:

**9. Segment depth and deep nesting.** User: "Is the pattern always tuples
namespace:name:object? or did you leave it dynamic? imagine a js file with too many deep a
nesting." Answer: fully dynamic (`segments[]`, zero to N), and confirmed together with 10 and 11
("sure!"): segments are WAYPOINTS - each segment matches any DESCENDANT scope of the previous
match rather than a direct child, shallowest match preferred then document order, existing
ambiguous flag applies. Required for JS, where deep nesting routinely passes through anonymous
closures that cannot be named in a chain at all. Pseudo-segments (`arguments`, parameter names)
are exempt from descendant search: they navigate structurally from the current node only.

**10. Line ranges.** User: "we only handle the case of pointing at a ref... What about extending
the plan to handle line ranges? From pattern to pattern?" Answer (confirmed): **`#A..B`** - both
sides are matchers, B searched after A's match, highlight = A's first line through B's last line
(blue band, per the unified rule for multi-line targets). git-range precedent.

**11. Nth-match disambiguation.** Answer (confirmed): **`@before:` / `@after:` anchors**, with
the W3C text-fragment spec's prefix/suffix semantics underneath our spelling and one deliberate
deviation: nearest-in-scope instead of immediate adjacency. `~N` skipped; the multi-line context
matcher deferred unless anchors prove too narrow. User's example: seven `foo += 1` lines with a
`foo = 0` in the middle - "How do you say the +1 instance before =0?" Options on the table:
occurrence index (`~N`), multi-line context matcher (encoded newlines, diff-context style,
whole matched span highlights), and before/after anchors (`#target@before:anchor` /
`#target@after:anchor` - nearest occurrence of target relative to the anchor's match).

**Precedent grounding (user asked "are these based on real-world matcher syntaxes?"):** the
scope chain mirrors pytest node ids (`path/to/test.py::Class::method`) and ctags. `..` ranges
mirror git revision ranges, and `git log -L /regexA/,/regexB/:file` is literal
pattern-to-pattern line-range precedent. The before/after anchor SEMANTICS are exactly the W3C
URL Text Fragment spec's prefix/suffix context (`#:~:text=prefix-,start,end,-suffix`, shipped in
Chrome/Edge/Safari): `@after:X` == `X-,target`, `@before:X` == `target,-X`, `#A..B` ==
`start,end`. `~N` has only weak precedent (sed's Nth-occurrence flag). Deviation noted: text
fragments require IMMEDIATE adjacency for prefix/suffix; our anchors propose NEAREST-in-scope,
which is more forgiving for code.

## Plan

Phase 0 is a security pre-phase added after the questionaire (see its own section for why). Phase
split; each phase independently shippable and gated by the usual local verification
(TS lint+test, Android compile+unit-test+R8 assemble, emulator launch check). Reworked after
audit round 1 (20 agents: 10 dimensions x finder+adversarial verifier; 32 confirmed findings
folded in, 14 refuted) and audit round 2 (16 agents over the rework; 17 confirmed, 16 refuted,
folded in below together with the clean-break ruling). Two premise corrections from round 1: the
phone's blue/red link tier is decided by a hardcoded JS regex at render time (the "rendering side
is already future-proofed" research note above was wrong for a dynamic plugin-claimed scheme),
and the handshake role cache is in-memory only (there is no existing MCP disk-cache pattern to
reuse; the capability cache is new machinery).

## Phase 0: Session identity binding (pre-phase)

Added at the owner's request after the capability endpoint's gating question exposed that
`plans/gateway-auth-surface.md` was decided but never built (that plan has since been deleted as
unsound; its residue lives in `plans/pain-points.md`). Scoped by a 13-agent security battle
(6 grounded advocates, 6 adversaries, 1 de-biasing synthesis) under the owner's own bounded threat
model. The owner's framing: "All WE can do is ensure it can't pretend to be host or pretend to be
another session," with host compromise explicitly out of scope ("game over anyways").

**The two layers are orthogonal.** Network origin (the old plan's IP gate) decides whether a LAN
stranger can reach a route at all. Session identity decides whether a legitimate participant can
speak as someone else. A devcontainer sits on the TRUSTED side of the IP gate, so that plan does
not address the owner's named threat at all. This pre-phase builds the identity layer only; the
IP gate is deferred (see below).

**Granularity correction (forced by the OS, not chosen).** `containerName(team)` resolves to
`<project>_devcontainer-dev-1` and every session of a project is a tmux session on ONE server in
that ONE container, same uid. A compromised `proj.alpha` can `tmux send-keys` straight into
`proj.beta`'s pane and read its `/proc/<pid>/environ`, never touching the gateway. No
gateway-layer scheme can reach below that boundary. So the floor is read at CROSS-PROJECT
granularity: cross-project impersonation closes hard, same-project sibling panes remain mutually
impersonable and always will.

**Mechanism: launcher-injected per-session token.** The daemon already injects `PROJECT_NAME` into
every session it spawns over the HOST_WS_TOKEN-authenticated launch channel. It mints a random
token the same way; the gateway binds name to token and enforces. Zero human secret handling.
Chosen over per-session keypairs on ease alone: `reload_plugins` re-mints an in-process key, which
forces a long-lived rebinding ticket riding the same argv, nullifying the keypair's only
differentiating advantage at roughly 500 lines across three subsystems.

Four corrections the battle forced onto the naive version:

- **Mint once per `SessionRecord`, never per launch.** `ensureSession` returns `created:false`
  without running the launch command when the pane exists, so a reattach ignores the launch string
  entirely. Re-minting per launch would 401 every reattached session. Pinned by a test asserting a
  reattach does not re-mint. Consequence, accepted: no rotation, no revocation short of `forget`.
- **Never vend on first contact.** The `/bridge` upgrade is unauthenticated and stays that way, so
  trust-on-first-register would hand any LAN device a valid credential on request. An unbound
  registrant is DEMOTED, never credentialed: it may operate its own conversation but may not claim
  a name carrying a binding, and may not take the remembered-lead fast path.
- **Derive `from` through the existing `opts` pattern at the HTTP boundary**, not by migrating the
  mutate ops to WS frames. `send()` already carries `opts`, and `consoleHandler`/`gatewayRelay`
  call in-process with `FAKE_REQ` rather than crossing HTTP, so the same end state costs no new
  frame types and no deploy-skew window during which HTTP stays forgeable.
- **`/respond` ownership must cover the `hs-*` and `vc-*` branches**, which resolve BEFORE
  `store.deliver`. `resolveHandshake` checks nothing about who is responding, so
  `isMainOrLead:false` against a known handshake id evicts the victim's socket and the victim's MCP
  then sets `suppressReconnect` and never returns. That is a permanent remote kill of another
  session, and `handshakePending` already stores `{team, subId}` to close it.

Work breakdown:

- **The `host.` prefix is NOT separately reservable** (battle item corrected at implementation
  time). `RESERVED_TEAM_NAMES` and the token gate are exact-match on `"host"`, and the battle
  proposed reserving the prefix as a one-line independent fix. It is not viable: BOTH legitimate
  host paths register `host.<6hex>` (`resolveSessionNaming` composes it for a hand-launched host
  Claude, and the daemon sets `PROJECT_NAME=host.<label>` for one it spawns), so reserving the
  prefix locks out every host session. Verified the squat grants no privilege beyond appearance
  and fan-out: `resolveTmuxTarget` is console-side, reached only over the sealed console relay, so
  registering `host.x` on the bridge WS confers no tmux drive. The bare `host` daemon slot stays
  correctly `HOST_WS_TOKEN`-gated, and `host.*` inherits the SAME protection as every other name
  from the binding below. Residual: an unbound or nonexistent `host.*` name stays squattable for
  appearance and message interception, identical to any other unbound name (residual 5).
- **Mint and bind.** Token on the `SessionRecord`, persisted with it, shipped in the existing
  `WakeMessage` and `HostOp.createSession` frames (already HOST_WS_TOKEN-gated, and `host-op.ts` is
  deliberately type-only so this costs no codegen), plus one `export` appended in
  `buildLaunchCommand`. Two corrections found during implementation, both by tests or the audit:
  - Minting happens at LAUNCH DISPATCH, not at record creation. A record is also created when a
    self-appearing session confirms its handshake, and that session was never handed a token, so
    minting at creation locked every hand-launched session out on its next reconnect.
  - A minted token is not proof of delivery: `ensureSession` discards the launch command (token
    export included) whenever the pane already exists, so a wake that merely reattaches binds a
    record whose live session holds nothing. The binding therefore stays INERT until a register
    actually presents it (`bindActiveAt`), and only an active binding excludes anyone. Without
    this, every reattach, gateway restart, and `reload_plugins` would brick its own session, and
    the MCP has no `register_reject` handler so it would reconnect-loop silently.
- **Consume and enforce.** Read the env in `initBridge`, attach in `buildRegisterMsg` and as a
  header in `routerPost`/`routerGet`. Gateway enforces at register (a claimed name with an active
  binding must match) and on `/send`, `/human/notify`, `/plugin-action`. The rule is REQUIRE, not
  prefer: naming a session whose binding is active demands presenting it, and an absent header is a
  403 rather than a fall-through to the body's own `from` - otherwise omitting the header would be
  the whole bypass. A name with no active binding stays open to its body-declared `from`, which is
  what preserves residuals 4 and 5.
- **Ownership checks on `/respond`.** Both the interception branches (`hs-*`, `vc-*`, which resolve
  BEFORE `store.deliver`) and the main delivery path. Keyed on the LIVE incarnation's own binding,
  never on the record's and never `job.to === bound`: `resolveLiveIncarnation` legitimately returns
  an ALIAS incarnation (a hand-run `claude --resume` serving a bound record under its own unbound
  name), which holds no token and would otherwise have every reply refused. An offline or unbound
  target has no live binding to prove, so its replies stay open.
- **Tighten `confirmedLeadTeams`** from a bare-string `Set` to a binding-keyed `Map`. Free, and
  verified it cannot false-negative a legitimate registrant: `handshakeRole.confirm` is guarded by
  `receivedIds.has(...)`, so `isMainOrLead:true` is only ever sent by a process that actually
  answered that handshake this process lifetime.
- **The capability endpoint stays UNGATED** (settles the question that started this). It returns
  non-secret plugin ids and instruction text, and gating it on a binding would break the
  hand-launched style it exists to serve. Decided here rather than left to Phase 1.

**Deferred, not cancelled:**

- **The origin/IP gate.** Still the only thing covering the LAN stranger, but it cannot ship as
  written: there is no subnet configuration anywhere in the repo, and `start-gateway.sh` runs
  `docker compose down --remove-orphans` then `up`, re-rolling the network on every gateway start.
  A hardcoded `172.18.0.*` is pinned to a subnet the machine re-rolls. Worse, the denylist reading
  fails OPEN (a LAN client at `192.168.1.x` is "not .1", therefore trusted), inverting its one real
  win. Needs deny-by-default semantics, a runtime-discovered subnet, and a decision on
  host-launched sessions. Acceptable to defer: the LAN attacker has no relationship and no
  foothold, while the compromised container is what the owner named first. Tracked in
  `plans/pain-points.md` under Gateway LAN auth surface.
- **Read-side interception (`/poll`, `/pending`).** `PendingJobStore.poll` has no caller check and
  is non-destructive for persistent entries, `pending()` hands out every live job's session_id, and
  `PollRequestSchema` carries no identity field. A compromised container can silently read replies.
  Deferred because closing it needs exactly the identity spine this phase installs, making it a
  small follow-on rather than parallel work.
- **Passive fan-out.** Delivery is never gated on confirmation, so a socket registering a victim's
  name still receives the fan-out. This phase closes the register side for bound names, which is
  the effective fix; the fan-out itself stays ungated.
- **`bindResume` tier 2.** `bind()` finds a record by transcript id regardless of registering team
  and overwrites `claudeSessionId` unconditionally. A name-keyed check does not cover it. Deferred
  on likelihood: `claudeSessionId` is exposed by no route or plane, so it requires knowing the
  victim's transcript UUID out of band.
- **Intra-container siblings.** Permanently deferred. OS boundary.

**Residual risks accepted:**

1. Identity is per-container, not per-session. Same-project panes stay mutually impersonable and
   can harvest each other's tokens from `/proc` and from tmux pane start commands, including future
   siblings' tokens, since `~/.bashrc` sources before the export on every launch.
2. No rotation, no revocation. Evicting a compromised session means `forget`, not restart.
3. The LAN attacker is untouched until the origin gate ships.
4. A `DATA_DIR` purge downgrades every live session to unbound until relaunch, which is exactly why
   an unknown token must fail DEGRADED rather than closed. Otherwise `9) Purge Gateway` bricks the
   running fleet.
5. Hand-launched sessions are unprotected but not broken: they register unbound, behave as today,
   and cannot claim a bound name. The honest cost of zero human secret handling.
6. Read-side disclosure stays open until the `/poll` follow-on.

## Phase 1: Console capability foundation

Clean-break rollout (see ruling above): gateway, MCP, and APK ship together; no cross-version
machinery. The rules below are resilience against a briefly-down gateway or a stale record, not
version compat.

- **Register op:** `enabledPlugins` array of `{id, instructions}` entries, declared `.optional()`
  purely so a not-yet-updated phone cannot brick its register during the minutes of an update
  pass (absent simply contributes nothing to the union). The phone re-registers on a plugin
  toggle. Schema change in `ConsoleOpSchema` -> Kotlin codegen.
- **Gateway store:** a NEW `DurableStore(DATA_DIR, "console-capabilities")` file (the existing
  DurableStore pattern), records keyed by conversationId carrying the reported entries plus TWO
  timestamps: `lastSeen`, refreshed on ANY authenticated op from that conversationId (touched in
  the poll dispatch when a record exists) and used ONLY for the 14-day abandonment GC - an
  always-polling tablet or a phone dozing on the 12-hour tier never expires; and `reportedAt`,
  written ONLY when a register op actually carries `enabledPlugins` - the write-recency arbiter
  (a polling tablet with stale text must not outrank a dozing phone that re-registered fresh
  text). Swept on the existing persist tick beside sessionStore/durableOpStore sweeps;
  500-conversation cap. (Audit round 1: "non-forgotten consoles" had no referent. Round 2:
  register-only refresh contradicted the asleep-phone goal. Round 3: the GC touch cannot double
  as the instructions arbiter.)
- **Union + zero-record rule:** the served union is over non-expired records. Zero records serves
  `known: false` - never an affirmative empty union - and the MCP maps that to the fail-open core
  set below.
- **Capability endpoint:** serves `{known, capabilities: [{id, instructions}]}`. UNGATED, settled
  in Phase 0. It returns non-secret plugin ids and instruction text, strictly less sensitive than
  the `/teams` and `/pending` surfaces already open beside it, and gating it on a session binding
  would break the hand-launched host window that startup-fetch was chosen to serve (Q6). It joins
  the gated set when the deferred origin gate ships. (Round-2 audit called it "higher-value recon
  than /teams"; reading the actual surface, that was backwards - `/pending` leaks live session_ids
  that arm reply forgery.)
- **Instructions text:** owned by the phone-side plugin manifest, shipped in the register op;
  latest-writer-wins per capability id on device disagreement, arbitrated by `reportedAt` (never
  `lastSeen`); surfaced to the agent via the MCP server's instructions mechanism.
- **MCP fetch:** a dedicated bounded helper, not routerGet (routerGet has no timeout, retries
  past any bound, and cannot see status codes): a raw fetch of the capability endpoint with
  `AbortSignal.timeout(~1500ms)` and zero retries, run AFTER startMcp's existing
  inContainer/localhost defaulting of `BRIDGE_ROUTER_URL` (so it sees the same resolved URL the
  bridge itself uses in every launch style) and BEFORE McpServer construction so the result can
  feed the server-level instructions. Two
  outcomes: a 200 with a schema-valid body is used; ANYTHING else (401 tokenless host window,
  timeout, refused, malformed) falls to the disk cache (a small JSON beside the MCP's state; a
  devcontainer rebuild wipes it), else the fail-open core set (`{designer}` plus `references`
  once Phase 3 ships). Only an affirmative union lacking a capability disables its tools.
- **Multi-gateway Domain: explicitly deferred.** The console reports to its one route gateway; a
  session on another same-Domain gateway finds `known: false` and lands on the fail-open core
  set. The future fix mirrors fanOutConsolePush; out of scope here ("Only 1 PC anyways").

## Phase 2: MCP ref detection + resolution engine

- **Grammar toolchain:** a checked-in build script (pinned tree-sitter-cli version MATCHED to the
  pinned web-tree-sitter release line, emsdk or the CLI's docker fallback) builds every grammar
  wasm from pinned grammar-source versions; outputs committed plus a manifest recording the CLI +
  grammar versions. SEVEN grammars: TS, TSX (separate grammar - plain TS cannot parse .tsx), JS,
  C++, C#, PY, GDScript (community grammar by Preston Knopp; no published wasm exists, it is
  built, never harvested). Never harvest npm prebuilts (known web-tree-sitter 0.26.x ABI/link
  break with older-CLI wasms). Per-language load+parse vitest runs in the default `bun run test`
  so a Dependabot bump that breaks the committed wasms fails in the PR. Extension-to-grammar map
  is explicit (`.tsx` -> tsx, etc.).
- **Detection grammar:** the scanner matches only markdown inline-link destinations
  (`](ref://...)` and the angle-bracket form) OUTSIDE code fences and inline code, by masking
  fence/inline-code spans (CommonMark rules) before the match. A fenced example ref is never
  detected, so documenting the feature in a message cannot hard-fail the send.
- **Canonical ref form (structure-preserving):** canonicalization splits on the STRUCTURAL
  `:`/`#` separators first, then percent-decodes each component - never decode-then-split, which
  would conflate a literal `%3A` in a filename with a scope separator and collide two distinct
  refs onto one key. The canonical key is the structured tuple (path, segments[], matcher),
  serialized with `%`/`:`/`#` re-encoded inside components. The MCP writes canonical keys as
  manifest keys; the phone canonicalizes the tapped `data-href` (markdown-it normalizeLink
  mutates hrefs) before lookup. Cross-runtime vectors (tests/fixtures pattern) cover space,
  angle-bracket, percent-literal, non-ASCII, and the literal-colon / literal-hash filename pairs
  asserting distinct refs produce distinct keys in both runtimes. Ownership split: Phase 2 ships
  the vector corpus plus the TS-side assertion; the Kotlin canonicalizer and its vector-consuming
  Android unit test are a named Phase 3 deliverable (tap-chain bullet).
- **Confinement:** reject absolute paths and any `..` segment before joining; realpath the
  resolved file and assert containment inside the project root (symlink escape rejected). An
  escaping ref is a hard tool error, never a silent attach (full-body scanning would otherwise be
  a confused-deputy attach primitive for relayed hostile text).
- **Resolver rules:**
  - Waypoint navigation: each segment matches any DESCENDANT scope of the previous match, not
    only a direct child - shallowest match first, then document order, with the multi-match
    rules below applied to the collected set. Deep JS nesting through anonymous closures needs
    no naming: `ref://app.js:MyComponent:handleSubmit` resolves regardless of unnamed layers
    between the two. Pseudo-segments (`arguments`, parameter names) are exempt: they navigate
    structurally from the current node only.
  - Fragment forms (W3C text-fragment semantics under cleaner spelling): `#T` is the first match
    of T inside the innermost resolved scope; `#T@before:X` / `#T@after:X` pick the occurrence
    of T nearest BEFORE / nearest AFTER the first match of X (nearest-in-scope is a deliberate
    deviation from the spec's immediate-adjacency prefix/suffix); `#A..B` is a range - the first
    match of A, then the first match of B after it, highlighted A's first line through B's last
    line (blue band per the unified rule). `..`, `@before:`, and `@after:` are STRUCTURAL in the
    fragment; literal occurrences percent-encode (one dot of the pair, or the `@`).
    Canonicalization parses them structurally (the matcher component of the canonical tuple is
    the parsed expression), with vectors covering literal `..` and literal `@` cases. Anchor-miss
    (X absent) and range-end-miss (B absent after A) degrade like matcher zero-match: quality
    `fuzzy` with the specific reason, range = the innermost scope (anchor case) or A's match
    line (range case).
  - `::` collapses to `:` (empty segments merge), so the natural C++ spelling `A::B::method`
    works; the C++ resolver additionally matches segment chains against out-of-line qualified
    declarators (`void A::B::method()` in a .cpp has no nested scope nodes to walk).
  - Compound node names: a scope node whose own name is multi-part (C# `namespace A.B` is a
    qualified_name, C++17 `namespace A::B` is a nested_namespace_specifier) matches a RUN of
    consecutive ref segments, consuming one per name part. Fixtures for both forms.
  - C# file-scoped namespaces (`namespace Foo;`, the modern default) have no body node; their
    effective body is the run of following siblings in the compilation unit. Fixture added.
  - Multi-match: an intermediate segment collects ALL same-named scope nodes and the walk
    continues into the union of their bodies (re-opened C++ namespaces, C# partial classes, TS
    overload signatures). The walk state is `(node, remaining-segments)` per branch, never a
    single shared segment index: a compound-name match advances only its own branch's cursor by
    its run length, and a branch whose cursor is exhausted is a final match regardless of how
    many segments its siblings consumed (fixture: a compound `namespace A::B` beside a re-opened
    nested `namespace A { namespace B {} }` in one file). A FINAL match set with multiple
    declarations resolves to the first in document order and records `ambiguous: true` + match
    count (viewer shows "1 of N"). Multi-match is never a failed scope.
  - Matcher zero-match: ship with the innermost resolved scope as the range, quality `fuzzy`,
    reason `matcher-miss` (banner names the matcher text; scope band blue; no character amber).
  - Fuzzy tier exhausted (failed segment's text absent from the file): ship the whole-file
    artifact, quality `unresolved`; viewer opens at file top, banner names the segment.
  - File types: a bare `ref://path` is legal for ANY file that sniffs as UTF-8 text (rendered
    plain, hljs skipped for unknown languages). A UTF-16 BOM is detected BEFORE the UTF-8 sniff
    and the file is transcoded to UTF-8 for the snapshot (all coordinates refer to the transcoded
    text, which is what ships). A scope chain or pseudo-segment against an unwhitelisted text
    file skips AST and resolves via the fuzzy line-match tier, marked fuzzy (never a hard fail -
    drift philosophy). A file failing both (binary) is a hard tool error in every ref form.
  - An over-cap file whose resolution produced NO range (bare path form, or fuzzy exhausted) is a
    hard tool error with an actionable message ("file exceeds snapshot cap; add a scope or
    #matcher to reference a region"). A matcher-miss whose fallback range is the WHOLE FILE
    counts as no-range for this rule (it must not smuggle an oversized file past the cap).
  - Hard failure NEVER comes from the resolution tier (scope and matcher failures always
    degrade). The complete hard-error set: file tier (missing, unreadable, binary, confinement
    escape, over-cap-with-no-range) and builder tier (a single resolved range alone exceeding the
    per-file cap, aggregate-budget exhaustion, reserved-artifact-name collision at compose time -
    all below).
- **Artifact builder:**
  - Manifest identity + SELECTION rule: the manifest is the single files entry that (a) bears
    the reserved filename, (b) schema-validates including its self-describing top-level marker
    key, and (c) is the FIRST such entry. Every other marker-bearing file - a snapshot of a
    project file that happens to contain the marker text, or a forwarded attachment crafted to
    carry it - is an ordinary attachment the plugin never consults, so content alone can never
    get a foreign file adopted as the manifest. The builder places the manifest first and treats
    an agent attachment colliding with a reserved artifact name as a hard tool error at compose
    time (which is what keeps (a) unclaimable). The plugin additionally rejects wholesale a
    manifest naming snapshot files absent from its own row.
  - Snapshot filenames are precomputed phone-safe MCP-side (replicating the phone's
    safeName/uniqueName semantics once: basename-only safe charset, 120-char cap, deduped across
    the ENTIRE files array including the agent's own attachments); the manifest records the exact
    shipped name per file entry. A cross-runtime vector pins the two sanitizers equivalent.
  - Per-FILE manifest entry: `mode: "full" | "snippet"`. Snippet mode ships an ordered segment
    list, each segment carrying `startLine` in ORIGINAL-file coordinates plus its text; multiple
    refs into one oversized file coalesce (union, plus 3 context lines each side, coalescing
    never re-inflating past the caps) into that single entry's segments, preserving
    one-copy-per-file. All per-ref ranges and character spans are always in original-file
    coordinates regardless of mode, so the viewer renders true line numbers with elision markers
    between segments. The 256 KB per-file cap applies to snippet-mode segment bytes too: a single
    ref whose resolved range ALONE exceeds it is a hard tool error with the existing actionable
    message.
  - Aggregate budget with a defined ladder: a per-message total artifact byte cap (2 MB decoded)
    on top of the 256 KB per-file cap. A file is snippet-ELIGIBLE iff none of its refs' resolved
    or fallback ranges is the whole file (a bare-path, unresolved, or whole-file matcher-miss ref
    pins its file to full mode). Over budget: degrade snippet-eligible files to snippet mode,
    largest first; if the budget is still exceeded once everything eligible is degraded, the send
    is a hard tool error naming which refs to narrow (consistent with the hard-fail philosophy:
    the agent is right there). Keeps any single reply far below transport ceilings (the
    backlog-side ceiling is recorded in `plans/pain-points.md`, not owned here).
- Wired into `channel_reply` + `notify_human` when the `references` capability is present.
- Vitest suite against the real vendored grammars per language, including C++ out-of-line
  definitions, overload sets, .tsx, GDScript inner classes, waypoint resolution through anonymous
  JS nesting, and the fragment forms (ranges, anchors, anchor-miss, range-end-miss).

## Phase 3: Phone References plugin + linkHandlers + renderer tier

- **linkHandlers registry:** a plugin claims a URL scheme; the handler receives
  `(team, resolvedRow, url)` - the framework resolves row identity before dispatch (next bullet).
  `openLink` consults core schemes + claimed schemes.
- **Renderer-side tier (the JS regex, not Kotlin, decides blue/red):** `installThreadLinkRules`
  gains a dynamic handled-scheme list, injected by ThreadRenderer at page init and re-pushed on a
  plugin toggle (setTheme-style push). A plugin-claimed scheme renders BLUE-tier styling but
  KEEPS the inert anchor form (href stripped, target in `data-href`) - deliberately, because a
  kept-href anchor's tap goes through WebView navigation, which has no row context; only the
  JS-side tap path can see row identity. Staleness: already-rendered rows keep their stale tier
  (the row fingerprint excludes it - same accepted-staleness precedent as chip decoration).
  `thread-markdown-link-rules.test.ts` updated for the dynamic list and the blue-inert form.
- **Tap chain carries row identity end to end:** the delegated JS click listener reads the
  tapped anchor's enclosing row's `dataset.id`/`dataset.at` and calls a NEW bridge method
  `linkTap(rowId, rowAt, href)` (the readUpTo bridge pattern; `shouldOverrideUrlLoading` stays
  the path for http/https/mailto only), because the same ref URL string in two messages maps to
  two different snapshots (snapshot semantics) and a bare row id can be reused after a forget.
  The FRAMEWORK side of the dispatch (the openLink wiring, which owns Repo) resolves
  `(team, rowId, rowAt)` to the live Message and invokes the claimed handler with the resolved
  row's files alongside team and url (the AttachmentOpener resolved-coordinates pattern) - a
  plugin never reaches into ChatRepository itself. The phone-side ref canonicalizer lives at this
  hop (canonicalizes the tapped `data-href` before manifest lookup) and consumes the Phase 2
  vector corpus in an Android unit test.
- **Lazy tap-time resolution (no authoritative store):** the tapped message's OWN files list
  carries the manifest + snapshots; the handler reads and validates the manifest from that
  resolved row at tap time (bounded read, DesignerCardOpener pattern), resolving the tapped
  canonical ref against THAT message's manifest. Honors per-message snapshot semantics and works
  retroactively for messages drained while the plugin was disabled or before install.
- **Miss contract (guaranteed reachable, not just transitional):** a tapped ref whose row
  resolution fails (row gone, rowAt mismatch), whose row carries no valid manifest (crosstalk
  bodies are unscanned by design, and mirrorPeer copies them - plus their reply artifacts - into
  peer rows; pre-feature history; purged bucket; schema-invalid), or whose canonical key is
  absent from the manifest, degrades to the existing link context menu with a "no code snapshot
  attached to this message" note. Never a crash, a silent no-op, or a wrong-row open.
- **Peer rows are treated the same as agent rows:** the artifacts already ride the mirror
  (channel_reply is the scanned tool, and agent-to-agent replies go through it), so drain-time
  seeding, hide, amber, and tap resolution all apply to isPeer rows; a peer row without a
  manifest (a crosstalk_send body) falls under the miss contract.
- **Drain-time display index (the amber + hide data source):** the References plugin claims an
  `inboundMessages` handler that, at drain time (disk allowed there, unlike the serialization
  site), does the bounded manifest read and seeds a small persisted, display-only per-message ref
  summary: quality per canonical ref, plus the artifact file srcs to hide. The chat-body amber
  map and the chip Hide verdict consult THAT index in-memory at the serialization site
  (decorateFile's in-memory contract holds). Explicitly NON-authoritative - tap-time manifest
  reading stays the authority, so "no authoritative store" stands. Lifecycle: the plugin claims
  `threadForgetHandlers` and `accountWipeHandlers` to drop its persisted per-team index on Forget
  and on account wipe (Designer pattern). Staleness posture: rows drained before install/enable
  get plain visible chips and no amber (accepted, no backfill - same posture as chip decoration),
  while tap-time viewing still works retroactively on them.
- **Chip handling:** the decorator contract is extended with an explicit hide verdict (sealed
  Decorate/Hide) honored by thread.js buildFiles - hiding does not exist today (decorator is
  restyle-only). Hide decisions come from the drain-time index above. Staleness accepted as
  above. Descope fallback if contentious: label-only chips.
- **Chat-body amber for fuzzy refs:** the link_open rule tags a `link-fuzzy` class from a
  per-message ref-quality map riding the serialization payload, sourced from the drain-time index
  (in-memory at the serialization site). Kept because the accepted Q4 answer promises amber in
  chat.
- **Viewer:** full-screen WebView page in the thread assets family. HARD escaping contract: code
  renders only via hljs's escaped output or an escaped-text fallback; every manifest-derived
  string (breadcrumb, filename, matcher, banner text) enters the DOM via textContent, never
  innerHTML; same resource-block posture as thread.html. Line-number gutter (hljs has none
  natively), blue line bands, amber character ranges applied by a post-highlight text-node walk
  (survives hljs's span rewriting), dismissible fuzzy banner, breadcrumb header, snippet-mode
  elision markers with true line numbers, light AND dark theming. GDScript grammar vendored for
  hljs.
- **Retention:** attachment lifecycle, unchanged.

## Phase 4: Teaching + end-to-end verification

- Agent-facing docs: ref format in the reply tools' descriptions and the crosstalk skill,
  including the fragment forms (`#T`, `#T@before:X` / `#T@after:X`, `#A..B`) with their encoding
  rules (raw spaces in a matcher must be %20-encoded or the markdown link degrades to text;
  literal `..` or `@` in matched code percent-encodes), the fenced-ref note (refs in code fences
  are never detected), and the crosstalk note (refs in crosstalk_send bodies are unscanned; the
  console's mirrored copy degrades to the miss contract).
- E2E: emulator pass with real ref-bearing messages across all seven grammars, including fuzzy,
  ambiguous, snippet-mode, range and anchored refs, and hard-fail paths, a capability-toggle
  restart cycle, and one agent-to-agent ref-bearing exchange observed from the console's peer
  thread.
