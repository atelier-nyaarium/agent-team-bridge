# Questionaire

## Question 1 - Where does a runbook live?

Q: Does a runbook's text live in Router-held owner state, on disk as a Claude Code skill file, or on
the gateway?
A: On the gateway, per machine. The phone syncs it, and pushes it to a gateway that does not have it
before running. Which gateways a runbook applies to is decided the way the vault plugin decides it.

> "it's simpler of per gateway. Maybe we have it synced by phone. Opting is automatic depending on
> who the phone says the runbook applies to. if it didn't exist, push and run."

The recommendation offered against this was withdrawn. It rested on Router-held state staying
reachable while the machine sleeps, which is false: the federation Router runs on the same box as
the gateway, so both are down together. The `Purge Gateway` argument beside it was noise, since
losing gateway state is that command's purpose. What remained was only that a Router-held runbook
reaches a second machine without being written twice, against a Router service, a record kind, an
owner plane, quotas and a sealing kind. Per gateway is the cheaper shape.

Firing happens on the gateway, not the phone. The phone sequencing create-a-session then send-to-it
is two operations that fail apart and race the daemon's own greeting; the gateway does it as one,
and already keeps an `op-idempotency` store that makes a retry safe.

Which gateways a runbook applies to needs nothing on the wire. The vault seals its gateway allowlist
because the Router holds every entry and every gateway syncs all of them, so an entry must carry its
own refusal. A phone that pushes directly can simply not push, so "applies to" stays a phone-side
filter.

## Question 2 - Does the gateway store a runbook, or does the fire carry it?

Q: The gateway could hold a pushed runbook and fire it by id, or hold nothing and take the whole
body on every fire.
A: The gateway stores it. Push once, fire by id, with a list, a read, a delete and a version check
so "if it did not exist" also covers "if it changed".

> Routines decides it. A body carried on every fire is simpler and cannot drift, but only the phone
> holding a runbook could fire one. Scheduled sends already run from the Router without the phone,
> and a routine that fires while the phone is in a drawer needs the gateway to hold the body
> already.

## Question 3 - What does a fire land in?

Q: A fresh session every time, an existing session picked at fire time, or either?
A: Either, chosen when firing, defaulting to fresh. The operation takes a target to create in, or a
session id to send to.

> Fresh has to exist regardless, since a schedule has nobody to pick a session. Once it does,
> existing is one field and one branch, and it is the right answer for work that belongs in the
> session already doing it.

A new session carries the daemon's own greeting, typed into the pane after launch, while the runbook
arrives over the wire. The two roads share no ordering, so the fire waits for the session to
register before sending.

## Question 4 - Do runbook sessions clean themselves up?

Q: A fired session is ordinary and closed by hand, closed after the pane sits idle, or told to stop
by the runbook's own words?
A: Ordinary, named after the runbook. Nothing automatic.

> A wrong auto-close kills work in progress, which is worse than a long list, and idle is a poor
> proxy for done while an agent thinks or waits on a build. Sprawl bites once Routines fires
> unattended, and that is where it should be answered, knowing whether a routine reuses one session
> instead of spawning each time.

A `SessionRecord` carries no lifecycle flag, and `close_session` is always deliberate, so anything
automatic would be built fresh.

## Question 5 - What can a parameter be?

Q: A named blank, a text or a choice, or four kinds with a number and a boolean?
A: Text and choice.

> The agent receives text either way, so a kind buys comfort on the phone and nothing at all for the
> agent. Choice earns its place because it is a correctness win rather than a comfort one: it stops
> `prod` being typed where `staging` was meant. A number and a boolean are keyboard hints over a box
> that already accepts them, and both stay additive later.

Two things follow rather than being asked. The gateway renders the body, since it holds the runbook
and the fire carries an id and the values, so the placeholder grammar lives there too. And a missing
value refuses the fire, naming the empty parameter, rather than shipping a raw placeholder to the
agent as if it were instruction.

## Question 6 - Who writes a runbook?

Q: The phone with a real editor, an agent through a tool, or both?
A: The phone. "Configurable from the phone" meant writing them there.

The phone stays the sole author, so nothing on the gateway ever writes a runbook and no conflict
rule is needed. The editor is the largest piece of interface in the feature: a name, a long body,
and a repeating parameter sub-form with a nested list for a choice's options.

## Question 7 - Where does the parameter list come from?

Q: Derived from the placeholders in the body, or maintained by hand beside it?
A: Derived. Answered by looking at the editor mockup rather than in prose.

> A placeholder with no parameter cannot exist, and a parameter nothing uses cannot exist either, so
> a whole class of mismatch is deleted rather than warned about. It is also less typing, which is
> what choosing the phone as the author is optimising for.

The label, the kind and a choice's options live keyed by the placeholder's name. Deleting a
placeholder orphans them; they are kept while editing, so pasting it back restores its settings, and
pruned on save.

# Design

Locked from three cards in the Designer dock, drawn in the app's own palette, which is stock
`darkColorScheme()` with no custom colours.

**The tab.** A row per runbook: name, a one-line summary, its parameters as chips, and Fire on the
row itself. A runbook fired daily is two taps, not a screen away.

**The editor.** Name, then the body as a real text area rather than a dialog field, then the
parameters under it. Each parameter is titled by its own placeholder, expandable to a label, a
Text/Choice segment, and for a choice a removable chip per option. That nested list, options inside
a parameter inside the parameter list, is the only genuinely fiddly piece; nothing in the app builds
a repeating form inside a repeating form today, and `VaultEntryDialog` is flat by comparison.

**The fire sheet.** A bottom sheet, as the vault request sheet is, since it is a decision made and
dismissed. The values, then where it lands as a New session or Pick one segment with the target
beneath, then a preview of the rendered body with the values filled in, then Fire.

**The preview is load-bearing, not decoration.** A fired runbook is otherwise indistinguishable from
a message typed by hand, which was raised as a weakness twice; showing exactly what will cross the
wire answers it at the only moment it matters.

A body carries rules, not only steps. "Never hand-edit a version" belongs in the release runbook
because the agent reading it may not go looking for `AGENTS.md`. Bodies are paragraphs, which is why
the editor needs a text area with room to scroll.

# Plan

## Phase 1 - The record and the store ✅

The wire shape of a runbook and its parameters, in `shared/`: an id, a name, a body, and a list of
`{ name, label, kind, default, options }` where kind is `text` or `choice`. A durable store on the
gateway beside `vault-decisions` and `vault-helper`. Console ops to list, put and delete, phone to
gateway. Kotlin codegen and the gate. No interface yet.

Caps were built here and then taken back out, on the owner's word: "no hard limits. Their server,
their responsibility." A runbook op reaches one gateway, authenticated as its owner, so a body large
enough to hurt is the owner spending their own machine. The console path's 64 MiB body cap is the
only ceiling left, and it answers 413 rather than something obscure. Removed with them was the
rendered-size refusal, which existed only to keep a fire inside a cap that no longer exists.

Five things the phase line did not name, settled while building it.

**The record carries a `revision`, and nothing else beyond the four fields.** Question 2 asked for a
version check, so the revision is the field that answers it. A timestamp was written and then taken
back out, because nothing in the locked design reads one and a wire field no consumer needs becomes
a field nobody validates.

**A revision is the whole of the concurrency control.** A higher one replaces, a lower one is
refused and told what to rebase on, and an equal one is a retry when the content matches and a
refusal when it does not. That last case is the one worth having: the owner can enroll a second
device, and without it whichever device pushed last would silently erase the other's edit.

**A held record is frozen, and the copy is made on the way in.** A reader cannot edit the store by
editing what it read, and the store does not take ownership of the caller's object either. This
guards Phase 2 in particular, where a renderer that assigned to `runbook.body` would otherwise
corrupt the store and persist it.

**Restore keeps whatever the schema accepts.** The semantic rules run in `put`, which is the only
writer, so a stored record passed them when it landed. Re-running them on restore was tried and
reverted: it silently erased the owner's work on the next write, which is worse than serving a
record a later rule dislikes. Phase 2's fire re-checks instead, where a refusal can reach the owner.

**Nothing counts runbooks or measures them.** No per-gateway limit, no body length, no parameter
count, no option count. A record is refused for what it means, never for its size.

The wire crossing is nothing. `runbook_put` is sealed phone to gateway like every console op, and no
field takes a deploy-order shim because no peer reads a runbook yet.

### Bug Classes

- **Brace text the placeholder grammar does not see, in `runbookRefusal`:** the grammar is one
  regex that recognises a well-formed `{{name}}` and is blind to everything else shaped like one,
  so each new way of writing braces is a separate guard rather than a case the grammar already
  covers. Three rounds found three instances. Round one: a nested `{{a{{b}}}}` matched only the
  inner placeholder, so the record stored and a render left `{{a` behind. Round two: a choice
  option or default could itself be `{{other}}`, which a renderer substituting more than once would
  expand, making the output depend on substitution order. Round three: a body and a value can each
  be innocent and still compose, since `{{a}}{foo}}` filled with a value ending in `{` renders
  `{{foo}}`; no guard over the body alone can see it, because the brace pair does not exist until
  the substitution happens. Rounds one and two were patched with a guard beside the scan; round
  three was left, because a third guard on the same mechanism is the design bug rather than the
  cure. The structural fix has two halves, and only the first is a tokenizer. One parse of the body
  into literal and placeholder tokens, with `placeholdersOf`, `worstCaseRender`, validation and the
  render all derived from it, makes malformed template text one grammar decision instead of a
  growing row of guards. It does not reach round three, because that pair composes only once a
  value is substituted, so the render must also check its own output rather than only its input.
  Both halves belong in Phase 2, beside the renderer. The grammar is a pure shared rule rather than
  wire truth, so it goes in `shared/` and takes a hand-written Kotlin twin pinned by fixtures when
  Phase 4 derives the parameter list on the phone, as `versioned-list` and `RefGrammar` already do.

  Phase 2 built both halves. `parseBody` in `runbook-grammar.ts` is the tokenizer, and a stray
  opener is now the grammar refusing rather than a guard beside it, so round one and the round
  before it are gone as cases rather than patched. The render reads its own output, which is what
  reaches round three. One guard survives beside the grammar, refusing an opener inside a stored
  default or option, and it earns its place by catching the mistake while the owner is still editing
  rather than at fire time. It cost a fourth instance to get right: it also refused a lone `}}`,
  which the body grammar allows, so a legitimate option was refused. Now both read the same rule.

- **Where the semantic rule gets applied, in the store's restore path:** `RunbookSchema` checks the
  shape and `runbookRefusal` checks the meaning, and the two are consulted at different boundaries,
  so each round moved the second one and broke something new. Round one found restore consulting
  only the schema, so a record the rules refuse could be served. The patch filtered those records
  out on restore; round two found that this silently erased them from disk on the next write, up to
  every record at once after a rule change, with the phone unable to tell a discarded runbook from
  one it never pushed. Reverted. Restore now keeps whatever the schema accepts, which is sound
  because `put` is the only writer and the meaning was checked before anything landed. Phase 2's
  fire re-checks before it renders, which is where a stale record actually matters and where a
  refusal can reach the owner instead of deleting their work.

### Removed in passing

- **`isMutatingOp` and `isBoardMutationKind`, in `consoleTypes.ts`.** The first read like live
  policy, naming the ops whose results are replayed rather than reapplied, and nothing imported it;
  the second was reachable only from it. `durableOpStore` is consulted only on the delivery paths,
  so no value op is replay-cached, `vault_revoke` included, and an entry in that list claimed a
  behaviour the gateway does not have. Deleted on the owner's word: "unused code? remove it."

## Phase 2 - The fire ✅

Two gateway ops rather than the one this line first named. `runbook_fire` takes a runbook id, the
values, and where it lands. It renders, refusing and naming the parameter when a value is missing
rather than shipping a raw placeholder as instruction. A fresh target creates the session, waits for
it to register, then delivers; an existing session target delivers straight away. Idempotent through
the `op-idempotency` store already there, so a retry cannot fire twice.

`runbook_preview` takes the same id and values and answers the text, reaching the same words through
the same render without sending them.

Two checks the record cannot carry, since neither has anything to look at until a fire. A choice's
value must be one it offers, which no stored rule can enforce because the value does not exist yet.
And the fire re-checks the runbook it is about to render, so a record a stricter rule would now
refuse is reported to the owner rather than fired or quietly deleted. Neither is a size limit.

A fire that cannot reach its session does not fire. The gateway being off fails like any other
console op, and a session that never registers is left running and reported rather than closed or
delivered into blind. Nothing new is built for either.

The idempotency is the op store's, so it inherits the op store's bounds: a completed fire is
remembered for fourteen days, and a conversation holds its most recent few hundred operations. A
retry beyond either window fires again, which is the same promise `send` and `respond` already make,
and a migration drops in-flight markers by design, so a fire interrupted by one can be re-run. The
fire refuses outright on a gateway without that store, since a guarantee that quietly is not there
is worse than one that is absent loudly.

**The preview is the gateway's render, not the phone's.** The design calls the preview load-bearing,
which means it must be what actually crosses the wire, and that settles a question Phase 3 would
otherwise face: whether the phone gets a Kotlin twin of the grammar. It does not. `runbook_preview`
renders through the same function a fire does and returns the text, so there is one implementation
and no corpus to keep two of them honest. The cost is a round trip while the owner fills the form,
which the phone can debounce, and no preview offline.

Preview and fire are two moments, so the revision closes the gap between them. A preview answers the
revision it rendered, a fire may name the revision it was shown, and a fire naming an older one is
refused rather than sending words the owner never read. Nothing sends it yet, so it is optional
until the phone does.

**Fired means what sent means.** A fire into a session already running hands the body to the same
route a typed message takes, so a session between sockets has the message queued rather than
refused, and the fire reports it landed. Making the fire stricter than typing the same words would
break the thing the design is for, which is a runbook being indistinguishable from the owner saying
it. The create path is where "cannot reach it" bites, and there the fire waits for registration
first. A fired body also leaves the same `sent` row a typed one does, so it is in the owner's
history rather than only in the fire's answer.

### Found in passing

- **A devcontainer session name can be claimed in the window before its binding arms.** The fire
  creates a session and waits on `awaitRegister`, which resolves for the TEAM rather than for the
  record it minted. A host spawn session is safe, because `websocket.ts` refuses a register for one
  without the daemon's own launch token. A devcontainer team is not covered by that check, so a
  socket registering on the fresh name first would satisfy the wait and receive the body, and the
  legitimate registration would evict it only afterwards. The gateway's socket is loopback-only, so
  this needs a process already on the machine, and it is the same window any `create_session`
  followed by a `send` has had. Not this feature's to close, and a real one: the fix is a wait that
  resolves on the minted record's bind token rather than on the name.

## Phase 3 - The tab and the fire sheet

The Runbooks tab, the row with Fire, and the bottom sheet: values, target, preview, Fire. The phone
pushes a runbook the gateway does not have, or has at an older version, before firing it.

Its first slice is the phone-side client plumbing, which Phase 1 deliberately left out. Phase 1
generated the Kotlin types and stopped; nothing on the phone calls `sendValueOp` for the three
runbook ops yet, so a `ConsoleClient` method and a repository ops class come before any screen.

The fire sheet's preview calls `runbook_preview` rather than rendering on the phone, so the values
form debounces its calls, keeps the last text while the owner types, marks it stale when a value
changes, and pins the Fire it sends to the revision the preview answered.

`docs/runbooks.md` and its row in the `AGENTS.md` table land here too. Until a tab exists there is
no subsystem to describe that this plan does not already describe better, and a second copy would
only drift.

## Phase 4 - The editor

Name, body, and the derived parameter list with its nested options. The largest interface piece, and
last because everything else is provable without it.

## Open, to settle inside the phases

- What a fire does when the gateway is offline, or the session never registers.

## Painpoints

- **Adding one console op is nine edits and only two of them are checked.** `runbook_list` needed a
  variant in `ConsoleOpSchema`, an entry in `VALUE_OP_KINDS`, a result schema, a place in the
  `ConsoleOpResult` union, a handler method on the deps interface, a `case` in the dispatch switch,
  a compose stage, its wiring in `composeGateway` and `composeRouterFrames`, and an import plus a
  `ROOTS` entry in the codegen. The compiler caught exactly two omissions: the result union and the
  switch's exhaustiveness. `VALUE_OP_KINDS` is the dangerous one, because an op missing from it
  parses fine and then is simply unroutable, with nothing failing at build time to say so. This is
  the second sighting of the class already recorded against wire renames in
  `plans/claimed-backlog.md`: a checklist spread across files, where the type system covers part of
  it and the rest is found by a person or not at all. A descriptor per op, carrying its kind, its
  routing class and its handler, would collapse the unchecked half.

- **`kotlin-gate.sh` reports success in a way that looks like it skipped the work.** After
  regenerating `Protocol.kt` the run ends `26 actionable tasks: 1 executed, 25 up-to-date`, which
  reads as though nothing recompiled. It had; the compile is one of the lines above the summary. But
  confirming that meant finding the generated class files and comparing their timestamps against
  `Protocol.kt`, twice, because the gate's own output does not distinguish a real build from a
  no-op. Printing whether the protocol sources recompiled would end that.

- **Codex conciseness audits need more triage than they save unless the standard is handed to them.**
  Given the prose rules alone, the pass declared 30 of 31 comments in this phase too long and
  proposed replacements like `/** Ignore key order. */` for a line stating which fields a comparison
  reads and why key order is excluded. The house standard is set by files like
  `src/gateway/vault/decisions.ts`, whose comments are full one-line sentences, and an auditor
  reading only the rules lands well below it. Naming a sibling file as the calibration standard in
  the prompt is the fix, and the same applies to the next three phases.

- **The federation harness flake recurred, now named.** `federation-harness-boot.test.ts`, the case
  `converges to one presence row per team when a session reattaches after a gateway restart`,
  failed once in five full runs and once in three, passing alone and on every rerun. Already
  recorded in `plans/claimed-backlog.md`; noting only that it is still there and now identified.

## Settled inside a phase

**A pushed body is already sealed.** Settled in Phase 1, against the premise it was written on. The
open question said a console op's request is not content-sealed the way a vault value is, so the
Router relays it in the clear. That is false: the phone seals the whole `ConsoleOp` under the
`op.payload` AAD before it leaves the device, on both runtimes, and the gateway opens it after the
Router has relayed the envelope. A `runbook_put` body therefore crosses sealed like every other op,
and needs nothing of its own.
