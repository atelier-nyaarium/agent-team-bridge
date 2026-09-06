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

## Phase 1 - The record and the store

The wire shape of a runbook and its parameters, in `shared/`: an id, a name, a body, and a list of
`{ name, label, kind, default, options }` where kind is `text` or `choice`. A durable store on the
gateway beside `vault-decisions` and `vault-helper`. Console ops to list, put and delete, phone to
gateway. Kotlin codegen and the gate. No interface yet.

Caps belong here, since nothing downstream can add them: the body, the rendered message, the
parameter count, and the options per parameter.

## Phase 2 - The fire

One gateway op taking a runbook id, the values, and where it lands. It renders, refusing and naming
the parameter when a value is missing rather than shipping a raw placeholder as instruction. A fresh
target creates the session, waits for it to register, then delivers; an existing session target
delivers straight away. Idempotent through the `op-idempotency` store already there, so a retry
cannot fire twice.

## Phase 3 - The tab and the fire sheet

The Runbooks tab, the row with Fire, and the bottom sheet: values, target, preview, Fire. The phone
pushes a runbook the gateway does not have, or has at an older version, before firing it.

## Phase 4 - The editor

Name, body, and the derived parameter list with its nested options. The largest interface piece, and
last because everything else is provable without it.

## Open, to settle inside the phases

- What a fire does when the gateway is offline, or the session never registers.
- Whether a pushed body should be sealed. A console op's request is not content-sealed the way a
  vault value is, so the Router relays it in the clear. Today the Router is on the same machine.
