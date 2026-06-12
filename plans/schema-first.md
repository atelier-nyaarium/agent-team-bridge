# Schema-first: protocol codegen, STTS descriptors, cross-repo contracts

Schema-first wins across STTS and the Switchboard x Nyaaskills x Evie-bot
seams, informed by the 2026-06-12 nyaadot architecture analysis (one schema
primitive describing data, settings, and functions; registries that describe
themselves; "the schema lives with whoever owns the truth"). This plan absorbs
and supersedes cleanup-framework.md Phase 5 (which was a constants-only stub);
cleanup-framework keeps its structural phases (1a/1b/2/3/4).

**Run-to-completion rule:** once greenlit, all phases run in one cycle to
completion. Checkpoint notices report per phase; do not park between phases
awaiting approval. Only a true blocker critical-stops. (Plans in this repo are
proposals until greenlit; after greenlight they are not pausable milestones.)

## Questionaire

**1. TS-Kotlin protocol single-source mechanism?**
Custom zod -> Kotlin generator (recommended option taken). ~small bun script
walks the zod schemas via `z.toJSONSchema()` (zod 4.4.3, native), emits
kotlinx-serialization data classes + sealed classes (discriminated unions map
naturally) + constants, committed artifact with a regenerate-and-diff drift
check. Golden fixture contract tests verify the generator itself. Rejected:
quicktype (fumbles discriminated unions - the protocol is unions everywhere),
fixtures-only (drift caught after the fact, dual-edit bug class survives).
User: "Sounds good. And use Evie as your reference to this. It already has
utility code that converts Zod to others." Reference located:
`evie-bot/app/actions/actionSchemaToTool.ts` (z.toJSONSchema + post-walk
cleanup) and `evie-bot/app/features/StructuredAIClient/utils.ts:104`.

**2. STTS descriptor truth - involve the service owner?**
No. User: "I rather not. We will maintain it our side and not bother him with
that. Schema up what you know from those API endpoints and reverse
engineering." The reverse-engineered knowledge (verified live 2026-06-12,
documented in plans/stts-play.md and SttsClient.kt:96-106) becomes our
maintained descriptor data. No endpoint ask, no handoff spec.

**3. STTS descriptor distribution?**
Bundled in the APK. User's update taxonomy, confirmed: "we update our schemas
if shapes change, grow lists if more Voices are added, and update provisioning
if new provider keys are obtained." Three lanes: wire-shape changes = edit the
descriptor data file (ships with next APK; in-app updater makes that cheap);
voice growth = grow the catalog lists in the same file; credentials = the
provisioning blob, which stays credentials-only. Rejected: arbiter-served
descriptors (new protocol surface for a low-frequency update), provisioning
blob carrying descriptors (violates blob-is-credentials-only).

**4. Plan placement vs cleanup-framework.md?**
This new plan absorbs cleanup's Phase 5; cleanup-framework keeps phases
1a/1b/2/3/4 with Phase 5 replaced by a pointer here. User addition: the plan
must state it "shouldn't stop mid plan" - captured as the run-to-completion
rule above. (Historical note: cleanup-framework never started; it was
delivered as a proposal awaiting greenlight by design, not interrupted.)

**5b. Amendments (user, pre-refinement):**
- Rename `tiny` -> `title` (user: "you may rename it from `tiny` to a better
  name lol. I just called it `tiny`"). `title` aligns the whole chain: tool
  param -> wire -> mailbox entry `{title, summary, body}` -> notification-bar
  title. Its description must say: 1 short sentence or phrase, the
  notification-bar headline - NOT a long-winded sentence. Arbiter accepts
  both `tiny` and `title` during transition (additive tolerance; old plugins
  send `tiny`).
- Minor-bump every touched repo on each phase that touches it (switchboard
  plugin + APK, nyaaskills, evie-bot).
- Cleanup of shipped plan docs: done immediately (plans/done/ archive), not a
  phase.

**5. Cross-repo contract sharing (evie frames, notice tiers)?**
Synced schema modules, manual for now. User: "Sorta. For now, manual
`cp`/`rsync` shared/ to update them. Comment on top saying to MUST
`rsync`/`cp` onto the other projects where necessary." Switchboard owns the
truth files; evie-bot and nyaaskills carry committed copies headed by a
MUST-sync comment naming the source path and the exact cp command. No sync
script, no CI staleness check yet (explicitly deferred).

## Phase 1: codegen pipeline (the framework primitive)

The one component every later phase consumes. Kills the dual-edit bug class:
this session's `title`/`summary` mailbox fields were hand-added in both
phone-protocol.ts and PhoneClient.kt; NOTICE_SESSION_PREFIX is a
comment-pinned mirror (phone-protocol.ts:141-145 -> ChatRepository.kt).

- `scripts/codegen-kotlin.ts` (bun): imports the zod schemas from
  `src/shared/`, converts via `z.toJSONSchema()` (reference: evie's
  actionSchemaToTool.ts conversion + cleanup walk), walks the JSON Schema, and
  emits one Kotlin file per schema group into
  `android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/`:
  - `data class` per object schema, `@Serializable`, defaults from zod
    defaults, nullable from `.optional()`/`.nullable()`.
  - `sealed class` per `z.discriminatedUnion`, `@SerialName(kind)` per member
    (PhoneOpSchema, op results, mailbox entry kinds).
  - `object Protocol { const val ... }` for constants: NOTICE_SESSION_PREFIX,
    op kind strings, PHONE_PROTOCOL_VERSION.
  - Every file headed `// generated from src/shared/<file>.ts - DO NOT EDIT.
    Regenerate: bun scripts/codegen-kotlin.ts`.
- Android adopts kotlinx-serialization: plugin + runtime in
  libs.versions.toml / build.gradle.kts. org.json stays for not-yet-migrated
  code; new generated types parse via `Json { ignoreUnknownKeys = true }`
  (strip-unknown = the forward-compat posture, same as zod `.strip()` and the
  nyaadot doctrine).
- First covered schemas: phone protocol (relay frame, the five ops, op
  results, mailbox entry), the provisioning blob (today optString hand-parse
  in PhoneClient.kt Provisioning), and the constants above.
- Drift check: regenerate + `git diff --exit-code` in a minimal `ci.yml` (bun
  lint + test + drift check) - absorbed from old cleanup Phase 5. Android CI
  (`_build-android.yml`) already builds; add `:app:testDebugUnitTest` before
  assemble if cleanup 1a has not already done so (whichever phase lands first
  wires the junit test classpath; the other reuses it).
- Golden fixtures: `tests/fixtures/protocol/*.json` consumed by BOTH vitest
  (zod .parse green) and Android unit tests (generated types decode green,
  re-encode round-trips). This verifies the generator's semantics, not just
  compilation. Include a deliberate unknown-extra-field fixture (must pass:
  tolerance bar) and a missing-required fixture (must fail both sides).
- Verification: skew one constant + one field locally, confirm drift check and
  fixture tests fail; full `bun run test` + `testDebugUnitTest`.
- Interplay with cleanup 1a (MailboxCodec): independent, either order. If 1a
  lands first, MailboxCodec swaps its hand types for generated ones here; if
  this lands first, 1a builds the codec around generated types from day one.
  Generated types are the nouns; the codec keeps the verbs (teamForEntry
  grammar, persistence round-trip).

## Phase 2: parse-don't-validate at every boundary

- Phone wire (Kotlin): PhoneClient's hand optString parsing of mailbox
  entries, team lists, register results, and Provisioning is replaced by the
  generated types. `MailboxEntry`, `Provisioning` data classes die in favor of
  proto/ equivalents. Behavior-identical lap on the emulator afterward.
- Evie WS frames (TS): new `src/shared/evie-protocol.ts` - a
  `z.discriminatedUnion` over every frame the arbiter exchanges with evie's
  BridgeServer (tool registry, tool call result, dm_forward, phone_relay,
  phone_relay_reply, auth/hello if present - enumerate from evieClient.ts and
  evie's BridgeServer during implementation). Today evieClient.ts:78-84 does
  `JSON.parse` + `as`-casts with zero validation; every inbound frame gets
  boundary-parsed with structured errors logged (and a counter, not a crash -
  the bridge must survive an unknown frame kind from a newer evie: log + drop).
- Route sweep: audit routes.ts and websocket.ts for remaining unvalidated
  `req.json()` / `as` reads; schemas.ts already covers reply/parts/files/relay
  (7 parse sites today). Anything inbound that crosses a process boundary gets
  a schema. Internal call shapes between modules do NOT (that is type-checked
  TS, not a trust boundary).
- Verification: existing 160+ TS tests stay green; new tests per frame kind
  (valid, unknown-kind drop, malformed reject); arbiter smoke against live
  evie.

## Phase 3: STTS provider descriptors as data

Converts SttsClient.kt's compiled-in provider database (enum :29-38 + wire
shapes :107-130 baking default voices, engines, region eastus, language) into
bundled data validated by schema on both sides. Adding/changing a provider
becomes a data edit, not two compile-forced code edits; a removed provider
disables loudly instead of silently falling back to Azure
(ChatRepository.kt:196).

- `src/shared/stts-providers.ts`: zod `SttsProviderSchema` - the shape of one
  descriptor: `{ id, label, path, hasSample, container: "mp3"|"wav-stream",
  request: <template object>, defaults: { voice, ... }, voices: [ { id,
  label? } ], voiceHint }`. Request templates use `$text` / `$voice`
  placeholder substitution; the verified shapes (including ElevenLabs'
  nesting and Uberduck's `speech`/`voicemodel_uuid`) all express as one
  template grammar. The container field makes the MP3-vs-mislabeled-WAV
  knowledge data instead of a doc comment.
- The descriptor data: `android/app/src/main/assets/stts-providers.json`,
  seeded with the 8 known providers (6 verified live, ElevenLabs keyless,
  Uberduck unverified - carried with empty voices and a note field). Voice
  catalogs seeded from the verified defaults; grown by editing this file
  (user lane 2).
- CI validation: a vitest test parses the asset file with SttsProviderSchema -
  the data file is schema-checked on every push even though it ships in the
  APK. Kotlin descriptor data class comes from the Phase 1 generator.
- SttsClient rewrite: Provider enum and `requestBody()` die. The client takes
  a descriptor: builds the URL from `path`, substitutes the template, streams
  to file. Zero per-provider branches. Engine code (timeouts, auth header,
  health) stays.
- Repository/UI: provider selection persists by descriptor id; voice pref
  becomes per-provider (`stts_voice.<id>`); unknown persisted id = Play
  disabled + settings row explains, never a silent substitute. Settings
  picker lists descriptors from the asset; voice field offers the catalog as
  suggestions while staying free-text (catalogs are curated, not exhaustive).
  Cache key already carries provider+voice; provider component switches from
  enum path to descriptor id.
- Riders: delete the stale "shapes NOT yet confirmed" header comment
  (SttsClient.kt:21-24, contradicts :96-106); de-duplicate the `"stts"`
  cache-dir literal (ChatRepository.kt:581 reaches into SttsPlayer's layout -
  give SttsPlayer a `purgeAll()`); note the health gate is service-wide by
  design (no per-provider probe exists).
- Verification: fixture-server lap (descriptor-driven request bodies
  byte-match the verified shapes for all 8), emulator lap (picker from data,
  per-provider voice persistence, unknown-id disable), one live Azure sample.

## Phase 4: notice contract + cross-repo sync

- `src/shared/notice.ts`: `NoticeSchema` `{ title, summary, full }` with the
  tier semantics as `.describe()` text ON the fields (the parameter-describe
  doctrine: rules about what goes in a field live on the field). `title`
  replaces `tiny` (questionaire 5b): its describe states "1 short sentence or
  phrase - the notification-bar headline. Not a long-winded sentence."
  notify_human and the arbiter's `/human/notify` route both import it; the
  route accepts legacy `tiny` as an alias during transition. The mailbox
  entry `{title, summary, body}` now matches the wire name end to end.
- Sync copies, manual per the questionaire: `notice.ts` ->
  nyaaskills (cycleCheckpoint currently re-declares tiny/summary/full
  independently at cycleCheckpoint.ts:40-62 - its zod fields become imports of
  the synced copy); `evie-protocol.ts` -> evie-bot (BridgeServer composes and
  parses frames through it). Every copy headed:
  `// SYNCED COPY - source of truth: switchboard/src/shared/<file>.ts`
  `// MUST re-copy on change: cp <src> <dest> (see switchboard CLAUDE.md)`.
- CLAUDE.md notes in all three repos: list which files are synced copies,
  which direction, and the copy command. (No sync script, no CI staleness
  check - explicitly deferred by the questionaire.)
- Verification: nyaaskills cycle lap composing a notice through the synced
  schema; evie deploy + arbiter smoke (DM forward, tool call, phone relay all
  boundary-validated end to end); a phone notice round trip.

## Considered and dropped (recorded so we do not re-litigate)

- Runtime schema registries / overlays / shadow semantics (nyaadot's core):
  wrong fit - no third-party mod ecosystem here; the consumers are three repos
  we own. Synced files + codegen reach the same single-truth guarantee at a
  fraction of the machinery.
- Schema-generated settings UI (SchemaForm-style): the Android settings
  surface is one screen; descriptors driving the picker is as far as the win
  goes.
- Invokable-style introspection for crosstalk teams: evie's tool registry +
  z.fromJSONSchema dynamic registration already IS the nyaadot invokable
  mirror for the one seam that needs it; no second consumer exists.
- STTS descriptor discovery endpoint: rejected in questionaire (we own the
  truth, no friend dependency).

### Notes for implementers

- Phase order is load-bearing: 1 -> 2 -> 3 -> 4 (2 and 3 consume the
  generator; 4 syncs schemas that 2 creates).
- Deploy shape: P1 app + CI only. P2 arbiter rebuild + app. P3 app only.
  P4 nyaaskills plugin bump + evie CI deploy + arbiter rebuild (full
  cross-repo ritual; evie deploys via push-to-main CI).
- Keep the phone protocol additive throughout; the 3.9.0 tolerance bar from
  the notify cycle applies. Generated Kotlin parses with ignoreUnknownKeys so
  old apps tolerate new fields and new apps tolerate old arbiters.
- Versions: MINOR bump every repo a phase touches, all three version spots
  per the deploy doctrine (plugin.json + package.json + McpServer version for
  the plugins). Switchboard bumps on P1/P2/P3/P4; nyaaskills and evie-bot
  bump on P4.
- Emulator harness: `source ~/android-dev/env.sh`, AVD phone35,
  `wm size 720x1600` + `density 280`, reset after.
- cleanup-framework.md interplay: 1a/1b can run before, after, or interleaved
  with this plan; the only shared resource is the Android test classpath
  (first lander wires it) and MailboxCodec consuming generated types
  (whichever lands second adapts, both adaptations specified in Phase 1).
