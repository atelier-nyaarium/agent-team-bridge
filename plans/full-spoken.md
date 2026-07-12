# fullSpoken (the spoken copy of full)

TTS quality feature, second slice. The first slice (shipped to the working tree, uncommitted, per
owner's "no commit" hold): title/summary/full describes unified onto the notice leaf as canonical
texts, title/summary rewritten ear-first (spoken language only, no lazy-join run-ons, no all-caps
shouting, the "hypothesis 1" example), full rewritten with no speech framing. This plan adds the
new field and retires the on-device sanitizer.

## Questionaire

**Context (owner's complaint list, live TTS incidents):** the console TTS speaks text as-is; code
snippets and identifiers (hyp-01) are unintelligible, ALL-CAPS excitement ("FOUND IT!") reads as
an acronym, dash lazy-joins produce run-on sentences, heteronyms mispronounce ("resume" the noun
vs resume the verb). Pipeline facts: synthesis is the external VRCSTT service (IBM/OpenAI/xAI),
plain text only, no SSML on any provider - pronunciation markup is off the table without touching
that service. summary/title were spoken raw; full is spoken through `SttsPlayer.sanitize` (code
fences -> "Code block omitted", links -> label, markdown chars stripped).

**1. Where should speakability live?** Title/summary: description-only (shipped, uncommitted).
Full: "we do something else entirely and retire the sanitizer" - this plan.

**2. What is the new field?** `fullSpoken`, owner-named for clarity over my `spoken` suggestion:
"It's a spoken copy of Full, rather than a standalone field. It must faithfully match the full
body word for word, except where it chooses to abridge (code blocks, long code snippets, etc)."
Rules mirror summary's ear-first set, plus mandatory lowercase excitement: full may carry "YAY!",
fullSpoken writes "Yay!".

**3. Required or optional?** Required on every reply ("Full for now. We can talk about Extended
Options later." - the opt-out/fallback refinements are deferred, not designed in). Owner: "no
need to worry about legacy handling or back compat. I'll restart your plugin as soon as we ship."
The trivial coalesce (`fullSpoken` else `summary` else `title`) stays in the player as the absent
default because it is one line and an old message's Play button should not go silent, but no
migration machinery of any kind.

**4. The cross-gateway relay gap?** A - extend the relay to carry all tiers. Owner: "We finally
get to fixing that gap now." CORRECTED BY AUDIT: the pain-points entry this was based on is
STALE - `response_push` already carries title/summary today (fixed in f38b04c the same day the
entry was written, never corrected). So the relay work here is ADDING `fullSpoken` alongside the
existing tier fields, plus regression coverage pinning the existing behavior; the stale
pain-points entry gets corrected on ship.

## Plan

### Design

**The field.** `fullSpoken`, REQUIRED on `channel_reply` and `notify_human`, canonical describe
on the notice leaf (`NoticeFullSpoken`) inherited verbatim by both tools like its three siblings,
newline guidance appended identically. Contract in the describe: a spoken copy of `full`,
faithful word for word except deliberate abridgements (a code block becomes a short spoken
mention of what it is); summary's ear-first rule set (spoken language only, no code/symbols/raw
identifiers, words as you would say them, no lazy-join run-on sentences, one clause per short
sentence); PLUS lowercase excitement - `full` may shout "YAY!", `fullSpoken` writes "Yay!".
Exact describe text drafted during refinement and run by the owner.

**Wire path (TS).** The `/respond` payload and the `/human/notify` body carry `fullSpoken`;
`MailboxEntry` gains the field (schemas.ts, additive, codegen to Kotlin); the gateway routes
stamp it through to the mailbox exactly like `summary`. STRICTNESS RULE (audit): `fullSpoken` is
REQUIRED only on the two tool-call schemas (`ChannelReplySchema`, `NotifyHumanSchema` - both
`.strict()`); at EVERY wire layer below it is `z.string().optional()`, mirroring title/summary.
That includes the gateway-side `HumanNotifySchema` (routes.ts), which is `.strict()` with
required-everything today - `fullSpoken` deliberately deviates to optional there, preserving the
graceful mixed-version window that `/respond`'s lenient schema already has (a vitest pins that a
missing fullSpoken is still accepted).

Three relay/mirror surfaces gain the optional field (the plugin-actions recipe: MailboxEntry AND
the federated entry schemas in the same commit):
- `response_push` (federation-protocol.ts) - ADDS `fullSpoken` beside the title/summary it
  already carries; `routes.ts` respond() composes it, `gatewayRelay.ts` forwards it.
- `console_push`'s inline entry schema (federation-protocol.ts) - without this, a multi-Gateway
  Domain's notices and peer-mirror rows lose the field permanently at the relay hop (non-strict
  zod strips unknown keys silently).
- `mirrorPeer`'s payload + its two reply-mirror call sites (routes.ts) - peer-mirrored REPLIES
  already carry title/summary today (the plan's earlier "peer mirrors carry no tiers" claim was
  wrong for replies), so they carry `fullSpoken` too; peer-mirrored ASKS have no tiers ever and
  fall to the tierless-speech rule below.

**Console path (Kotlin).** Regenerated `MailboxEntry`; `Message` model + thread persistence gain
`fullSpoken`; `SttsPlayer.ttsText(Tier.FULL)` becomes a BLANK-SAFE coalesce (red team:
`fullSpoken?.takeIf { it.isNotBlank() } ?: ...` - Kotlin's `?:` is null-only, so a blank string
landed by a raw HTTP caller would otherwise resolve to silence and defeat the fallback chain;
blank summary has the same pre-existing class, so the whole chain goes blank-safe).
`sanitize()` has THREE call sites (audit): the FULL branch plus the SUMMARY and TITLE branches'
terminal `sanitize(m.text)` fallbacks. All three retire together. TIERLESS-SPEECH RULE - OWNER
DECISION NEEDED (red team falsified the original premise): rows with no tiers are NOT all short
plain prose - peer-mirrored crosstalk ASKS (`mirrorPeer` with `{body, files}` only) are by
contract full markdown briefs, often multi-KB with code fences, and peer rows DO participate in
autoplay. Speaking raw `m.text` there would read verbatim markdown aloud where today's
sanitize() at least strips fences. RECOMMENDATION: retire sanitize() for TIERED rows as planned,
but keep a minimal light pass (fence-strip + link-label only) for TIERLESS rows. User rows and
short peer prose are unaffected either way. `ttsTextFramed`'s peer framing keeps wrapping
whatever the tier resolves to. The existing `TtsTextFramedTest` cases update to pin these
decisions. Audio cache keying is already per (team, at, tier, provider, voice) and needs no
change; stale FULL-tier audio cached before ship replays old speech for old messages, accepted
per the no-back-compat ruling. PHASE-1-TO-PHASE-2 TEXT LOSS (red team): the deployed APK's
drain maps only title/summary onto `Message`, so a message received between the fleet reload
and the APK install permanently loses its wire-carried fullSpoken TEXT (not just cached audio) -
its FULL tier speaks the summary forever after. Ship order within Phase 2: install the APK
BEFORE the fleet reload to close this window.

**Tool + fleet rollout.** Both tool schemas are `.strict()`, so the new required field lands with
a plugin bump and the owner restarts/reloads the fleet on ship (owner-stated). ROLLOUT ORDER
(red team, corrected): the gateway container rebuild comes BEFORE the plugin fleet reload, and
this order is LOAD-BEARING, not belt-and-suspenders - the currently-deployed gateway's
`HumanNotifySchema` is `.strict()` WITHOUT fullSpoken, so a new plugin's every `notify_human`
400s against it (notices lost outright) until the container rebuilds. Sharper still: the
marketplace's `autoUpdate: true` means the 400 window opens at the VERSION-BUMP PUSH (any
routine session restart auto-updates that session's plugin), not at a deliberate fleet reload.
So the ship sequence is: commit + push the code WITHOUT the plugin.json bump, rebuild the
gateway container, THEN push the version bump and reload the fleet - the marketplace only offers
an update once plugin.json bumps, which fully closes the window. The escaped-newline
lint's two hardcoded field lists (`postReply`'s loop in replyTool.ts and notify_human's own loop
in humanTools.ts) gain `fullSpoken` so the ear-first field is actually lint-enforced like its
siblings, with a vitest pinning the rejection. `skills/crosstalk/SKILL.md`'s prose contract for
channel_reply updates to name the new required field. The uncommitted working-tree describe
unification (title/summary/full canonical texts) ships in this plan's first commit.

**Cross-plugin follow-through (nyaaskills).** `cycleCheckpoint` builds a notifyHuman payload of
{title, summary, full} and its relay instruction tells the calling agent to relay those verbatim
to `channel_reply`/`notify_human` - after this ship the relaying agent must ALSO author
`fullSpoken`. nyaaskills' `notify.ts` payload and the relayInstruction text gain the field (its
own repo + its own plugin bump, riding its next deploy); until that lands, agents relaying
checkpoint payloads author `fullSpoken` themselves at relay time, which the schema forces anyway.

**Plans cleanup (rides this plan).** `host-daemon-cleanup.md` retires: phases 1-4 shipped; fold
its painpoints into `pain-points.md` and its parked items into `features-and-fixes.md`, then
delete. `websocket-stt.md` stays (live knowledge doc, explicitly do-not-implement-yet).
`gateway-auth-surface.md` and `plugin-pipeline-hardening.md` stay (active, unshipped). On this
plan's own ship, the reply-tool-redesign pain-point entry about the dropped tiers is updated to
note the relay fix.

## Phase 1 - schemas, tools, gateway, relay

The notice leaf gains `NoticeFullSpoken` (+ sync to nyaaskills); both tool schemas require the
field; the MCP handlers post it; the newline-lint field lists gain it; `MailboxEntry` + codegen;
gateway `/respond` and `/human/notify` stamp it through (gateway-side optional per the strictness
rule); `response_push`, `console_push`'s entry schema, and `mirrorPeer` all carry it;
`skills/crosstalk/SKILL.md` prose updates. Vitest coverage: tool-level rejection when absent
(strict schemas), a missing-fullSpoken-still-accepted case on the gateway notify route, the
newline-lint rejection on the new field, payload mapping, mailbox stamping, and cross-gateway
fan-out tests proving the tiers survive BOTH `response_push` and `console_push` (regression
coverage for the existing title/summary behavior plus the new field). The uncommitted describe
work and the plans cleanup commit here. The stale pain-points relay entry corrects here too.

## Phase 2 - console speech switch

Regenerated protocol, `Message` model + persistence, `ttsText` switch to
`fullSpoken ?: summary ?: title`, sanitizer retirement, `ttsTextFramed` review. Android unit
tests + R8 gate. Bump + deploy plugin and APK; owner restarts the fleet.

### Notes

- After ship: retire this plan per convention; update the pain-points relay entry; mark the TTS
  arc in `features-and-fixes.md` if listed.
- Red-team residual (record at crust, no code change): `consolePeer.ts`'s `response_push` branch
  hand-picks `{session_id, body, status, files}` and drops all three spoken tiers. Verified
  UNREACHABLE for reply delivery today (console jobs key `fromConversationId` to the owner id,
  whose mailbox branch in `respond()` carries the tiers; the ConsolePeer sits in
  `conversationRegistry` under the per-device id), but it silently strips tiers if any future
  change routes a console-bound reply through the registry fallback. Either extend
  `ResponsePushPayload` + the mapping, or delete the dead branch.
