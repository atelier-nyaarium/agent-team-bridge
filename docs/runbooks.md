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
  quietly dropping the guarantee. A completion on disk replays; a fire this process started is held
  in memory and refuses a second attempt; anything else runs, so a gateway that died mid-fire can be
  retried rather than wedged. The memory is released only once the completion is durable.
- A fire may name the revision it previewed. One that has moved on is refused rather than sending
  words the owner never read.

A fired body leaves the same `sent` row a typed one does, so it is in the owner's history.

## The phone

The phone is every runbook's sole author. `RunbookManager` owns the library and its persistence, the
way `BoardManager` and `VaultManager` own theirs, and it is cleared on re-provision with them.
`RunbookOps` owns the gateway calls; `pushDecision` beside it is the sync rule.

The Runbooks tab lists the library with Fire on each row.

The fire sheet takes the values, where it lands, and shows a preview before Fire. That preview is
`runbook_preview`, rendered by the gateway rather than on the phone, so there is one implementation
of the grammar and nothing to keep two of them honest. An edit marks the shown text stale and Fire
waits, so the sheet never offers to send something it is not showing.

## The editor

`RunbookDraft` is what the editor holds: a name, a body, and settings keyed by placeholder name.

- The parameter list is derived. `RunbookGrammar.kt` is a Kotlin twin of `placeholdersOf`, pinned to
  the TypeScript by `tests/fixtures/runbook-grammar/vectors.json`. It recognises names and renders
  nothing, because a render must be the gateway's own for a preview to match what a fire sends.
- Deleting a placeholder orphans its settings rather than dropping them, so pasting it back restores
  them. `toRunbook` prunes the orphans, which is the only place they stop being remembered.
- `RunbookDraft.refusal` carries every rule `runbookRefusal` would refuse on, so Save is never
  offered for a runbook the gateway will reject.

## A refused push

The phone being sole author does not make two phones impossible, so a Gateway refuses a put at or
below the revision it holds and answers both a reason and that revision.

`RunbookOps.save` pushes before it answers. Stored, and the library takes it and the editor closes.
Refused, and the library is untouched and the editor stays open with the reason and an Overwrite
action that rebases the draft onto the held revision, so the next save wins. Unreachable, and the
copy is local, which is what a phone-owned library means with no Gateway listening; the next preview
or fire pushes it.

`standingConflict` withdraws the offer once the draft has passed that revision, since rebasing
backwards would mint a revision the library's merge discards.
