# Runbooks

A runbook is a message the owner sends often, with blanks. The body is prose they wrote, the blanks
are `{{name}}` placeholders, and firing one fills them in and delivers the result to an agent's
session as a message from the owner.

They exist because a message worth sending twice is worth not retyping, and because a body can carry
rules as well as steps. "Never hand-edit a version" belongs in the release runbook, since the agent
reading it may not go looking for `AGENTS.md`.

## Where a runbook lives

Per gateway, on the machine that will run it. The phone holds the library and pushes a copy to a
gateway that is missing it or holds an older one, which happens automatically before a fire.

Nothing about a runbook is capped. A record is refused for what it means, never for its size.

## The grammar

`src/shared/runbook-grammar.ts` owns it, and everything that reads a body derives from `parseBody`.

- `{{name}}` is the only placeholder. A `{{` that opens no placeholder is refused, so text merely
  shaped like one is a parse decision rather than a guard beside a scan. A lone `}}` stays literal,
  since prose about JSON closes nested braces.
- A body's placeholders **are** its parameter list. `runbookRefusal` in `src/shared/schemasRunbook.ts`
  refuses either without the other, so no stored runbook carries a blank nothing can fill or a
  parameter nothing uses.
- `renderRunbook` substitutes once, then parses its own output. A value and the literals around it
  can each be innocent and still compose a placeholder only after substitution, which no check on
  the body alone can see.

A parameter is `text` or `choice`. A choice must offer at least one option, and a filled value may
not open a placeholder of its own.

## The gateway

`src/gateway/runbooks/store.ts` holds them durably beside the vault's stores. It is the only writer,
so a stored record has passed the rules, and restore keeps whatever the schema accepts rather than
discarding the owner's work.

The phone owns the revision. A higher one replaces, a lower one is refused and told what to rebase
on, and an equal one is a retry when the content matches and a refusal when it does not. That last
case is what stops a second device silently overwriting the first.

Five console ops, all owner-authenticated: `runbook_list`, `runbook_put`, `runbook_delete`,
`runbook_preview` and `runbook_fire`.

## Firing

`src/gateway/console/consoleRunbookFire.ts` renders and delivers. `textOf` is the one road from an
id and values to text, so a preview cannot answer something a fire would not send.

- A fresh target creates the session, waits for it to register, then delivers. Launch and delivery
  share no ordering, so a session that never starts listening is left running and reported rather
  than closed or delivered into blind.
- An existing session target delivers straight away, through the same route a typed message takes.
  A session between sockets has the message queued, exactly as a typed one would be.
- A fire happens once per operation, guarded by the gateway's `op-idempotency` store. Value ops are
  not deduplicated upstream, so a gateway without that store refuses to fire at all rather than
  quietly dropping the guarantee.
- A fire may name the revision it previewed. One that has moved on is refused rather than sending
  words the owner never read.

A fired body leaves the same `sent` row a typed one does, so it is in the owner's history.

## The phone

The Runbooks tab lists the library with Fire on each row. `RunbookOps` owns the library and the
gateway calls; `pushDecision` beside it is the sync rule.

The fire sheet takes the values, where it lands, and shows a preview before Fire. That preview is
`runbook_preview`, rendered by the gateway rather than on the phone, so there is one implementation
of the grammar and nothing to keep two of them honest. An edit marks the shown text stale and Fire
waits, so the sheet never offers to send something it is not showing.
