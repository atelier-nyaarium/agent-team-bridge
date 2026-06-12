# Schema-first: protocol codegen, STTS descriptors, cross-repo contracts

Schema-first wins across STTS and the Switchboard x Nyaaskills x Evie-bot
seams, informed by the 2026-06-12 nyaadot architecture analysis (one schema
primitive describing data, settings, and functions; registries that describe
themselves; "the schema lives with whoever owns the truth"). This plan absorbs
and supersedes cleanup-framework.md Phase 5 (which was a constants-only stub);
cleanup-framework keeps its structural phases (1a/1b/2/3/4). Refined lap 1 by
a six-auditor fan-out that verified every claim against all three codebases,
including live zod 4.4.3 experiments on the repo's actual schemas.

**Run-to-completion rule:** once greenlit, all phases run in one cycle to
completion. Checkpoint notices report per phase; do not park between phases
awaiting approval. Only a true blocker critical-stops. (Plans in this repo are
proposals until greenlit; after greenlight they are not pausable milestones.)

## Questionaire

**1. TS-Kotlin protocol single-source mechanism?**
Custom zod -> Kotlin generator (recommended option taken). ~small bun script
walks the zod schemas via `z.toJSONSchema()` (zod 4.4.3, native), emits
kotlinx-serialization data classes + sealed classes + constants, committed
artifact with a regenerate-and-diff drift check. Golden fixture contract tests
verify the generator itself. Rejected: quicktype (fumbles discriminated
unions), fixtures-only (drift caught after the fact, dual-edit bug class
survives). User: "Sounds good. And use Evie as your reference to this. It
already has utility code that converts Zod to others." Reference located:
`evie-bot/app/actions/actionSchemaToTool.ts` (z.toJSONSchema + post-walk
cleanup) and `evie-bot/app/features/StructuredAIClient/utils.ts:104`.

**2. STTS descriptor truth - involve the service owner?**
No. User: "I rather not. We will maintain it our side and not bother him with
that. Schema up what you know from those API endpoints and reverse
engineering." The reverse-engineered knowledge (verified live 2026-06-12,
documented in plans/done/stts-play.md and SttsClient.kt:96-106) becomes our
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
  name lol. I just called it `tiny`"). `title` aligns the tool param with the
  mailbox entry's `title` field and the notification-bar title. Its
  description must say: 1 short sentence or phrase, the notification-bar
  headline - NOT a long-winded sentence. Transition aliases on BOTH the tool
  and the route (see Phase 4).
- Minor-bump every touched repo on each phase that touches it.
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

**1.0 Author the missing zod truth (prerequisite, found by audit).** The only
phone zod schemas today are PhoneOpSchema + PhoneRelayFrameSchema
(schemas.ts:139-173) and ChannelFileSchema (:121-129). Everything else the
generator must cover is plain TS interfaces or Kotlin-only knowledge:

- Author zod schemas in src/shared/ for: `PhoneRelayReply`
  (phone-protocol.ts:79-86), the five op results (:91-123), `MailboxEntry`
  (:156-177), `TeamInfo` (types.ts:112-118, transitively required by
  PhoneListTeamsResult), and a NEW `ProvisioningSchema` (the blob has no
  TS-side shape anywhere; reverse-engineer from Provisioning.parse,
  PhoneClient.kt:39-54).
- Collapse the TS-internal mirror: derive the existing interfaces via
  `z.infer` from the new schemas so phone-protocol.ts interfaces and
  schemas.ts cannot drift (one truth file; otherwise codegen creates a THIRD
  copy).
- Provisioning runtime behavior stays app-side: `device` defaulting to
  `Build.MODEL`, `conversationId` minting a UUID, and `trimEnd('/')` URL
  normalization (PhoneClient.kt:42, 49-51) cannot live in a schema. The
  generated type carries the shape; a thin Kotlin wrapper keeps those
  defaults.
- Constants (PHONE_PROTOCOL_VERSION phone-protocol.ts:11,
  NOTICE_SESSION_PREFIX :145, op kind strings) are imported by the generator
  script directly as values - they do not go through toJSONSchema.

**1.1 The generator.** `scripts/codegen-kotlin.ts` (bun): imports the zod
schemas from `src/shared/`, converts via
`z.toJSONSchema(schema, { io: "input", reused: "ref" })`, walks the cleaned
JSON Schema, and emits Kotlin into
`android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/` (verified
conflict-free: hand classes live flat in the root package; coexistence holds
until Phase 2 deletes the hand types).

- **io: "input" is load-bearing** (verified): default output mode THROWS on
  `.transform()` (PostResponsePartSchema), keeps `.default()`ed fields in
  `required`, and stamps `additionalProperties: false`. Input mode matches
  wire-decode semantics, drops transforms, and makes defaulted fields
  optional. `.refine()` constraints are silently dropped in both modes -
  intentionally; they are parse-side only.
- **Discriminator recovery** (verified): toJSONSchema emits a bare `oneOf`
  with per-member `const` kinds but NO discriminator keyword. The generator
  reads `schema._zod.def.discriminator` (present in 4.4.3) alongside the
  conversion. Each generated sealed class gets
  `@OptIn(ExperimentalSerializationApi::class)
  @JsonClassDiscriminator("<key>")` - per-class, because future unions use
  different keys (PhoneOp uses `kind`, evie frames use `type`).
- **Sealed classes apply to ENCODE-side unions only**: PhoneOpSchema (the
  phone only encodes ops, closure is safe) and Phase 2's evie frame union.
  Op results generate as five independent data classes - they carry no wire
  discriminator (PhoneOpResult is a plain union correlated by opId,
  phone-protocol.ts:125-130) and adding one is a wire change the additive
  rule forbids. MailboxEntry generates as ONE data class with
  `kind: String` - a sealed class throws on unknown discriminator VALUES
  even with ignoreUnknownKeys, breaking forward compat when a future entry
  kind ships. Rule: never emit closed Kotlin enums or sealed hierarchies for
  fields the phone DECODES; decode-side enums stay open strings.
- **Naming + dedup** (verified): default conversion inlines shared
  sub-schemas at every use site (ChannelFilesSchema expands twice inside
  PhoneOpSchema). Every shared/exported schema gets `.meta({ id: "..." })` -
  the id IS the Kotlin class name - and `reused: "ref"` dedupes into named
  `$defs` entries; the generator emits one data class per $defs entry plus
  the root.
- **Type-mapping table**: JSON Schema `integer` -> `Long` by default (at/seq
  /cursor are epoch-ms and monotonic counters; Int overflows), `Int` only
  under explicit fitting bounds; `z.record`/`z.unknown`/free-form JSON ->
  `kotlinx.serialization.json.JsonObject`/`JsonElement` (needed by
  replyAsJson, phone-protocol.ts:170, and Phase 3's request templates);
  optional -> nullable `= null` default.
- The zod -> JSON Schema leg follows evie's battle-hardened conversion
  hygiene, not raw output. Reference chain in evie-bot:
  `app/actions/actionSchemaToTool.ts` (the core: `z.toJSONSchema()` then
  strip `$schema`, recursive walk removing `format` validators downstream
  consumers do not support), `app/features/StructuredAIClient/utils.ts:
  adapterToTool` (same pass), `app/features/bridge/exportToolSchemas.ts`
  (deep-clone + strip internal fields from `properties`/`required`). Lift
  that into a shared `zodToCleanJsonSchema()` step; the Kotlin emitter
  consumes only cleaned schemas. (Switchboard already runs the reverse leg
  via `z.fromJSONSchema()` in mcp/evie/evieTools.ts - the round trip is
  proven in production across this exact pair of repos.)

**1.2 Android serialization stack.** kotlinx-serialization on Kotlin 2.0.21 +
AGP 8.7.3 (libs.versions.toml:2-3):

- `[plugins] kotlin-serialization = { id =
  "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }` -
  the plugin is a compiler plugin locked to the Kotlin version.
- `[libraries] kotlinx-serialization-json = { group =
  "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version =
  "1.7.3" }` - PINNED: 1.8.x+ is built against Kotlin 2.1+ and pulls a
  mismatched stdlib transitively. Bump only together with a Kotlin upgrade.
- Decode via `Json { ignoreUnknownKeys = true }` (strip-unknown = the
  forward-compat posture, same as zod plain-object strip).
- org.json stays for not-yet-migrated code and for MailboxCodec persistence
  (see interplay below).

**1.3 Fixtures + CI.**

- Golden fixtures: `tests/fixtures/protocol/*.json` (repo root; verified no
  collision - .gitignore covers only _test/ and temp/, vitest has no config
  and default-globs src/__tests__ where a test fs-reads the fixtures
  relative to repo-root cwd).
- Android access needs explicit wiring (the Gradle root is android/, so
  repo-root tests/ is outside the project): create `app/src/test/java`, add
  junit + kotlinx-serialization-json to the test classpath, and
  `sourceSets["test"].resources.srcDir("../../tests/fixtures")` in
  app/build.gradle.kts so fixtures load from the classpath regardless of CI
  working dir. Cross-reference cleanup 1a's test-infra block
  (cleanup-framework.md:33-40) - the real-org.json-jar mandate there applies
  to 1a's codec tests, not these serialization fixtures; whichever phase
  lands first wires junit, the other reuses it.
- Fixture set must include: every op kind, a mailbox entry per kind
  (message/reply/notice incl. title+summary), an unknown-extra-field fixture
  (must PASS both sides - tolerance bar), a missing-required fixture (must
  FAIL both sides), and an `at` value above 2^31 (fails any Int mapping).
- New `ci.yml` (none exists; main-push.yml fires only on android/** paths,
  so TS edits run zero CI today): checkout + `oven-sh/setup-bun@v2` + bun
  install + `bun run lint` + `bun run test` + drift check
  (`bun scripts/codegen-kotlin.ts && git diff --exit-code`). No Android
  SDK/JDK needed - regeneration writes text. Trigger: push to main, ALL
  paths (not android-scoped like main-push.yml); post-merge gating accepted,
  consistent with cleanup 1a's stance; add pull_request later if pre-merge
  gating is wanted.

**1.4 Verification.** Skew one constant + one field locally, confirm drift
check and fixture tests fail; full `bun run test` + `testDebugUnitTest`.

**Interplay with cleanup 1a (MailboxCodec) - one explicit end-state, agreed
by both plans:** wire entry decode = generated kotlinx serializers (owned by
this plan; PhoneClient/codec call `Json.decodeFromString`). MailboxCodec
keeps `Message <-> JSONObject` persistence (org.json, its own legacy-compat
rules) and the grammar verbs (`teamForEntry`). Either plan may land first: if
1a lands first its hand decode swaps to generated serializers here; if this
lands first, 1a builds the codec around generated types from day one.
Generated types are the nouns; the codec keeps the verbs.

## Phase 2: parse-don't-validate at every boundary

- Phone wire (Kotlin): replace ALL of PhoneClient's hand parsing with
  generated types - the audit's full site list: mailbox entries + team lists
  + register results (PhoneClient.kt:69-96, 213-238), the PhoneRelayReply
  envelope unwrap repeated at every call site (:153, :158, :200-207, :222 -
  becomes ONE generated decode), Provisioning field-mapping (:39-54; the
  thin wrapper from Phase 1.0 keeps runtime defaults), and `RawFile` dies in
  favor of generated ChannelFile (Attachments.decode signature adapts).
  Decision folded in: the `SendResult.inlineBody` path
  (PhoneClient.kt:71/200-207 -> ChatRepository.kt:356) reads a `response`
  field the arbiter has never sent (phoneHandler.ts:26-27 documents
  channelOnly sends never produce an inline body; :293 returns only
  {session_id, status}) - DELETE it as dead code after a git-history sanity
  check during implementation.
- OUT of scope, explicitly: on-disk thread persistence
  (persistThreads/loadPersistedThreads, ChatRepository.kt:630-694). It is a
  LOCAL format with its own legacy rules (id reassignment, opId demotes),
  owned by cleanup-1a's MailboxCodec - not a wire boundary.
- Evie WS frames (TS): new `src/shared/evie-protocol.ts`, written
  SELF-CONTAINED (it owns the frame-level schemas including ChannelFileSchema
  and the PhoneRelayFrame member; existing shared siblings import FROM it -
  a leaf-ward dependency so the Phase 4 copy needs no import surgery).
  Audit-corrected frame vocabulary:
  - Inbound union (discriminated on `type`): `tool_registry`, `tool_result`
    (callId: string), `tool_error` (callId: `z.string().nullable()` -
    BridgeTransport legitimately sends callId: null on invalid JSON and
    malformed envelopes, BridgeTransport.ts:149/:156-163; a naive
    string-typed schema would drop real frames), `dm_forward`, `phone_relay`.
  - Outbound: a `ToolCallFrame` schema ({type:"tool_call", callId, action,
    params}, evieClient.ts:154-161).
  - `phone_relay_reply` is NOT a frame type - it travels as a tool_call and
    evie intercepts it by tool NAME (BridgeServer.ts:162-164). It gets a
    `PhoneRelayReplySchema` validating the PARAMS payload that relayPump.ts:
    30-36 composes, not a union member.
  - No auth/hello member: auth is an HTTP Bearer header at WS upgrade, and
    the de facto hello is the tool_registry push.
  - The phone_relay BODY stays opaque-but-typed in the envelope union; full
    validation remains relayPump's `PhoneRelayFrameSchema.safeParse`
    (relayPump.ts:25) - one parse, one error path, no divergent
    double-validation.
  - Honest delta: phone_relay and dm_forward files are ALREADY validated
    (relayPump; sanitizeInboundFiles index.ts:41-43). The genuinely
    unvalidated casts are tool_registry/tool_result/tool_error/dm_forward
    envelope (evieClient.ts:84-104). Unknown frame kinds already silently
    drop (if-chain, :83-109) - Phase 2's delta there is OBSERVABILITY
    (structured log + counter on unknown/malformed), not crash-proofing.
- Route sweep: audit routes.ts and websocket.ts for remaining unvalidated
  `req.json()` / `as` reads; schemas.ts already covers reply/parts/files/
  relay (7 parse sites today). Anything inbound that crosses a process
  boundary gets a schema; internal module call shapes do NOT (type-checked
  TS is not a trust boundary).
- Additive rule, pinned: "additive" means new OPTIONAL fields only (zod
  plain-object strip + kotlinx ignoreUnknownKeys both tolerate them). New op
  kinds and new enum values are NOT additive - they fail the closed
  discriminated union / closed enums (settling as ok:false replies via
  relayPump, not hangs) and are version-gated protocol changes requiring
  arbiter-first deploy. The generator must preserve plain-object strip
  semantics and keep decode-side strings open.
- Verification: existing 160+ TS tests stay green; new tests per frame kind
  (valid, unknown-kind drop, malformed reject, callId:null tool_error);
  emulator lap confirming behavior-identical phone parsing; arbiter smoke
  against live evie.

## Phase 3: STTS provider descriptors as data

Converts SttsClient.kt's compiled-in provider database (enum :29-38 + wire
shapes :107-130 baking default voices, engines, region eastus, language) into
bundled data validated by schema on both sides. Adding/changing a provider
becomes a data edit; a removed provider disables loudly instead of silently
falling back to Azure.

- `src/shared/stts-providers.ts`: zod `SttsProviderSchema` - one descriptor:
  `{ id, label, path, hasSample, container?: "mp3"|"wav-stream", request:
  <template JSON>, defaults: { voice, ... }, voices: [ { id, label? } ],
  voiceHint, note? }`. `container` is OPTIONAL: absent = unverified (the
  player sniffs regardless - neutral .audio extension + MediaPlayer); only
  the 6 live-verified providers carry it.
- **Template engine, pinned by audit:** the descriptor's `request` is parsed
  as a kotlinx `JsonElement` tree; a deep walk replaces only STRING
  primitives exactly equal to `"$text"` or `"$voice"` - whole-value
  equality, never substring interpolation. `$text` -> the synthesis text
  (JSON-encoded by the serializer, never string-spliced); `$voice` ->
  `userVoice.takeIf { isNotBlank } ?: descriptor.defaults.voice`. All other
  values pass through verbatim - that covers ElevenLabs' two-level nesting
  with JSON numbers (stability 0.5), Amazon/OpenAI literal engine strings,
  and Uberduck's renamed `speech` key.
- The descriptor data: `android/app/src/main/assets/stts-providers.json`,
  seeded with the 8 known providers (6 verified live; ElevenLabs keyless and
  Uberduck unverified ride with empty voices + a `note`). Voice catalogs
  seeded from the verified defaults; grown by editing this file (user lane
  2).
- **Descriptor ids = the legacy enum NAMES ("AZURE", "OPENAI", ...).** Zero
  migration: the provider pref already stores enum names
  (ChatRepository.kt:195-199, `value.name`). Unset/"" pref resolves to the
  pinned default descriptor AZURE (preserving today's behavior) - only a
  non-empty id absent from the catalog triggers the disable-loudly path.
  The legacy global `stts_voice` value seeds `stts_voice.<currentProviderId>`
  once on first load, then per-provider keys own it.
- **Context plumbing (audit):** ChatRepository's constructor takes no
  Context/AssetManager (ChatRepository.kt:117-121), and the notification
  play path goes straight to Repo.get without UI. `Repo.get`
  (MainActivity.kt:83-91) holds the application Context: it loads +
  schema-validates the asset ONCE and passes the parsed catalog (or
  app.assets) into the constructor; the repository exposes the catalog to
  both the settings picker (replacing the Provider.entries loop,
  MainActivity.kt:1043-1049) and the play paths.
- CI validation: a vitest test in src/__tests__ fs-reads the asset file and
  parses it with SttsProviderSchema - the data file is schema-checked on
  every push even though it ships in the APK. The Kotlin descriptor data
  class comes from the Phase 1 generator (free-form `request` maps to
  JsonObject per the type table).
- SttsClient rewrite: Provider enum and `requestBody()` die. The client
  takes a descriptor: builds the URL from `path`, runs the template walk,
  streams to file. Zero per-provider branches. Engine code (timeouts, auth
  header, health) stays.
- Cache: key switches enum path -> descriptor id; since ids equal enum
  names, existing cache entries actually survive. If an id ever changes,
  old entries are abandoned by design (cache is disposable, reclaimed only
  by forget/clearAll - acceptable, audio is bounded by message count).
- Settings UI: picker lists descriptors from the catalog; voice field
  offers the catalog as suggestions while staying free-text (catalogs are
  curated, not exhaustive).
- Riders: delete the stale "shapes NOT yet confirmed" header comment
  (SttsClient.kt:21-24, contradicts :96-106); de-duplicate the `"stts"`
  cache-dir literal (ChatRepository.kt:581 reaches into SttsPlayer's layout
  - give SttsPlayer a `purgeAll()`); note the health gate is service-wide by
  design (no per-provider probe exists).
- Verification: fixture-server lap (descriptor-driven request bodies
  byte-match the verified shapes for all 8), emulator lap (picker from
  data, per-provider voice persistence, unknown-id disable, legacy voice
  seed), one live Azure sample.

## Phase 4: notice contract + cross-repo sync

- `src/shared/notice.ts`: `NoticeSchema` `{ title, summary, full }` with
  tier semantics as `.describe()` text ON the fields (the parameter-describe
  doctrine). `title` replaces `tiny` (questionaire 5b); its describe states
  "1 short sentence or phrase - the notification-bar headline. Not a
  long-winded sentence." Scope, audit-corrected: NoticeSchema governs the
  TOOL PARAM and the `/human/notify` wire ONLY. The `title` tier aligns end
  to end (the tiny->title hop already exists in exactly one place,
  routes.ts:749); the third tier keeps its deliberate `full` -> mailbox
  `body` mapping (routes.ts:751, PhoneClient.kt:239 hard-reads `body`) - the
  mailbox field is NOT renamed (additive rule). The APK needs NO change for
  the rename: the entire Kotlin client already speaks title/summary/body.
- **Rename blast radius (audit-enumerated; or run `grep -rn tiny` in both
  repos):**
  - switchboard: humanTools.ts:43 (field), :87 (NOTIFY_DESCRIPTION prose),
    :212 (destructure), :229 (wire POST key); routes.ts:117
    (HumanNotifySchema), :730, :749; routes.test.ts:147-197 (several
    sites); CLAUDE.md:34 (already stale - says `{tiny, full?}` though
    summary/full are required; fix regardless).
  - nyaaskills: notify.ts:17-21, :40, :61, :83 (relayInstruction prose);
    cycleCheckpoint.ts:40-64 (tier fields; attachments follows at :65-72),
    :120 (description), :125 (destructure), :134-135, :145-146, :197-198
    (nextAction strings); run.ts:241 (checkpointCall instruction string);
    ~30 cycle.test.ts call sites.
- **Transition compat, both directions (audit):**
  - notify_human (plugin side) accepts `tiny` OR `title` for one transition
    minor (z.preprocess alias, `tiny` marked deprecated in describe) - the
    arbiter route alone is NOT enough, because old nyaaskills relay
    instructions tell agents to pass `tiny` into the tool, and reload_plugins
    does not reconnect the nyaaskills MCP (reloadPlugins.ts:145-158), so
    mixed plugin pairs occur in live sessions.
  - The new plugin SENDS both `tiny` and `title` keys for the transition
    minor, and the new arbiter route accepts either - so neither deploy
    order (arbiter-first or plugin-first) drops notices. Still, pin the
    order: arbiter rebuild BEFORE reload_plugins for this phase.
  - cycleCheckpoint likewise accepts legacy `tiny` via z.preprocess for one
    transition minor - agents mid-cycle hold pre-reload instruction text
    that names `tiny` literally.
  - Ride-along: add `/mcp reconnect` for the nyaaskills MCP to
    reloadPlugins.ts so plugin pairs flip together in future deploys.
- Sync copies, manual per the questionaire:
  - `notice.ts` -> `nyaaskills/src/shared/notice.ts` (NEW dir; the repo has
    only src/cycle/ + cycle-mcp.ts today). notice.ts is pinned as a LEAF
    module - zod-only imports, zero relative imports - so the verbatim copy
    sidesteps the import-extension mismatch (switchboard uses `.js`
    specifiers, nyaaskills uses `.ts`). nyaaskills consumes it via
    `NoticeSchema.extend({...})` with per-tool describe/max overrides where
    cycle semantics differ.
  - `evie-protocol.ts` -> `evie-bot/app/features/bridge/evie-protocol.ts`
    (replacing the hand-typed frame mirrors there). Self-contained leaf per
    Phase 2, so the copy needs no import surgery. Evie-side integration
    sites, audit-corrected: BridgeTransport (envelope parse +
    tool_registry/tool_result/tool_error compose, BridgeTransport.ts:
    136-182), BridgeServer.forwardDM (dm_forward, BridgeServer.ts:127),
    PhoneBridgeServer.handleRequest (phone_relay, PhoneBridgeServer.ts:
    146-153). The server-manager bridge shares BridgeTransport (second
    instance, :62-66) and adopts the same envelope schema by construction -
    intended.
  - Every copy headed:
    `// SYNCED COPY - source of truth: switchboard/src/shared/<file>.ts`
    `// MUST re-copy on change: cp <src> <dest> (see switchboard CLAUDE.md)`.
- CLAUDE.md notes in all three repos: which files are synced copies, which
  direction, the copy command.
- Verification: nyaaskills cycle lap composing a notice through the synced
  schema (and a legacy-keyed call passing the alias); evie deploy + arbiter
  smoke (DM forward, tool call, phone relay boundary-validated end to end);
  a phone notice round trip.

## Considered and dropped (recorded so we do not re-litigate)

- Runtime schema registries / overlays / shadow semantics (nyaadot's core):
  wrong fit - no third-party mod ecosystem here; the consumers are three
  repos we own. Synced files + codegen reach the same single-truth guarantee
  at a fraction of the machinery.
- Schema-generated settings UI (SchemaForm-style): the Android settings
  surface is one screen; descriptors driving the picker is as far as the win
  goes.
- Invokable-style introspection for crosstalk teams: evie's tool registry +
  z.fromJSONSchema dynamic registration already IS the nyaadot invokable
  mirror for the one seam that needs it; no second consumer exists.
- STTS descriptor discovery endpoint: rejected in questionaire (we own the
  truth, no friend dependency).
- Sealed mailbox-entry kinds / closed decode-side enums: rejected by audit -
  kotlinx throws on unknown discriminator values even with
  ignoreUnknownKeys; forward compat wins.

### Notes for implementers

- Phase order is load-bearing: 1 -> 2 -> 3 -> 4 (2 and 3 consume the
  generator; 4 syncs schemas that 2 creates).
- Deploy shape: P1 = app + CI only. P2 = arbiter rebuild + app. P3 = app
  only. P4 = switchboard plugin bump + push + ARBITER REBUILD FIRST + then
  reload_plugins + nyaaskills plugin bump + evie CI deploy.
- "app" defined: any android/** merge to main auto-builds and refreshes the
  single latest APK release (main-push.yml paths filter +
  _build-android.yml:59-84) - every Android-touching phase ships a release
  whether intended or not. Update the physical phone via the in-app updater
  when the phase changes phone behavior (P2/P3); emulator verification uses
  local :app:assembleDebug, not the release.
- Keep the phone protocol additive throughout; the 3.9.0 tolerance bar from
  the notify cycle applies. See Phase 2's pinned additive rule (optional
  fields only; new kinds/enum values are version-gated, arbiter-first).
- Versions, audit-corrected per repo: switchboard = TWO manual spots
  (plugin.json + package.json; src/mcp/index.ts:76 auto-derives McpServer
  version from package.json). nyaaskills = THREE spots (plugin.json,
  package.json, AND the hardcoded literal in src/cycle-mcp.ts:16-19).
  evie-bot = package.json only (no plugin.json; image tag is :latest; its
  McpServer reads pkg.version). MINOR bump each repo on every phase that
  touches it: switchboard P1/P2/P3/P4; nyaaskills + evie-bot on P4.
- Emulator harness: `source ~/android-dev/env.sh`, AVD phone35,
  `wm size 720x1600` + `density 280`, reset after.
- cleanup-framework.md interplay: 1a/1b can run before, after, or
  interleaved with this plan; the shared resources are the Android junit
  test classpath (first lander wires it) and the wire-decode stack
  resolution pinned in Phase 1's interplay block (kotlinx owns wire decode;
  MailboxCodec owns org.json persistence + grammar verbs). Both plans state
  the same end-state.
