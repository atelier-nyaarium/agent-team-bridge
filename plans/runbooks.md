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
retry beyond either window fires again, which is the same promise `send` and `respond` already make.
The fire refuses outright on a gateway without that store, since a guarantee that quietly is not
there is worse than one that is absent loudly.

A durable record says a fire started, never that one is still going, so the two are read from
different places. A completion on disk replays. A fire this process started is held in memory and
refuses a second attempt. Anything else runs, which is what the store's own contract asks for and
what lets a gateway that died mid-fire be retried instead of wedged. The memory is released only
once the completion is on disk, so a success the migration fence refused to record cannot be
delivered twice.

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

## Phase 3 - The tab and the fire sheet ✅

The Runbooks tab, the row with Fire, and the bottom sheet: values, target, preview, Fire. The phone
pushes a runbook the gateway does not have, or has at an older version, before firing it.

The sheet holds its state in one `FireSheetState` rather than a row of remembered fields, because
the form belongs to a runbook at a revision and a fire in flight belongs to the sheet, and keying
both the same way was wrong in each direction it was tried.

Its first slice is the phone-side client plumbing, which Phase 1 deliberately left out. Phase 1
generated the Kotlin types and stopped; nothing on the phone calls `sendValueOp` for the three
runbook ops yet, so a `ConsoleClient` method and a repository ops class come before any screen.

The fire sheet's preview calls `runbook_preview` rather than rendering on the phone, so the values
form debounces its calls, keeps the last text while the owner types, marks it stale when a value
changes, and pins the Fire it sends to the revision the preview answered.

`docs/runbooks.md` and its row in the `AGENTS.md` table land here too. Until a tab exists there is
no subsystem to describe that this plan does not already describe better, and a second copy would
only drift.

### Bug Classes

- **One `remember` key for state with two lifetimes, in the fire sheet:** the sheet holds form state
  that belongs to a runbook AT A REVISION (the values, the target, the preview) and operation state
  that belongs to the SHEET (whether a fire is in flight). Keying them the same way is wrong in
  whichever direction it is uniform, and two rounds proved it by going both ways. Round one keyed
  everything on the runbook id, so a revision landing while the sheet was open left the owner filling
  a form for a body that had changed underneath them. Round two keyed everything on the edition,
  which fixed the form and broke the fire: a revision arriving mid-fire rebuilt `firing` as false and
  offered Fire again with the first still in flight. Each is now keyed to its own lifetime. The
  structural version is a single sheet state object holding both, so the two cannot be keyed
  together, and Phase 4's editor will want exactly that shape for its own longer-lived form.

**A runbook id is the owner's, not a gateway's.** The library keys by id alone, so the newest copy of
an id wins wherever it came from, and firing at a gateway holding an older one pushes the library's
over it. That is the sync Question 1 asked for, and it is only sound because the phone authors every
runbook, which makes the id space the phone's. Two gateways cannot legitimately hold different
runbooks under one id once Phase 4 mints them here. Until then the library is filled from gateways,
so the ids are theirs, and the guard is the preview: it renders what would actually be sent, from
the gateway it would be sent to, before Fire is offered.

**The library is a cache in this phase, and persistence waits for Phase 4.** Nothing on the phone
authors a runbook yet, so everything the tab shows came from a gateway and `refresh` refills it. A
gateway that cannot be reached leaves the tab empty, which is honest rather than lossy. The moment
the editor exists the library holds work no gateway has and has to survive a restart, which is what
`RunbookManager` was built for. It reads and writes its own blob through `AppStateStore`, the way
the board and the vault do, rather than through `ChatPersistence`, which codes repository state.

## Phase 4 - The editor ✅

Name, body, and the derived parameter list with its nested options. The largest interface piece, and
last because everything else is provable without it.

**`RunbookManager` holds the library, beside `RunbookOps`.** The split its durable siblings use:
`BoardManager` and `VaultManager` own their blob and its persistence while an ops class owns the
gateway calls. It takes a `RunbookStore`, which `AppStateStore` implements, and it is in
`clearedOnReprovision` with them. Its key is on both wipe rosters, and both residue tests pin it. It writes before it publishes, so a refused write leaves the owner
the library they still have, and `clearInMemory` is the one exception, since a re-provision takes
the previous owner's writing out of memory whether or not the disk cooperates.

**Ids are opaque and random, minted by `newRunbookId`.** The library keys by id alone, which is only
sound while one id means one runbook. A name-derived or counter-derived id would break that the
first time two phones author independently.

**The parameter list is derived, and settings are keyed by placeholder name.** `RunbookDraft` holds
name, body, and a settings map; `declared` reads the body through `RunbookGrammar`, the recognition
twin of the gateway's parse, pinned to it by a shared vector corpus. A deleted placeholder keeps its
settings while editing and is pruned by `toRunbook`. `refusal()` carries every rule the gateway
would refuse on, so Save is never offered for a runbook that would be rejected.

**A refused push is a conflict, not an outage.** `ConsoleRunbookPutResult` answers both a reason and
the revision held. `conflictsAfterPut` keeps both per runbook, `standingConflict` withdraws the
offer once the draft has passed that revision, the fire sheet shows the reason where it used to say
"This Gateway did not answer", and the editor offers Overwrite, which rebases the draft onto the
held revision.

**Save answers the editor.** `RunbookOps.save` pushes before it returns. Stored, and the library
takes it and the editor closes. Refused, and the library is untouched and the editor stays open with
the conflict. Unreachable, and the copy is local, which is what a phone-owned library means with no
Gateway listening. `keep` decides that last part by whether the library actually took the candidate,
so a save the merge would drop is a conflict rather than a silence.

### Found in passing

**Back did not close the editor.** It renders last, over everything, but the one `BackHandler` did
not know about it, so Back fell through to whatever was underneath.

**The emulator variant had not compiled since the board moved to the Router.** `SandboxFixtures`
still built a `BoardBlob(gateways = ...)` of `GatewayBoard`, a shape that no longer exists, so no UI
phase could be looked at. The fixture now maps its `BoardEntry` list into stored entries with an
unopenable envelope plus the cached text beside it, which is the road `renderBoard` already takes
when a device cannot open a title.

**A foreground resume threw before a Domain existed.** `RepositoryFocusHost.onForeground` asked
`repo.ownerOps.domainId() != null`, and `ownerOps` throws exactly when there is no Domain, so the
question could never be answered no. It now asks `ownerOpsOrNull()`. Every other `ownerOps` call
site signs an op, where the throw is the right answer.

**The sandbox still cannot show a screen, for a third reason.** Seeding runs, then `connect()`
reaches a signing path with no confirmed Domain and the state resets to unprovisioned, leaving the
onboarding screen. Deciding what the sandbox should do about Domain confirmation is scaffolding
work, not this feature's, so the runbook screens were verified by their rules and the compiler
rather than by eye.

**Two residue rosters did not pin `runbooks`.** `SCHEMA_WIPE_KEYS` and `PROVISIONING_KEYS` both hold
the key, but `SchemaMigrationWipeTest` and `ClearProvisioningPartitionTest` did not, so dropping it
from either roster would have gone unnoticed.

**A refused push carried half of what it needs.** `ConsoleRunbookPutResult` has answered both a
reason and the held revision since Phase 1; the phone kept only the reason, in a field nothing read.
Now `conflictsAfterPut` keeps both per runbook, the fire sheet shows the reason where it used to say
"This Gateway did not answer", and the editor offers Overwrite, which rebases the draft onto the
held revision so the next save wins. `standingConflict` is the guard: below the draft's revision the
offer is withdrawn, because rebasing backwards would mint a revision the library's merge discards.

### Bug Classes

**Revision arithmetic is split across four owners, and three rounds moved it around rather than
settling it.** The mechanism: `RunbookEditor` snapshots a revision, `RunbookOps.save` decides what
to mint, `RunbookManager.merge` decides what wins, and the gateway's put refuses at or below what it
holds. No one of them owns the rule, so a change to any one of them shifts which side loses.

- Round 1, align-fix: `standingConflict` withdraws the rebase offer once the draft passes the held
  revision, because rebasing backwards mints a revision `merge` would discard.
- Round 2, red-team-fix: `save` lifts above whatever the library holds, because a stale draft was
  otherwise discarded in silence with the editor closing as if it had saved. The blocking road in
  was Overwrite, but any draft that goes stale loses the same way, so guarding Overwrite would have
  fixed the instance and left the class.
- Round 3, re-audit of round 2: that lift lets a stale draft outrank and replace a newer copy from
  another phone, which round 2 introduced. Round 2 is still the better trade, because losing the
  save the owner is watching is the common case and needs one phone, while the new loss needs two
  phones and a gateway switch mid-edit.

**The shape chosen: the save answers the editor.** Four shapes were weighed. The arithmetic is not
the defect; it is where the defect keeps surfacing. `RunbookOps.save` writes locally and returns
nothing, and the editor closes on the spot, so a refusal has nowhere to land and the rounds above
were each choosing which side loses in silence.

Save becomes a suspending call that pushes before it answers. Stored, and the library takes it and
the editor closes. Refused, and the library is left alone and the editor stays open with the
conflict card already built. Unreachable, and the save is local and the editor closes, which is
what a phone-owned library means when no Gateway is listening. The lift in `save` goes away
entirely: it exists only to beat a library that moved underneath the draft, and a library can only
move while a Gateway is reachable, which is exactly when a stale candidate is now refused before it
can land.

Costs Kotlin only. No wire field, no fixture corpus, and `RunbookConflict`, `conflictsAfterPut`,
`standingConflict` and the Overwrite card are all reused. Its weakness is that Save now depends on
the Gateway to be sure, which the offline road answers by saying plainly that the copy is local.

Built. `put` is now the one push both `save` and `sync` take, so the two cannot drift about what a
refusal means.

Base-carrying compare-and-swap is the honest second step if two phones authoring at once ever stops
being rare. It was not chosen now because it adds two wire fields, a `RunbookContent` type and a
fixture corpus to fix a window that needs two phones editing one runbook at the same moment. The
shared authority module and content-addressed identity were both larger still, and neither closes
the silent part, which is the part that actually bit three times.

A test asserting round 2's old behavior through `save` was asserting the bug, and now says what each
road means.

**A durable in-flight marker cannot tell a crash from a fire in flight.** `durableOpStore`'s own
test names the contract: a restored in-flight record means re-execute, not replay. The fire guard
read the record instead and answered "this runbook is already firing", so a Gateway that died
mid-fire wedged that op until the record expired. The process now keeps its own set of fires it
started, and the durable record no longer stands in for one. The re-audit found the other end of
the same seam: `markComplete` returns without writing while the migration fence is up, so releasing
the key on a fenced success would let a retry deliver twice. The key is released only once the
store confirms the completion is on disk.

**Published before persisted.** `RunbookManager.commit` set the in-memory library, then wrote, then
swallowed the failure, so a refused write left the phone showing a library that a restart would
undo. It writes first now and keeps what the owner still has when the write refuses. `clearInMemory`
is the deliberate exception, since a re-provision must take the previous owner's writing out of
memory whether or not the disk cooperates.

### Declined

**Always-expanded parameter cards.** The design says "expandable to a label, a Text/Choice segment";
the cards open out from their placeholder title into exactly those fields, with no collapse. Runbooks
carry one to three parameters, and collapsing hides the only fields worth opening the editor for.

**`ChatState.runbooks` as a second copy.** It is a projection, which is how every ops class feeds
Compose. `RunbookManager` stays authoritative.

**A second lifetime holder for the editor.** `RunbookDraft` is the draft model the phase asked for.
There is no async save to hold, and the one piece of editor-lifetime state, the pending option text,
is already keyed by its parameter.

**A conflict raised while the editor is open.** Only a preview or a fire pushes, both of which live
in the fire sheet, and a modal sheet cannot be open behind the editor. The conflict is set before
the editor opens and read once at composition, so an observable holder would buy nothing.

**Unbounded retention for fired op ids.** The 256-op and 14-day eviction is `durableOpStore`'s
contract for every value op, and a retry of a fortnight-old id is not a thing the phone does. The
alternative is the unbounded growth the store exists to prevent.

**Quarantining a poisoned gateway snapshot.** `openDurable` already quarantines and rebuilds, and
the phone republishes its copy on the next sync.

**Decoding the library on the construction thread.** `BoardManager` and `VaultManager` read their
blobs the same way at the same moment. A runbook library is a handful of records; changing this one
alone would leave three siblings disagreeing about when their state exists.

### The answered save, after red team

**A refusal was read from shared state after a suspend point.** `save` re-read `conflicts` to build
its answer, which a concurrent `sync` could have cleared between the push and the read.
`conflictOfRefusal` is the one reading of a refusal now, and both roads take it.

**A save the Gateway took but the disk refused reported the wrong thing.** `synced` was recorded
before the library confirmed, and a failed write came back as "This phone holds a newer copy", which
is the opposite of true. `keep` answers what the library holds afterwards, `synced` is recorded only
once it confirms, and `localConflict` tells an outranked save apart from one that could not be
written.

**Sandbox seeding deleted the last session's work.** Seeding writes the fixture library straight
into the store before the repository exists, which the board already does for the same reason. It
now writes only into an empty store.

**Two claimed blockers were wrong, and checking cost less than believing.** `toRunbook` mints
`revision + 1`, so Overwrite does advance past the held revision. And the gateway's `put` returns
`stored: false` rather than throwing, so `resultOf` decodes it and a refusal reaches the phone as an
answer, not as a swallowed exception.

Both wrong answers came from a real weakness rather than carelessness. The first missed the `+ 1`
because it lives in `RunbookDraft` while the rest of the arithmetic lives in `RunbookOps`, which is
the split recorded above, seen from the outside. The second assumed a refused put sets `ok: false`,
because nothing in `OwnerOpAnswer` distinguishes "the op failed" from "the op answered no". That one
is every value op's shape, not this feature's, and is worth knowing before reading one again.

### Left for the owner to weigh

**The suite is red in its default parallel run, and was before this work.**
`federation-harness-boot.test.ts`, "converges to one presence row per team when a session reattaches
after a gateway restart", fails in the full run and passes three for three alone. It also fails with
this feature's whole working tree stashed, and the entire suite passes with `--no-file-parallelism`.
It is a timing flake in presence convergence rather than a regression, but it fails often enough now
that `bun run test` no longer answers reliably.

**A save cancelled mid-flight can leave the Gateway holding what the phone does not.** Back or
Cancel while Save is going cancels the composition scope, so the put may land after the local write
was abandoned. The next `refresh` adopts it back, so it heals, and holding the save open past the
editor's own lifetime would need a repository-scoped coroutine.

**A local save closes the editor without saying it is local.** The library is phone-owned and `sync`
pushes before any preview or fire, so a Gateway copy is a cache rather than the save. Saying so on
every offline save would be noise on the common path.

**`awaitRegister` cannot hear a registration that already happened.** `WakeCoordinator.waitFor`
records a future waiter only, so a session that registers before `createSession` resolves is missed
and the fire answers `fired: false` while the target is listening. `consoleSessionLifecycle` waits
the same way, so this is shared session machinery rather than the fire's own, and a fix belongs in
the coordinator where every caller gets it.

**The harness coalesces two answers to one op id.** Firing the same op id twice concurrently, both
promises read the refusal, though exactly one delivery lands. The delivery count is what the test
asserts. Worth knowing before writing another test that expects two distinct answers.

## Settled, and what settled it

- **What a fire does when the gateway is offline, or the session never registers.** Answered by the
  owner: "nothing new. just don't fire." The gateway being off fails like any other console op, and
  a session that never registers is left running and reported rather than closed or delivered into
  blind. Nothing was built for either.

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

- **Relaying an audit through a small model to Codex drops roughly a quarter of them.** The cycle
  prescribes a Haiku agent that passes a prompt verbatim to `codexStartAgent` and echoes the answer
  back. Three of eleven relays this plan returned conversational filler instead of the report, one
  of them literally "I'm ready for the next task", after the Codex agent had done the work. Each
  loss is a whole audit angle: the untrusted-value angle of the fire's red team and the duplication
  angle of its architecture pass both vanished that way, and the second had to be judged by hand.
  Calling `codexStartAgent` directly went four for four in the same session, so the relay is the
  failure and not the model behind it. Strengthening the relay's instruction helped and did not
  cure it. Where the fan-out does not need to keep tool output out of the caller's context, calling
  Codex directly is simply more reliable.

  Settled by the owner: relay through Sonnet instead. Nine of nine relays landed after the switch,
  against eight of eleven before it, and the reports came back better calibrated as well as
  complete. The relay is worth keeping for what it is for, which is holding a fan-out's output out
  of the caller's context; it just cannot be run on the cheapest model available.

- **`routes.send` answers success for a message it only queued.** A fire reports that it landed, and
  the route it went through returns `{status: "running"}` whether a session socket took the body or
  the delivery coordinator merely accepted it for later. Nothing in the return value separates the
  two, so establishing what "fired" actually promises meant reading the route's own source down to
  the `deliveries.accept` branch. That is the correct behaviour and it is invisible from the call
  site, which is the expensive combination: every caller has to rediscover it.

- **Adding a console op is still nine edits, now confirmed twice.** The runbook fire paid the same
  bill the store's three ops paid, and the preview paid it a third time in the same phase. Nothing
  new to say beyond the entry above, except that a checklist that recurs three times inside one
  feature is not an unlucky feature.

- **`kotlin-gate.sh` runs its import check before the compiler, so a real error arrives as a
  cosmetic one.** Refactoring the fire sheet dropped a `val scope = rememberCoroutineScope()` while
  leaving `scope.launch` behind. The gate answered `1 unused import(s) across 423 files`, naming
  `rememberCoroutineScope`, and stopped. It never reached the compile that would have said
  `Unresolved reference 'scope'`. Reasoning backwards from a lint message to a missing declaration
  is a minute of confusion every time, and the ordering guarantees it: any error that also orphans
  an import is reported as the orphan. Compiling first would cost nothing.

- **One missing Kotlin import reported as twelve errors, none of them at the import.** Omitting
  `import ...proto.Runbook` made `FireSheetState`'s constructor parameter unresolved, so every
  `by mutableStateOf` in the class failed to infer, and those surfaced as
  `Property delegate must have a 'getValue(...)' method` at lines far below, plus three phantom
  errors in an unrelated `FilterChip`. The actual cause was the fifth error in the list. Kotlin's
  inference cascade means reading the error list top-down sends you to the wrong file region, and
  the habit that works is scanning for `Unresolved reference` first and ignoring everything else.

- **`ChatState` says nothing about which of its sixty fields survive a restart.** Adding `runbooks`
  meant opening `ChatPersistence.kt` to find out there is no generic mechanism: each persisted field
  has hand-rolled JSON and its own save call, and a field that is not there simply is not persisted.
  Nothing in `ChatState` distinguishes `drafts`, which survives, from `wakingTeams`, which does not,
  except a comment on the latter. A new field is persistent or not by whether someone remembered,
  and the failure is silent in the direction that loses data. This was harmless here, since the
  runbook library is deliberately a cache until Phase 4, but it was harmless by luck rather than by
  the type saying so.

- **The emulator variant had rotted in three layers, and nothing noticed any of them.** It exists so
  a screen can be looked at without a Gateway, which is the recorded complaint against the vault, and
  it was the one build that could not run. `kotlin-gate.sh` builds only debug, so
  `compileEmulatorKotlin` is in no gate. Layer one: `SandboxFixtures.kt` still built
  `BoardBlob(gateways = ...)` of `GatewayBoard`, a shape the board's move to Router-held sealed
  entries deleted. Rewritten here against stored entries plus the cached text `renderBoard` already
  falls back to. Layer two: `RepositoryFocusHost.onForeground` asked `repo.ownerOps.domainId()`,
  which throws when there is no Domain, so the app died on resume. Layer three, still open: seeding
  runs, then `connect()` reaches a signing path with no confirmed Domain and the state resets to
  unprovisioned, leaving the onboarding screen. Deciding what the sandbox should do about Domain
  confirmation is scaffolding work rather than a feature's, so Phase 4's screens were verified by
  their rules and the compiler rather than by eye. Adding `compileEmulatorKotlin` to the gate is
  still the cheap half, and would have caught layer one on the commit that caused it.

- **A throwing accessor sits two lines from its guarded twin, and nothing in the name says which is
  which.** `ChatRepository.ownerOps` errors with "Domain not yet confirmed by a local session";
  `ownerOpsOrNull` answers null. Every other call site signs an op, where throwing is right, but
  `onForeground` used the throwing one inside `if (... .domainId() != null)`, a question it could
  therefore never answer no. The shape is worth knowing: an `orNull` twin beside a throwing accessor
  reads as a convenience rather than as the one to reach for in a test.

- **`OwnerOpAnswer.ok` conflates "the op failed" with "the op answered no".** A refused
  `runbook_put` comes back `ok: true` with `stored: false`, and `resultOf` throws only on `ok: false`.
  Nothing in either name says so, and a red-team pass traced `resultOf`'s throw and reported a
  confident blocker claiming every Gateway refusal was being swallowed as an outage. Checking cost
  less than believing, but the trap is there for every value op and for every reader after this one.

- **A second load-sensitive flake, this one in Kotlin.** `PlaybackOpsTest > enqueueOrderSurvivesPause`
  failed twice while the machine was busy, once as `NoSuchElementException` and once as
  `AssertionError`, both at the same line. Two different exceptions from one line across runs is the
  tell: it is a timing assumption, not a broken assertion. It passed three consecutive times under
  `--rerun-tasks` once the machine was quiet. It cost a real detour, because a Kotlin test failing
  right after adding a Kotlin file reads as cause and effect, and ruling that out meant moving the
  new files aside and back. Same shape as the federation harness flake above, and the same cost:
  the expensive part is not the rerun, it is disbelieving a red gate.

- **The federation harness flake now fails the default run more often than it passes.**
  `federation-harness-boot.test.ts`, the case `converges to one presence row per team when a session
  reattaches after a gateway restart`. It began as one failure in five full runs, then one in three,
  then two consecutively under load, and by the end of this plan it failed the plain `bun run test`
  repeatedly on a quiet machine. Three facts pin it down: it passes three for three alone, it fails
  with this whole feature's working tree stashed, and the entire suite passes with
  `--no-file-parallelism`. So it is a timing assumption that loses to concurrency rather than a
  regression, and `bun run test` no longer answers reliably without that flag. Already recorded in
  `plans/claimed-backlog.md`, and now the thing that makes a green gate cost two runs to believe.

- **A value op's answer is coalesced per op id, which is invisible until a test needs two.** Firing
  the same op id twice concurrently through the harness, both promises resolved to the same answer,
  the refusal, even though exactly one delivery landed. The test that proves the guard therefore has
  to assert on the delivery count rather than on the pair of answers. Worth knowing before writing
  another test that expects two distinct results from one op id.

## Settled inside a phase

**A pushed body is already sealed.** Settled in Phase 1, against the premise it was written on. The
open question said a console op's request is not content-sealed the way a vault value is, so the
Router relays it in the clear. That is false: the phone seals the whole `ConsoleOp` under the
`op.payload` AAD before it leaves the device, on both runtimes, and the gateway opens it after the
Router has relayed the envelope. A `runbook_put` body therefore crosses sealed like every other op,
and needs nothing of its own.
