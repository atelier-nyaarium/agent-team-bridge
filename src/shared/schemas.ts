import { z } from "zod";
import { DomainSnapshotSchema, SignedAdmissionSchema } from "./admission.js";
import { b64Field, slugField } from "./crypto.js";
import { SignedFirstRootSchema } from "./federation-lifecycle.js";
import { CrossDomainPresenceSessionSchema, SignedXDomainLinkSchema } from "./federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { NoticeFull, NoticeFullSpoken, NoticeSummary, NoticeTitle } from "./notice.js";
import { ADDRESS_SEP, isSlug } from "./session-id.js";

////////////////////////////////
//  Shared enum schemas
//
//  The single truth for the wire enums; types.ts derives from these via z.infer.
//  These closed enums validate what our side composes. Fields a console decodes
//  stay open strings.

export const ConnectionModeSchema = z.enum(["channel"]).meta({ id: "ConnectionMode" });
export const TeamKindSchema = z.enum(["devcontainer", "loose", "console"]).meta({ id: "TeamKind" });
export const ResponseStatusSchema = z
	.enum(["completed", "clarification", "deferred", "needs_human", "error", "timeout", "running"])
	.meta({ id: "ResponseStatus" });
// Whether a console's Domain is rooted yet. `unrooted` is a fresh, never-provisioned admin
// Domain; `pending` is an admin-staged tenant not yet first-rooted; `rooted` provisions the
// console. The gateway register reply only carries `rooted`/`unrooted` (a pending Domain has no
// gateway to register against); `pending` reaches the app via the blob's `pendingTenant`.
export const DomainStatusSchema = z.enum(["unrooted", "pending", "rooted"]).meta({ id: "DomainStatus" });

////////////////////////////////
//  Channel Reply Schemas
//
//  Channel-mode conversations are streams: the conversation stays open for the
//  life of the process and the agent can reply any number of times. There is no
//  status because there is no end. Two closed-shape tools, not one polymorphic
//  body: channel_reply is the ~99% prose path; channel_reply_structured is only
//  for a request that carries a reply_schema (e.g. the bridge handshake).

/** Appended to every prose-field describe whose content the console renders (channel_reply,
 * notify_human) - the cheap always-visible half of the escaped-newline guard; the pre-send lint
 * (`literalEscapeHazard` in mcp/bridge/replyTool.ts) is the enforcing half. The `\\n` spelling is
 * deliberate: the description must show the two-character sequence. */
export const REAL_NEWLINES_GUIDANCE = ` Use REAL newlines for line breaks, not \\n. Wrap intentional escapes in backticks or code spans.`;

/** The four notice tiers as the reply tools expose them: the leaf's canonical texts VERBATIM
 * with the newline guidance appended. Both tools (channel_reply here, notify_human in
 * mcp/channel/humanTools.ts) spread this SAME object, so their tier describes are identical
 * by construction, not by audit. */
export const GuidedNoticeTiers = {
	title: NoticeTitle.describe(`${NoticeTitle.description}${REAL_NEWLINES_GUIDANCE}`),
	summary: NoticeSummary.describe(`${NoticeSummary.description}${REAL_NEWLINES_GUIDANCE}`),
	full: NoticeFull.describe(`${NoticeFull.description}${REAL_NEWLINES_GUIDANCE}`),
	fullSpoken: NoticeFullSpoken.describe(`${NoticeFullSpoken.description}${REAL_NEWLINES_GUIDANCE}`),
};

export const ChannelReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		...GuidedNoticeTiers,
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach to this reply (e.g. screenshots, logs). Images render inline on the console; other files appear as download chips. A self-contained .html file whose FIRST line is a "<!-- @dsCard group=... -->" comment is a design canvas: the console's Designer dock (a toggleable plugin) collects such cards per conversation for full-screen review. Card identity is the filename (re-attach the same filename to update a canvas in place), so name cards distinctly, e.g. "editor-form.html".`,
			),
	})
	.strict();

export type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;

export const ChannelReplyStructuredSchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		responseData: z
			.record(z.string(), z.unknown())
			.describe(
				`Reply to a request that carried a reply_schema (e.g. the bridge handshake). A native object matching that schema.`,
			),
	})
	.strict();

export type ChannelReplyStructuredArgs = z.infer<typeof ChannelReplyStructuredSchema>;

////////////////////////////////
//  Channel File Schema (inbound from evie-bot bridge)
//
//  ChannelFile lives in channel-file.ts (zod-only, NOT a synced leaf - evie
//  never reads it); the blob constants stay in the evie-protocol leaf. Both
//  re-export here so the console-protocol schemas and existing importers keep
//  one import surface.

import { ChannelFilesSchema } from "./channel-file.js";
import { BLOB_CHUNK_BYTES } from "./evie-protocol.js";

/** `sha256-<64 hex>`. A blob is named by the digest of its own bytes and by nothing else. */
const BlobIdField = z.string().regex(/^sha256-[0-9a-f]{64}$/);

////////////////////////////////
//  Blob transfer ops
//
//  Bytes move here, in bounded chunks keyed by their own digest, rather than as a base64 field on a
//  message. `have` is the contiguous prefix the store holds, which is both the answer to "how much
//  got there" and the offset to resume from, so a retry needs no separate bookkeeping and a re-sent
//  chunk is a no-op.
//
//  Named rather than inlined into ConsoleOpSchema because these three ops have TWO doors: the sealed
//  console plane and the gateway's plain HTTP routes. `answerBlobOp` already made the handling
//  single; this makes the validation single too, so a bound cannot exist at one door and not the
//  other. The HTTP side previously trusted a bare cast, which was harmless only by accident.

/** Which Gateway holds the bytes, when it is not the one being asked. Absent means "you have them
 * or nobody does", which is every same-Gateway transfer. */
const FromGatewayField = z.string().min(1).max(64).optional();

export const BlobStatOpSchema = z.object({
	kind: z.literal("blob_stat"),
	blobId: BlobIdField,
	fromGateway: FromGatewayField,
});

export const BlobPutOpSchema = z.object({
	kind: z.literal("blob_put"),
	blobId: BlobIdField,
	offset: z.number().int().nonnegative(),
	// One chunk, base64'd. Bounded by BLOB_CHUNK_BYTES before encoding; the generous ceiling here is
	// the encoded form plus slack, not a second opinion on chunk size.
	chunk: z.string().max(BLOB_CHUNK_BYTES * 2),
	final: z.boolean(),
});

export const BlobGetOpSchema = z.object({
	kind: z.literal("blob_get"),
	blobId: BlobIdField,
	offset: z.number().int().nonnegative(),
	length: z.number().int().positive().max(BLOB_CHUNK_BYTES),
	fromGateway: FromGatewayField,
});

export { ChannelFileSchema, ChannelFilesSchema } from "./channel-file.js";

////////////////////////////////
//  Capability Schema
//
//  One capability a console or the host daemon has enabled. Declared above the
//  register schemas because both of them carry a list of these.

export const EnabledPluginSchema = z
	.object({
		// The manifest's own composite id: `<author>.<content_id>`, or a bare `<content_id>` when
		// authorless (first-party). Dotted, so this cannot reuse the dotless slug field.
		id: z
			.string()
			.min(1)
			.max(129)
			.refine((v) => v.split(".").every((seg) => /^[a-z0-9][a-z0-9-]*$/.test(seg)), "each segment must be a slug")
			.describe("The plugin's globally unique id, as its manifest declares it."),
		// A plugin's guidance is a whole section of an agent's instructions, not a sentence. The
		// first real one shipped at 2304 characters against an earlier 2000 cap, which the wire
		// then refused and the store discarded, so the capability vanished with no error anywhere.
		instructions: z
			.string()
			.max(16_000)
			.optional()
			.describe("Agent-facing usage guidance for this capability, surfaced to the session."),
	})
	.meta({ id: "EnabledPlugin" });

/** What one source says about the ids it alone owns. `known: false` is no opinion, which a consumer
 * must not read as an assertion that the source has nothing. */
export const CapabilitySnapshotSchema = z.object({
	known: z.boolean(),
	capabilities: z.array(EnabledPluginSchema),
	clientVersions: z.array(z.string()),
});

/**
 * What `/capabilities` serves: every source's answer, kept apart.
 *
 * Sections rather than one merged list, because a consumer deciding what to keep from its own last
 * answer has to ask whether the source that owns an id spoke this round. A flattened list cannot
 * answer that, and every attempt to work around it has silently dropped or resurrected a capability.
 *
 * Hand-named fields rather than a map: there are two sources, they are shaped differently, and a
 * third costs one field.
 */
export const CapabilityBundleSchema = z.object({
	console: CapabilitySnapshotSchema,
	daemon: CapabilitySnapshotSchema,
});

////////////////////////////////
//  WS Register Schema
//
//  Validates the register message at the bridge WebSocket boundary, the one
//  message where a blind-cast team name could key the registry on undefined.
//  mode stays an open string; the handler normalizes it (every connection is
//  channel mode).

export const WsRegisterSchema = z.object({
	type: z.literal("register"),
	// A bare slug (host, a devcontainer project, a loose hex name) or a composite `project.session`.
	// Shell-safe so a team name can never carry a metacharacter into the daemon's launch command.
	// A live registrant is a spawn-point (arity 1) or a chat (arity 2); each segment a dotless slug.
	team: z
		.string()
		.min(1)
		.max(129)
		.refine((t) => {
			const segs = t.split(ADDRESS_SEP);
			return segs.length <= 2 && segs.every(isSlug);
		}, "team must be a slug spawn-point or spawn.session"),
	mode: z.string().optional(),
	subId: z.string().optional(),
	conversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
	// The plugin version (package.json) the MCP process is running. Absent for
	// non-plugin registrants (e.g. the host daemon); the plugin always reports it.
	version: z.string().optional(),
	// The Claude Code harness session id, reported so the gateway can persist a
	// `team -> claudeSessionId` map and `claude --resume <id>` the session on a later wake.
	claudeSessionId: z.string().optional(),
	// The plugin's cwd basename, the default session label for a self-appearing (manually launched)
	// session. Bounded here; the store sanitizes and caps it to a single printable path segment.
	cwdName: z.string().max(256).optional(),
	// Shared secret the host daemon presents so a LAN peer cannot squat the reserved
	// "host" slot and drive agent terminals. Optional on the wire (only the host slot
	// sends it), but the host slot is fail-closed: a host register is refused unless the
	// gateway has HOST_WS_TOKEN set AND this token matches it.
	token: z.string().optional(),
	// The session's own binding secret, minted with its SessionRecord and delivered only through the
	// daemon's launch command. A registrant presenting the token bound to the name it claims is
	// BOUND (it owns that name and may take the remembered-lead fast path); one presenting nothing,
	// or a token for a different record, is UNBOUND and demoted - it may still operate its own
	// conversation but cannot claim a name that carries a binding. Never a rejection: a hand-launched
	// session has no token by design, and a purged DATA_DIR leaves every live session tokenless.
	sessionToken: z.string().max(256).optional(),
	// The registrant's remembered answer to a prior bridge handshake (see mcp/bridge/helpers.ts's
	// isMainOrLeadAgent cache) - true skips the handshake prompt entirely on this register. Never
	// sent as false (a worker that answered false is evicted and does not reconnect). A malformed
	// value degrades to absent (the normal handshake-prompt path) rather than failing the register.
	isMainOrLead: z.boolean().optional().catch(undefined),
	// The host daemon's own configuration, honoured only on the token-gated "host" slot. Complete
	// every time: present-but-empty affirms nothing enabled, absent leaves the last one standing.
	daemonCapabilities: z.array(EnabledPluginSchema).max(64).optional(),
	// Identifies the daemon PROCESS, not this connection. A reconnect changes which socket carries an
	// event, not which supervisor produced it, so a durable event fenced by this survives one.
	daemonInstanceId: z.string().max(64).optional(),
});

////////////////////////////////
//  Team Info Schema
//
//  The per-team record in list_teams results and the /teams route. `status` is
//  the wire word verbatim; `kind` separates wakeable devcontainer projects from
//  ad-hoc loose sessions.

export const TeamInfoSchema = z
	.object({
		team: z.string(),
		// The id of the Gateway that owns this session. `team` stays the bare local
		// name; the console composes the qualified key `gateway/team` to keep two
		// Gateways' identically-named sessions apart. Always stamped by the gateway.
		gatewayId: z.string(),
		// The Domain id of the Gateway that owns this session. A gateway id is unique only
		// within a Domain, so the full (domainId, gatewayId) pair addresses a session
		// unambiguously: two linked friend Domains may run a gateway with a colliding id.
		// Absent when this gateway has not resolved a Domain yet (arming mode); a consumer
		// then treats the session as belonging to the local Gateway's own Domain.
		domainId: z.string().optional(),
		// The friendly display name of the Domain that owns this session, propagated over the
		// discovery roster so a linked friend Domain shows the owner's self-set label instead
		// of a local alias. Null when the Domain has no owner-set label.
		displayName: z.string().nullish(),
		// True when the Domain that owns this session is the admin's own Domain (the evie-runner
		// who provisions others). The console reads it on its local session to decide whether to
		// show the admin surfaces. Stamped only for the admin Domain, so absence means false.
		isAdminDomain: z.boolean().optional(),
		// online = a live incarnation that has confirmed its lead handshake; verifying = a live
		// incarnation that has not (re)confirmed yet (e.g. re-registered after a gateway restart, still
		// waiting on its LLM to answer); available = a record with no live incarnation (asleep, wakeable).
		status: z.enum(["online", "verifying", "available"]),
		mode: ConnectionModeSchema.optional(),
		// loose | devcontainer | console. Always stamped by the gateway.
		kind: TeamKindSchema,
		// The free-form human label the board renders for a session record (typed at create, else the
		// cwd basename, else the id). Distinct from `displayName` (the owning Domain's network name).
		// Absent for spawn-points and sessions with no record.
		sessionLabel: z.string().optional(),
		// INBOUND ONLY. No local row carries one: nothing writes a description any more, and a session
		// card leads with the session's last reply headline instead. Kept on the wire to avoid a codegen
		// run and the staggered-deploy window a required-field change opens, NOT to save the linked
		// friend row - that row goes blank anyway once the friend's own Gateway updates, since theirs is
		// what fills it. Retiring the field is a deploy-ordering decision, not a behavioural one.
		description: z.string().optional(),
		// The plugin version the agent's MCP process reported at register. Absent for
		// consoles and offline-catalog entries (no plugin process behind them). The console
		// shows it as a chip only when it differs from the app's own expected version.
		version: z.string().optional(),
		// Epoch ms a session was last seen (from the session-resume map). Stamped for
		// sessions the gateway has a resume entry for, so the console can order the list and
		// show recency ("active 5m ago"). Absent for sessions with no resume record.
		lastActive: z.number().int().optional(),
		queue_depth: z.number().int().nonnegative(),
		// Daemon-derived from the session's own tmux pane (2-frame-hysteresis confirmed). Absent
		// means UNKNOWN (never observed, or derivation just became impossible - daemon disconnect,
		// a peek-failure streak, or the session going asleep), never false: a tile shows no pulse
		// rather than a stale frozen one. Only tmux-backed live sessions ever carry a value.
		working: z.boolean().optional(),
		needsLogin: z.boolean().optional(),
		// The session is holding an unanswered usage-limit dialog, so it cannot progress until the
		// choice is answered. limitDetail is the text after the headline's middle dot ("resets 5pm"),
		// absent when that headline carried no dot. Two flat fields rather than one, because a blocked
		// session with no reset text still has to render as blocked.
		limitBlocked: z.boolean().optional(),
		limitDetail: z.string().optional(),
		// Same-Domain federation freshness for a PEER-gateway-sourced row (this gateway's own local
		// rows never carry it - absent, not a fourth "local" value). "unreachable" is the honest
		// stale-mark Q4 requires; "quiet" is healthy idle, not stale.
		presenceFresh: z.enum(["fresh", "quiet", "unreachable"]).optional(),
	})
	.meta({ id: "TeamInfo" });

/** One source gateway's presence-plane version, as carried on the wire: an array of these (never
 * a map - codegen has no typed map, only an untyped JsonObject fallback outside the fixture
 * gates). `gateway` is the source gateway's id; today the array holds exactly one entry, this
 * gateway's own, until cross-Gateway presence exchange is implemented. */
export const PresenceVersionSchema = z
	.object({
		gateway: z.string(),
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "PresenceVersion" });

/** What the phone is currently looking at, declared on every poll so it survives a reconnect with
 * no separate op. Absent/omitted degrades to "background" once the prior declaration's TTL lapses
 * (a killed app needs no goodbye) - see gateway/intent.ts's IntentTracker, the server-side owner of
 * that TTL. */
export const FocusIntentSchema = z
	.object({
		screen: z.enum(["board", "terminal", "background"]),
		// Required when screen is "terminal": which session's terminal is open.
		terminalTeam: z.string().optional(),
		// The phone's configured terminal refresh rate; only meaningful with terminalTeam set.
		terminalRateMs: z.number().int().positive().optional(),
	})
	.meta({ id: "FocusIntent" });

/** A registry plane's version, for a plane with no multi-source concept (unlike presence's
 * per-source-gateway array - this Gateway's linked-peers roster is ALWAYS this Gateway's own
 * single view, never relayed from a peer). Same {epoch, counter} shape PlaneRegistry.version
 * returns internally, just named per-plane on the wire so a client presents the right one back. */
export const LinkedPeersVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "LinkedPeersVersion" });

// One peer row in a list_peers result: a linked friend Domain projected from the gateway's
// cross-Domain peer set. A Domain may run more than one gateway, so the same domainId can repeat
// once per gateway; the console groups by domainId. Named (.meta id) so the codegen emits it as a
// Kotlin nested class instead of erroring on an inline array-of-object. Defined ahead of
// ConsoleOpSchema/ConsolePollResultSchema (not just its own cross_domain_list_peers result) since
// the poll response's linked-peers piggyback (below) references it too.
export const CrossDomainPeerEntrySchema = z
	.object({
		domainId: z.string(),
		gatewayId: z.string(),
		// The friend OWNER's signing key (base64) - the owner-keyed identity the Users surface joins on
		// (a roster row is keyed by owner, so this maps a linked Domain back to the person who owns it).
		ownerSignPub: z.string(),
	})
	.meta({ id: "CrossDomainPeerEntry" });

/** Same scalar shape as LinkedPeersVersion - a read-anchors plane is PER OWNER (never a single
 * Gateway-wide plane; see readAnchors.ts's own doc on why), but each owner's own plane still has
 * no multi-source concept of its own, so one scalar version covers it. */
export const ReadAnchorsVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "ReadAnchorsVersion" });

/** The task-board plane's version, one scalar per owner - same shape and reasoning as
 * ReadAnchorsVersion above (per-owner plane, no multi-source concept). */
export const TaskBoardVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "TaskBoardVersion" });

/** A single linked Domain's cross-Domain-presence plane version - unlike linked-peers/read-anchors
 * (one scalar for the whole plane), cross-Domain presence is genuinely N independently-versioned
 * planes, one per linked Domain (crossDomainPresence.ts), so this is nested inside
 * CrossDomainPresenceEntry rather than standing alone as a single top-level field. */
export const CrossDomainPresenceVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainPresenceVersion" });

/** One linked Domain's cross-Domain-presence version, as the CLIENT reports what it already holds
 * on a poll op - flat (domainId alongside epoch/version), mirroring PresenceVersion's own per-source
 * shape rather than CrossDomainPresenceEntry's nested one, since the client has no content to echo
 * back here. Named (.meta id) so codegen emits a real Kotlin class instead of erroring on an inline
 * array-of-object (see CrossDomainPeerEntry's own comment for the same reason). */
export const CrossDomainPresenceKnownVersionSchema = z
	.object({
		domainId: z.string(),
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainPresenceKnownVersion" });

/** One linked Domain's current cross-Domain-presence content, piggybacked on the poll response only
 * for a Domain whose plane actually changed relative to what the Console presented (never a full
 * unconditional resend of every linked Domain - each is independently versioned). `lastRefreshedAt`
 * is refreshed by EITHER a landed push or a successful backstop pull (crossDomainPresence.ts),
 * delivered to the Console with up to a minute of coarsening (see `FRESHNESS_BUCKET_MS`) so an
 * unchanged-content reconfirmation does not bump the version on every single backstop tick; the
 * Console computes staleness display against it client-side, never a gateway-side boolean. */
export const CrossDomainPresenceEntrySchema = z
	.object({
		domainId: z.string(),
		version: CrossDomainPresenceVersionSchema,
		sessions: z.array(CrossDomainPresenceSessionSchema),
		lastRefreshedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainPresenceEntry" });

/** One team's synced read position: the furthest any of this owner's OWN devices has confirmed
 * reading, merged monotonically server-side (see ReadAnchors.report - never regresses). `epoch`/
 * `seq` are the SAME mailbox journal coordinate the app's own local ReadAnchor already uses
 * (device-mailbox.ts) - meaningful across an owner's whole device fleet because the mailbox itself
 * is already shared per owner, not per device. An array (never a map - codegen has no typed map
 * outside the fixture gates), one entry per team that has ever been reported. */
export const ReadAnchorWireEntrySchema = z
	.object({
		team: z.string(),
		epoch: z.number().int(),
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
	})
	.meta({ id: "ReadAnchorWireEntry" });

////////////////////////////////
//  Task Board Schemas
//
//  One entry of the owner's gateway-homed task board. FLAT: a parent pointer, never a children
//  array (the codegen cannot emit a recursive root); consoles and sessions rebuild the tree.

/** Body rides every plane snapshot and board_read reply, so its bound is what keeps a board under
 * the 8 MB sealed-frame cap alongside the mailbox. */
export const BOARD_BODY_MAX = 8192;

/** Mirrors board-rank.ts's RANK_MAX_LENGTH; the rank module rebalances instead of minting past it. */
export const BOARD_RANK_MAX = 64;

/** How many entries one upsert/remove may carry: a move ships a whole subtree as ONE linked pair,
 * so the bound is per-op, not per-entry. */
export const BOARD_BATCH_MAX = 200;

/** Attachments one entry may hold, matching `ChannelFilesSchema`. Bounds the fetching, not the bytes:
 * a few dozen entries at a handful of files each is noise against the projection budget. */
export const BOARD_ATTACHMENTS_MAX = 10;

/** Above this, a console does not fetch an attachment on its own; the owner taps to download.
 *
 * NOT a limit on what may be attached: the wire carries up to MAX_BLOB_BYTES in chunks and a board
 * attachment is no different. This only decides who pays for the transfer without being asked, which
 * matters because a second device opening an entry would otherwise pull hundreds of megabytes over
 * whatever connection it happens to be on. */
export const BOARD_AUTO_DOWNLOAD_MAX_BYTES = 25_000_000;

/** One attachment on a board entry. Field names mirror `ChannelFile` because every console path this
 * reuses is typed on it, and `blobId` is already the `sha256-<64 hex>` shape both stores demand. */
export const BoardAttachmentSchema = z
	.object({
		blobId: z.string().min(1).max(128),
		// The Gateway holding the bytes. A blob lives only where it landed, and an entry can be homed
		// on a different machine than the console's route, so a reference without a WHERE is dead.
		blobGateway: z.string().min(1).max(64),
		// Carried for CONTEXT, never for keying: it is how the owner says "look at mellisa-render.png"
		// and how an agent asks which of two screenshots is meant. The stored path is the content hash.
		filename: z.string().min(1).max(255),
		mime: z.string().max(255),
		size: z.number().int().nonnegative(),
	})
	.meta({ id: "BoardAttachment" });

export const BoardEntrySchema = z
	.object({
		// Writer-minted (console: random; MCP create: derived from the operation id), which is what
		// makes a replayed create the same entry and lets a cross-Gateway move keep its id.
		id: z.string().min(1).max(64),
		title: z.string().min(1).max(500),
		// Absent means no long-form text; an absolute set-body op with body absent CLEARS it.
		body: z.string().max(BOARD_BODY_MAX).optional(),
		state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]),
		// Absent means top-level. An absolute set-parent op with parent absent means root - the op
		// always sets placement, it never leaves it unchanged.
		parent: z.string().min(1).max(64).optional(),
		rank: z.string().min(1).max(BOARD_RANK_MAX),
		// The session this entry is assigned to; absent means the backlog.
		sessionId: z.string().min(1).max(128).optional(),
		// Server-stamped when trashed; absent means live. The 30-day trash sweep runs off it.
		trashedAt: z.number().int().nonnegative().optional(),
		// Written ONLY by board_set_attachments; every other writer preserves what is stored. See
		// BoardStore.setAttachments for why that is what keeps the bytes durable.
		attachments: z.array(BoardAttachmentSchema).max(BOARD_ATTACHMENTS_MAX).optional(),
	})
	.meta({ id: "BoardEntry" });

////////////////////////////////
//  Console Relay Frame Schema
//
//  Validates console_relay frames at the gateway trust boundary. The frame body
//  is console-authored and evie relays it opaquely, so the gateway must not
//  blind-cast it. The console-protocol.ts types derive from these schemas via
//  z.infer - this file is the single truth for the console wire.

/** The audience a session is shared to: a specific linked Domain, or everyone the owner trusts. The
 * `everyone_trusted` target carries no id; the gateway resolves it at the gate to any requesting
 * Domain whose owner is in the cross-Domain peer set, so it tracks the live trust set without
 * re-sharing. A share never reaches a Domain the owner has not linked. */
export const CrossDomainShareTargetSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("domain"), domainId: z.string().min(1).max(64) }),
		z.object({ kind: z.literal("everyone_trusted") }),
	])
	.meta({ id: "CrossDomainShareTarget" });

// The poll op's hold ceiling - the real hard gate on the long-poll timeout chain (this schema
// REJECTS a larger holdMs outright, not silently truncated). Pinned against the Android client's
// own LONG_POLL_HOLD_MS in ChatRepositoryConstantsTest and consoleHandler.test.ts.
export const MAX_POLL_HOLD_MS = 45_000;

export const ConsoleOpSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("register"),
			// Build identity for server-side observability: the gateway logs these at
			// register so the admin can see which build and variant a console runs.
			// Optional and additive: an older console that omits them still registers.
			clientVersion: z.string().max(64).optional(),
			clientVariant: z.string().max(16).optional(),
			// Which plugins this device currently has enabled, and the agent-facing guidance each one
			// wants a session to carry. Owned by the plugin's own manifest and reported from here, so a
			// future plugin delivers its guidance by existing on a phone rather than by an MCP update.
			// Optional so a console that has not updated yet still registers; absent contributes
			// nothing to the union rather than asserting an empty one.
			enabledPlugins: z.array(EnabledPluginSchema).max(64).optional(),
		}),
		// First-root a PENDING (rootless) Domain at the friend's silently-generated owner key.
		// A pending Domain has no gateway, so first-rooting does not normally travel this op:
		// the app reads the pending state plus the invite nonce from the blob's `pendingTenant`
		// and POSTs the SignedFirstRoot directly to evie's console-bridge firstRoot intake.
		// This gateway-side variant is a defensive reject: a gateway only exists once the
		// Domain is already rooted, so a first_root reaching it is past rooting.
		z.object({ kind: z.literal("first_root"), firstRoot: SignedFirstRootSchema }),
		z.object({ kind: z.literal("list_teams") }),
		z.object({
			kind: z.literal("send"),
			to: z.string().min(1).max(128),
			// The Domain id of the target session, present only for a cross-Domain send. A gateway
			// id is unique only within a Domain, so the gateway resolves the seal target by the
			// full (domainId, gatewayId) pair when set; absent keeps local/cross-Gateway resolution.
			domainId: z.string().min(1).max(64).optional(),
			body: z.string().min(1),
			files: ChannelFilesSchema.optional(),
		}),
		z.object({
			kind: z.literal("respond"),
			session_id: z.string().min(1),
			status: z.string().optional(),
			response: z.string().optional(),
			replyAsJson: z.record(z.string(), z.unknown()).optional(),
			files: ChannelFilesSchema.optional(),
		}),
		z.object({
			kind: z.literal("poll"),
			cursor: z.number().int().nonnegative().optional(),
			epoch: z.number().int().nonnegative().optional(),
			holdMs: z.number().int().nonnegative().max(MAX_POLL_HOLD_MS).optional(),
			// The keyring version the Console last synced; the Gateway returns the snapshot in
			// the poll reply only when it differs, so the Console stays fresh at near-zero cost.
			knownDomainVersion: z.string().optional(),
			// Every source-gateway presence-plane version this Console already holds. ABSENT (an old
			// APK) means a legacy client: the gateway sends no presence plane at all, unchanged
			// behavior. An EMPTY array means a new client's cold boot: every plane ships. Any
			// difference (behind, ahead, or an unrecognized source) ships that source's current
			// truth - see PollWaitHub's own "no ahead special case" design.
			knownPresenceVersions: z.array(PresenceVersionSchema).optional(),
			focus: FocusIntentSchema.optional(),
			// The linked-peers plane version this Console already holds. A single scalar (not an
			// array like knownPresenceVersions - this Gateway's own linked-peers roster has no
			// multi-source concept to distinguish), mirroring knownDomainVersion's own shape:
			// absent (a legacy client, or this session's cold boot - the two need no distinction
			// here, both simply want the current snapshot) ships unconditionally; present ships
			// only if the version actually differs.
			knownLinkedPeersVersion: LinkedPeersVersionSchema.optional(),
			// This owner's read-anchors plane version already held - same absent-ships-unconditionally
			// shape as knownLinkedPeersVersion (one scalar per owner, no multi-source concept).
			knownReadAnchorsVersion: ReadAnchorsVersionSchema.optional(),
			// This owner's task-board plane version already held - same scalar shape again.
			knownTaskBoardVersion: TaskBoardVersionSchema.optional(),
			// Every linked Domain's cross-Domain-presence plane version this Console already holds -
			// an array like knownPresenceVersions (genuinely many independently-versioned sources, one
			// per linked Domain), never a single scalar. ABSENT means a legacy client: no cross-Domain-
			// presence plane ships at all. An EMPTY array means a fresh Console with nothing cached yet -
			// every linked Domain's current content ships. A domainId missing from this array (but the
			// field itself present) is treated as unknown, same as an unrecognized presence source -
			// its current truth ships too.
			knownCrossDomainPresenceVersions: z.array(CrossDomainPresenceKnownVersionSchema).optional(),
		}),
		// Report this device's own read position for one team, so another of the SAME owner's
		// devices can learn "already read up to here" - see readAnchors.ts's monotonic merge (a
		// stale report can never regress what a different device already confirmed read). `epoch`/
		// `seq` are the device's own local ReadAnchor coordinate (device-mailbox.ts's journal),
		// meaningful across the owner's whole device fleet since the mailbox itself is shared per
		// owner. Idempotent by construction (report() is monotonic, not a one-shot side effect), so
		// this is deliberately NOT in isMutatingOp's opId-cache list - a retried report just
		// re-applies the same (harmless, idempotent) comparison.
		z.object({
			kind: z.literal("report_read"),
			team: z.string().min(1).max(128),
			// Bounded to the signed-32-bit range a genuine mailbox epoch is minted within
			// (plane-registry.ts's mintEpoch) - unbounded would let a single malformed or malicious
			// report permanently outrank every legitimate epoch this owner's real devices could ever
			// mint, since the merge rule (readAnchors.ts) has no ceiling of its own and no way to
			// reset a poisoned value once stored.
			epoch: z.number().int().nonnegative().max(0x7fffffff),
			seq: z.number().int().nonnegative(),
		}),
		// Task board ops. Every mutation is ABSOLUTE (states the value wanted, never a change to
		// make) and joins isMutatingOp so the opCache replays a lost reply instead of letting a
		// retry regress a newer write. A refusal is an ok=false inside the sealed reply.

		// Insert-or-replace whole entries by their writer-minted ids: creation, and the write half
		// of a cross-Gateway move (which ships a subtree in one op, hence the array).
		z.object({
			kind: z.literal("board_upsert"),
			entries: z.array(BoardEntrySchema).min(1).max(BOARD_BATCH_MAX),
		}),
		z.object({
			kind: z.literal("board_set_state"),
			id: z.string().min(1).max(64),
			state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]),
		}),
		z.object({
			kind: z.literal("board_set_title"),
			id: z.string().min(1).max(64),
			title: z.string().min(1).max(500),
		}),
		// Absent body CLEARS it: this op always sets the body, it never leaves it unchanged.
		z.object({
			kind: z.literal("board_set_body"),
			id: z.string().min(1).max(64),
			body: z.string().max(BOARD_BODY_MAX).optional(),
		}),
		// The SOLE committer of an entry's attachments, and absolute like every other setter: the
		// list sent is the list stored, so adding and removing a picture are the same op. An empty
		// array clears. Every member's bytes must already be durable under the entry or reachable in
		// the blob cache, or the op does not commit.
		z.object({
			kind: z.literal("board_set_attachments"),
			id: z.string().min(1).max(64),
			attachments: z.array(BoardAttachmentSchema).max(BOARD_ATTACHMENTS_MAX),
			// Which members the SENDER still has bytes for and is uploading. A fact about the sender's
			// own disk, never a prediction about the Gateway's, which is what lets the Gateway decide
			// whether a member it cannot find is racing an upload or is gone from every machine.
			// Absent means a client that cannot say, which is treated as "any of them might arrive".
			supplied: z.array(z.string().min(1).max(128)).max(BOARD_ATTACHMENTS_MAX).optional(),
		}),
		// One PLACEMENT intent: parent and rank land together. Absent parent means root.
		z.object({
			kind: z.literal("board_set_parent"),
			id: z.string().min(1).max(64),
			parent: z.string().min(1).max(64).optional(),
			rank: z.string().min(1).max(BOARD_RANK_MAX),
		}),
		// trashed:true stamps trashedAt server-side (the sweep clock is the gateway's); false clears
		// it, which is Restore.
		z.object({
			kind: z.literal("board_set_trashed"),
			id: z.string().min(1).max(64),
			trashed: z.boolean(),
		}),
		// Assign / unassign. Applies to the entry AND its subtree (assigning a parent assigns the
		// whole branch; unassign is the undo). Absent sessionId returns the branch to the backlog.
		z.object({
			kind: z.literal("board_set_session"),
			id: z.string().min(1).max(64),
			sessionId: z.string().min(1).max(128).optional(),
		}),
		// TRUE removal by id - the delete half of a cross-Gateway move only, since a trashed
		// tombstone on the origin would let Restore fork a moved entry into two.
		z.object({
			kind: z.literal("board_remove"),
			ids: z.array(z.string().min(1).max(64)).min(1).max(BOARD_BATCH_MAX),
		}),
		// The union's read half: a non-route Gateway's entries arrive through this (routed by the
		// frame's targetGateway), since the plane rides only the route Gateway's poll. Runs fresh.
		z.object({ kind: z.literal("board_read") }),
		// Capture an agent's visible tmux pane for the console terminal view. `target` is the
		// gateway-qualified session name; the gateway resolves it to the host-agent's own tmux
		// or a devcontainer and relays to the host daemon. `sinceHash` lets the console skip an
		// unchanged frame (the result returns unchanged=true with no ansi).
		z.object({
			kind: z.literal("peek"),
			target: z.string().min(1).max(128),
			sinceHash: z.string().max(64).optional(),
		}),
		// Send input to an agent's tmux pane: a literal text line OR a single named control key
		// (Enter, Escape, C-c, C-o, C-t, Up, Down, Left, Right, PageUp, PageDown, Tab, BTab). Exactly one of text/key; the gateway
		// whitelists the key name. Idempotent per opId. `submit` (text only, default true) controls the
		// trailing Enter: a chip/slash command fires with submit:true, while the terminal Send button
		// taps with submit:false (type into the composer without submitting) and long-presses with true.
		z.object({
			kind: z.literal("tmux_send"),
			target: z.string().min(1).max(128),
			text: z.string().max(4096).optional(),
			key: z.string().max(32).optional(),
			submit: z.boolean().optional(),
		}),
		// Start a new tmux session running a fresh agent on `target` (the host or a devcontainer).
		// The daemon owns the launch command; the console supplies only the target device plus a
		// name, so it can never inject a host command. Two forms (the handler requires exactly one
		// path): `sessionName` is a typed slug adopted as the session id (slug-validated at the host
		// tmux layer); `displayLabel` is a free-form label for which the gateway MINTS the id (that
		// minted id is the tmux name). Idempotent per opId.
		z.object({
			kind: z.literal("create_session"),
			target: z.string().min(1).max(128),
			sessionName: z.string().min(1).max(64).optional(),
			displayLabel: z.string().min(1).max(64).optional(),
			// A picked host working directory (absolute or ~-rooted; the directory picker's choice).
			// Host sessions only - a devcontainer's workdir stays fixed. Absent keeps the label-derived
			// default. Gateway-validated against isWorkdirPath; the daemon re-guards and falls back to
			// home when the path no longer exists.
			workdir: z.string().min(1).max(512).optional(),
		}),
		// Drive a session through the plugin update + MCP reconnect sequence. `target` is the
		// gateway-qualified session to reload; the host runs the script detached. Idempotent per opId.
		z.object({
			kind: z.literal("reload_plugins"),
			target: z.string().min(1).max(128),
		}),
		// Forget a session: kill its running tmux and drop its durable resume record, so it
		// stops being listed as available. `target` must resolve to a composite session, not a
		// bare spawn-point project. Idempotent per opId.
		z.object({
			kind: z.literal("forget"),
			target: z.string().min(1).max(128),
			// What becomes of the session's unfinished board work, applied in the SAME store pass
			// that ends the session. Absent means "release", which is what the TTL sweep does and
			// what every forget did before the field existed, so an older console changes nothing.
			boardDisposition: z.enum(["release", "cancel"]).optional(),
		}),
		// Close a session: kill its running tmux but KEEP its durable resume record, so it stays
		// listed as available and can be re-woken (a restart / mop-up, distinct from forget's
		// permanent drop). Same target rules as forget. Idempotent per opId.
		z.object({
			kind: z.literal("close_session"),
			target: z.string().min(1).max(128),
		}),
		// Rename a session: set the gateway-authoritative sessionLabel on its record. `target` is
		// the gateway-qualified composite session (like forget). The gateway sanitizes + per-spawn
		// dedups the label. Idempotent per opId.
		z.object({
			kind: z.literal("rename_session"),
			target: z.string().min(1).max(128),
			sessionLabel: z.string().min(1).max(64),
		}),
		// List the immediate subdirectories of one host directory, for the create-session directory
		// picker's type-ahead. Host filesystem only (a devcontainer session's workdir is fixed).
		// Read-only, runs fresh (never opId-cached). The path must be absolute or ~-rooted.
		z.object({
			kind: z.literal("list_dirs"),
			path: z.string().min(1).max(512),
		}),
		// Blob transfer. Bytes move here, in bounded chunks keyed by their own digest, rather than
		// as a base64 field on a message. `have` is the contiguous prefix the store holds, which is
		// both the answer to "how much got there" and the offset to resume from, so a retry needs
		// no separate bookkeeping and a re-sent chunk is a no-op.
		BlobStatOpSchema,
		BlobPutOpSchema,
		BlobGetOpSchema,
		// Cross-Domain listening-mode handshake (cross-domain-federation.md). These ops drive
		// the mutual pairing that links two Gateways owned by different owners. The owner root
		// key is phone-held, so each side signs its link on the phone; the Gateway mints the
		// listening window + pin pairing and writes the confirmed peer. The Console accepts a
		// request only while its listening window is open, so there is no unsolicited surface.

		// Open a listening window: the Gateway mints a single-use listening token and returns
		// its own owner + gateway keys for the SAS. The phone shows the token to the other
		// owner out of band. No parameters.
		z.object({ kind: z.literal("cross_domain_listen") }),
		// The requester's leg: pair against the OTHER side's listening token. The Gateway
		// runs the full commit-reveal exchange with the receiver internally (it holds the
		// keys + salts), so the phone supplies only the rendezvous inputs. The token prefix
		// names the receiver's Gateway so the relay can route it.
		z.object({
			kind: z.literal("cross_domain_request"),
			// The single-use listening token the RECEIVER minted (format
			// `<receiverGatewayId>.<random>`), naming the receiver's Gateway for routing.
			listeningToken: z.string().min(1),
			// The requester-minted single-use rendezvous pin (base64url). Pairs the two
			// listening sessions; consumed once. Not the trust root - the SAS is.
			pin: z.string().min(1),
			// The requesting owner's root signing public key (base64). Advisory only (phone
			// display): the Gateway uses the owner key the console was admitted under, not
			// this op-supplied value.
			requesterOwnerSignPub: z.string().min(1),
			// The requester's Domain + Gateway ids (slugs), recorded on the receiver's pairing
			// so the confirmed peer is keyed by `(domainId, gatewayId)`.
			requesterDomainId: z.string().min(1).max(64),
			requesterGatewayId: z.string().min(1).max(64),
		}),
		// Confirm the SAS match (run on BOTH sides after the humans compared codes). Each owner
		// confirms INDEPENDENTLY, carrying only its OWN signed link side: the phone signed it,
		// binding the FRIEND Gateway's keys it already learned from the SAS-verified pairing. The
		// Gateway verifies that one link under its own owner key and writes the friend as the
		// cross-Domain peer. `pin` looks up the pairing. There is no friend-link exchange: the seal
		// uses only the friend's box key from the pairing, so the stored link is the local owner's
		// own attestation, and whose signature is on it does not affect seal security.
		z.object({
			kind: z.literal("cross_domain_confirm"),
			pin: z.string().min(1),
			// This owner's own signed link side (owner-signed on the phone). Binds the FRIEND
			// Gateway's keys; the confirming Gateway verifies it under its own owner key.
			mySignedLink: SignedXDomainLinkSchema,
		}),
		// Poll a receiver's listening window so the receiver phone learns a pairing arrived. The
		// receiver opens a window with cross_domain_listen, reads the token to the friend, then
		// calls this on a short interval: the requester drives the commit-reveal, which lands the
		// pairing on the receiver's window, so this read is the receiver's only path to the SAS
		// and the friend's keys it must owner-sign a link over. Read-only. An unknown or expired
		// token returns pairingArrived=false (with expired=true) rather than an error.
		z.object({
			kind: z.literal("cross_domain_listen_state"),
			// The listening token cross_domain_listen minted (names this window).
			listeningToken: z.string().min(1),
		}),
		// Cancel a listening window (the owner left the pairing screen). Invalidates the
		// token + any pairing so a stale request cannot complete. The phone passes the
		// listening token (receiver side) and/or the pin (requester side) so the cancel
		// targets that window; absent both, it is a sweep-only no-op success.
		z.object({
			kind: z.literal("cross_domain_cancel"),
			listeningToken: z.string().optional(),
			pin: z.string().optional(),
		}),
		// Per-session sharing (cross-domain-federation.md). These ops manage which of this
		// owner's local sessions are offered to a linked friend Domain. Checking a share is the
		// consent; the friend's agents may then reach the shared session. Only devcontainer and
		// loose sessions may be shared, never a host-agent or console, enforced against the
		// local team registry. Authenticated by the existing console seal, so there is no second
		// signature scheme.

		// Mark a local session shared to an audience (a specific linked Domain, or everyone the owner
		// trusts). Idempotent on `(sessionTarget, target)`: a re-share refreshes rather than duplicating.
		z.object({
			kind: z.literal("cross_domain_share"),
			// The canonical `domain.gateway.spawn.session` target of the local session to share.
			sessionTarget: z.string().min(1).max(128),
			// Who the session is shared TO (a linked Domain, or everyone trusted).
			target: CrossDomainShareTargetSchema,
		}),
		// Withdraw a local session's share from an audience.
		z.object({
			kind: z.literal("cross_domain_unshare"),
			sessionTarget: z.string().min(1).max(128),
			target: CrossDomainShareTargetSchema,
		}),
		// Read this owner's current shares (so the console can render the share checkmarks).
		z.object({ kind: z.literal("cross_domain_list_shares") }),
		// Read the linked friend Domains from the gateway's cross-Domain peer set. Distinct from
		// discovery: a peer is listed the moment it is linked, regardless of whether its gateway
		// is online, so a freshly-linked peer is visible before any session crosses. Read-only
		// roster; presence comes from discovery.
		z.object({ kind: z.literal("cross_domain_list_peers") }),
		// Unlink a linked friend Domain: drop the local trust and share state for it (every peer
		// gateway of that Domain, every share offered to it, and any in-flight job bound to it).
		// Keyed by `domainId`, so the whole Domain is forgotten at once. After this the sealer
		// can no longer resolve that peer, so seals to it fail closed. The owner's phone
		// separately owner-signs the link-edge revocation so the Router drops its relay edge.
		z.object({
			kind: z.literal("cross_domain_unlink"),
			// The friend Domain (slug) to unlink.
			domainId: z.string().min(1).max(64),
		}),
		// Untrust a person by owner key: drop the local trust and share state for every peer
		// Gateway owned by that owner (across all their Domains) plus every share to those
		// Domains, the owner-keyed sibling of cross_domain_unlink. Console-sealed auth. The
		// phone separately owner-signs the untrust tombstone for the Router-side relay-edge
		// revoke; this op is the local-state half.
		z.object({
			kind: z.literal("cross_domain_untrust"),
			// The friend OWNER's raw Ed25519 signing key (base64) to forget.
			ownerSignPub: z.string().min(1).max(128),
		}),
	])
	.meta({ id: "ConsoleOp" });

////////////////////////////////
//  Sealed envelope (the E2E crypto wrapper - shared/crypto.ts)
//
//  Confidentiality (ephemeral X25519 box) + authenticity (Ed25519 signature).
//  Codegen'd to Kotlin so the console seals/opens with the byte-identical Crypto.kt.

export const SealedEnvelopeSchema = z
	.object({
		ephemeralPub: z.string(),
		nonce: z.string(),
		ciphertext: z.string(),
		signature: z.string(),
	})
	.meta({ id: "SealedEnvelope" });

export const ConsoleRelayFrameSchema = z
	.object({
		type: z.literal("console_relay"),
		v: z.number().int().positive(),
		opId: z.string().min(1).max(128),
		// The console's raw Ed25519 signing public key (base64). Selects the key the gateway
		// verifies the seal against, then checked against the owner-signed allowlist (must be an
		// admitted kind:console subject). Cleartext because it is a public key, not a secret.
		// conversationId, device, and the op move inside the seal, so evie sees only this opaque
		// blob and cannot read or forge the op.
		signerSignPub: z.string().min(1),
		// The Gateway this op targets, so evie routes per-target (the Console seals to each Gateway
		// directly). Plaintext routing metadata, like signerSignPub; absent falls back to evie's
		// latest-Gateway routing.
		targetGateway: z.string().optional(),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "ConsoleRelayFrame" });

////////////////////////////////
//  Console Op Envelope (the sealed inner body)
//
//  What the console seals and the gateway opens. `at` bounds freshness; the seal's
//  random nonce bounds replay; the seal's ECDH binds it to this gateway's box key.

export const ConsoleOpEnvelopeSchema = z
	.object({
		v: z.number().int().positive(),
		conversationId: z.string().min(1).max(MAX_CONVERSATION_ID_LEN).regex(CONVERSATION_ID_RE),
		device: z.string().min(1).max(64),
		at: z.number().int().nonnegative(),
		op: ConsoleOpSchema,
	})
	.meta({ id: "ConsoleOpEnvelope" });

////////////////////////////////
//  Mailbox Entry Schema (gateway -> console)
//
//  Composed by the gateway, decoded by the console. `kind` is closed here
//  because the gateway owns composition; the GENERATED Kotlin keeps it an
//  open String (decode-side rule).

export const MailboxEntrySchema = z
	.object({
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
		kind: z.enum(["message", "reply", "notice", "sent", "peer", "plugin_action"]),
		session_id: z.string(),
		from: z.string().optional(),
		// The recipient's canonical address on a `peer` mirror, so the SENDER's own thread (where
		// `from` alone cannot identify the other endpoint) can still label the exchange's direction.
		to: z.string().optional(),
		// Stable per-logical-message id, set by whichever gateway first composes the entry and
		// carried verbatim through any relay this entry crosses before landing in a mailbox.
		// Lets every appender - local or remote - dedupe an at-least-once retry against the SAME
		// key instead of each inventing its own, without depending on `opId` (only set on `sent`).
		dedupeKey: z.string().optional(),
		// The originating send's opId on a `sent` echo (an owner's own outgoing message
		// mirrored to all their devices). The sending device matches it to its optimistic
		// row and settles it instead of double-rendering; other devices render it fresh.
		opId: z.string().optional(),
		// Notification-bar line for notices; the body carries the full report.
		title: z.string().optional(),
		// The Short tier of a notice (3-4 sentences), addressable on its own so
		// console features never parse it back out of the body. Present on notices;
		// absent on a plain reply or a `sent` echo.
		summary: z.string().optional(),
		body: z.string().optional(),
		// The spoken copy of the body (the FULL play tier speaks this, never `body`).
		fullSpoken: z.string().optional(),
		// Reply/notice state on the wire (e.g. "running"/"error"). A `sent` echo never
		// carries it: an owner's own outgoing message is always settled (status null).
		status: z.string().optional(),
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		question: z.string().optional(),
		reason: z.string().optional(),
		files: ChannelFilesSchema.optional(),
		// A `plugin_action` entry only: which plugin, which action, and its opaque payload. Routed
		// by the console to a plugin-claimed handler instead of being rendered as a chat message.
		pluginId: z.string().optional(),
		actionType: z.string().optional(),
		payload: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "MailboxEntry" });

////////////////////////////////
//  Gateway transport creds (the gateway-bridge SA token + endpoint)
//
//  A dep-free leaf the GatewayBootstrapBundle seals (the creds a creds-less Gateway needs to reach
//  evie). The Console pulls this from evie directly (a signed TRANSPORT_REQUEST_V1 proof).

export const GatewayTransportSchema = z
	.object({
		apiUrl: z.string().min(1),
		saToken: z.string().min(1),
		caPem: z.string().min(1),
		appToken: z.string().min(1).optional(),
	})
	.meta({ id: "GatewayTransport" });

export type GatewayTransport = z.infer<typeof GatewayTransportSchema>;

////////////////////////////////
//  Op result schemas (gateway -> console)
//
//  No wire discriminator: the reply is correlated to its op by opId and the
//  console decodes the result it expects per op. These generate as independent
//  Kotlin data classes, never a sealed hierarchy.

export const ConsoleRegisterResultSchema = z
	.object({
		device: z.string(),
		// The id of the Gateway this console is connected to. The console anchors its
		// composite (gatewayId, name) key to this: it qualifies bare names to this
		// Gateway and migrates bare-keyed threads onto it. Always sent by the gateway.
		gatewayId: z.string(),
		// Current mailbox high-water seq so a reconnecting console can resync its cursor.
		cursor: z.number().int().nonnegative(),
		// Mailbox instance id. If it differs from the console's stored epoch, the
		// mailbox was recreated and the console must reset its cursor to 0.
		epoch: z.number().int().nonnegative(),
		// Whether this console's Domain is rooted yet, as the connected gateway sees it. A gateway
		// only exists for a Domain past rooting, so this reply reports only `rooted` (or `unrooted`
		// for a fresh admin Domain), never `pending`. Absent until this gateway completes its own
		// evie register; the app then treats the Domain as already rooted.
		domainStatus: DomainStatusSchema.optional(),
	})
	.meta({ id: "ConsoleRegisterResult" });

export const ConsoleListTeamsResultSchema = z
	.object({
		teams: z.array(TeamInfoSchema),
	})
	.meta({ id: "ConsoleListTeamsResult" });

export const ConsoleSendResultSchema = z
	.object({
		session_id: z.string(),
		status: z.string(),
	})
	.meta({ id: "ConsoleSendResult" });

export const ConsoleRespondResultSchema = z
	.object({
		delivered: z.boolean(),
	})
	.meta({ id: "ConsoleRespondResult" });

export const ConsolePollResultSchema = z
	.object({
		entries: z.array(MailboxEntrySchema),
		cursor: z.number().int().nonnegative(),
		// Cumulative count of entries evicted by the cap before the console read
		// them. Never reset server-side; the console detects a new gap by comparing
		// against the previous total (or by a non-contiguous seq jump).
		dropped: z.number().int().nonnegative(),
		// Mailbox instance id. On change the console resets its cursor to 0 (the
		// prior mailbox was evicted and a new one started seq at 1).
		epoch: z.number().int().nonnegative(),
		// The keyring version, and the snapshot itself, present only when it changed from
		// the Console's knownDomainVersion. The Console applies it (owner-pinned) and
		// re-verifies its peers, so a revocation made elsewhere reaches it within a cycle.
		domainVersion: z.string().optional(),
		domain: DomainSnapshotSchema.optional(),
		// The presence plane's current truth, present only when at least one source's version
		// differs from what the Console presented via knownPresenceVersions - generalizes the
		// domainVersion pair above onto the same piggyback shape. `presenceVersions` always
		// accompanies `presence` (never one without the other) so the Console has a version to
		// remember for its next poll.
		presence: z.array(TeamInfoSchema).optional(),
		presenceVersions: z.array(PresenceVersionSchema).optional(),
		// The linked-peers plane's current truth, same piggyback shape as presence above but a
		// single scalar version (see knownLinkedPeersVersion). `linkedPeersVersion` always
		// accompanies `linkedPeers` (never one without the other).
		linkedPeers: z.array(CrossDomainPeerEntrySchema).optional(),
		linkedPeersVersion: LinkedPeersVersionSchema.optional(),
		// This owner's read-anchors plane, same piggyback shape again - a single scalar version
		// (see knownReadAnchorsVersion) and the full per-team snapshot on any real change.
		readAnchors: z.array(ReadAnchorWireEntrySchema).optional(),
		readAnchorsVersion: ReadAnchorsVersionSchema.optional(),
		// This owner's task-board plane, same piggyback shape. `taskBoardTruncated` marks a
		// byte-budgeted projection that shipped a subset rather than failing the whole poll.
		taskBoard: z.array(BoardEntrySchema).optional(),
		taskBoardVersion: TaskBoardVersionSchema.optional(),
		taskBoardTruncated: z.boolean().optional(),
		// Cross-Domain presence: unlike every plane above, genuinely N independently-versioned
		// planes (one per linked Domain), so this carries only the SUBSET of linked Domains whose
		// plane actually changed relative to knownCrossDomainPresenceVersions - never a full resend
		// of every linked Domain the way presence's single-plane piggyback above does.
		crossDomainPresence: z.array(CrossDomainPresenceEntrySchema).optional(),
		// Why this poll settled: which plane's bump woke it (or a mailbox append, or the hold simply
		// elapsing). The Console's instant-empty-response heuristic (its old-gateway degradation
		// signal) reads this so a plane-only settle - empty mailbox entries, no gap - is never
		// misread as a broken gateway and does not trip its backoff.
		settled: z
			.enum([
				"mailbox",
				"presence",
				"crossDomainPresence",
				"linkedPeers",
				"readAnchors",
				"taskBoard",
				"domain",
				"timeout",
			])
			.optional(),
	})
	.meta({ id: "ConsolePollResult" });

export const ConsolePeekResultSchema = z
	.object({
		// The captured pane, ANSI-colored. Present for a tmux peek. Absent when unchanged (the
		// console's sinceHash matched), so an idle terminal costs only the hash round-trip.
		ansi: z.string().optional(),
		// The devcontainer's `docker logs` tail, present INSTEAD of `ansi` while the session's tmux
		// pane does not exist yet (still booting). Read-only (no pane to send input to).
		text: z.string().optional(),
		// Which payload this frame carries: "tmux" (a live pane in `ansi`) or "container-logs" (a
		// boot-log snapshot in `text`). A flat optional field, NOT a discriminated union: the Kotlin
		// codegen silently drops a decode-side union root. Absent from an older gateway (treat as tmux).
		kind: z.enum(["tmux", "container-logs"]).optional(),
		// Short content hash of the frame; the console sends it back as sinceHash next cycle.
		hash: z.string(),
		unchanged: z.boolean().optional(),
	})
	.meta({ id: "ConsolePeekResult" });

export const ConsoleTmuxSendResultSchema = z
	.object({
		sent: z.boolean(),
	})
	.meta({ id: "ConsoleTmuxSendResult" });

export const ConsoleReportReadResultSchema = z
	.object({
		// Whether this report actually advanced the stored anchor - false means another of this
		// owner's devices already reported an equal-or-further position (report()'s monotonic
		// merge), which the console can use as a hint that it is not the furthest-read device.
		advanced: z.boolean(),
	})
	.meta({ id: "ConsoleReportReadResult" });

export const ConsoleCreateSessionResultSchema = z
	.object({
		// The daemon detaches the new session immediately; the agent boots after this returns,
		// so the console polls a peek to see it come up.
		created: z.boolean(),
		// The session id the gateway recorded (minted for a displayLabel create, else the adopted
		// sessionName) and the label it stored, so the console opens the thread keyed on the id.
		// Absent from an older gateway that only reported `created`.
		id: z.string().optional(),
		sessionLabel: z.string().optional(),
		// True iff a caller-supplied displayLabel could not be used as-is (sanitizeLabel rejected it -
		// invisible/forbidden characters) and sessionLabel fell back to the id instead. Computed once,
		// directly from the request's own displayLabel, never from comparing sessionLabel/id after the
		// fact - a later unrelated rename must not flip this flag. Absent/false whenever no displayLabel
		// was sent at all (the sessionName-adopted path legitimately has sessionLabel === id as its
		// normal, unrelated default and must never be read as this signal).
		labelSanitized: z.boolean().optional(),
		// Present only when a cold devcontainer bring-up outran the gateway's bound and the launch is
		// continuing in the background (id/sessionLabel are still the real, already-adopted values -
		// only the launch itself is still in flight). Absent means the launch already completed by the
		// time this reply was sent.
		status: z.enum(["pending"]).optional(),
	})
	.meta({ id: "ConsoleCreateSessionResult" });

export const ConsoleReloadPluginsResultSchema = z
	.object({
		// The reload script runs detached on the host for ~40s after this returns.
		initiated: z.boolean(),
	})
	.meta({ id: "ConsoleReloadPluginsResult" });

export const ConsoleForgetResultSchema = z
	.object({
		// The session's tmux was torn down and its resume record dropped (idempotent: also true
		// when the session was already gone).
		killed: z.boolean(),
		// The disposition this Gateway actually applied. A gateway without the field strips the
		// request's copy and answers without this one, so a console that asked for "cancel" can
		// tell it was downgraded rather than assuming its choice landed.
		boardDisposition: z.enum(["release", "cancel"]).optional(),
	})
	.meta({ id: "ConsoleForgetResult" });

export const ConsoleCloseSessionResultSchema = z
	.object({
		// The session's tmux was torn down but its resume record kept (idempotent: also true when
		// the session was already gone).
		closed: z.boolean(),
	})
	.meta({ id: "ConsoleCloseSessionResult" });

export const ConsoleRenameSessionResultSchema = z
	.object({
		// The record was found and relabeled (false when no record matched the target).
		renamed: z.boolean(),
		// The label actually applied, after the gateway's sanitize + per-spawn dedup.
		sessionLabel: z.string().optional(),
	})
	.meta({ id: "ConsoleRenameSessionResult" });

/** Answers to the three blob ops. `have` is the contiguous prefix, so a client resumes by sending
 * from it rather than tracking its own progress. Flat optional fields, per the wire rule. */
export const ConsoleBlobStatResultSchema = z
	.object({
		have: z.number().int().nonnegative(),
		size: z.number().int().nonnegative().optional(),
		complete: z.boolean(),
	})
	.meta({ id: "ConsoleBlobStatResult" });

export const ConsoleBlobPutResultSchema = z
	.object({
		have: z.number().int().nonnegative(),
		complete: z.boolean(),
	})
	.meta({ id: "ConsoleBlobPutResult" });

export const ConsoleBlobGetResultSchema = z
	.object({
		// One chunk, base64'd; absent when the range was empty.
		chunk: z.string().optional(),
		eof: z.boolean(),
	})
	.meta({ id: "ConsoleBlobGetResult" });

export const ConsoleListDirsResultSchema = z
	.object({
		// Immediate subdirectory names (dirs and dir symlinks only), sorted. Empty for a missing or
		// unreadable path - an autocomplete has no use for the reason.
		entries: z.array(z.string()),
		// True when the daemon's wire sanity bound cut the listing (never a UX cap; the console
		// filters locally, so a hit only means the fragment filter may be incomplete).
		truncated: z.boolean().optional(),
	})
	.meta({ id: "ConsoleListDirsResult" });

////////////////////////////////
//  Cross-Domain handshake op results (gateway -> console)
//
//  The replies for the four cross_domain_* ops. cross_domain_listen returns the minted
//  token + this Gateway's own owner/gateway keys (the requester needs them for the SAS).
//  cross_domain_request returns the SAS the phone displays (computed over the six bound
//  keys + the pin) so the human can read it out. confirm/cancel are simple acks.

export const CrossDomainListenResultSchema = z
	.object({
		// The minted single-use listening token (format `<gatewayId>.<random>`); the owner
		// reads it to the other owner out of band.
		listeningToken: z.string(),
		// This Gateway's owner root + gateway keys, so the requester can build the link and
		// compute the SAS over both sides' keys.
		receiverOwnerSignPub: z.string(),
		receiverGatewaySignPub: z.string(),
		receiverGatewayBoxPub: z.string(),
		receiverDomainId: z.string(),
		receiverGatewayId: z.string(),
		// When the window closes (epoch ms); the phone shows the countdown.
		expiresAt: z.number().int(),
	})
	.meta({ id: "CrossDomainListenResult" });

export const CrossDomainRequestResultSchema = z
	.object({
		// The safety code the phone displays for the human to read aloud; both phones derive
		// the same value when no key was substituted in transit.
		sas: z.string(),
		// Echoed so the requester phone can render the pairing: both owner keys plus the
		// receiver's Domain/Gateway it just paired with.
		requesterOwnerSignPub: z.string(),
		receiverOwnerSignPub: z.string(),
		receiverDomainId: z.string(),
		receiverGatewayId: z.string(),
		// The receiver Gateway's keys, so the requester phone can owner-sign its link side
		// (the link binds the friend Gateway's keys) for the confirm leg.
		receiverGatewaySignPub: z.string(),
		receiverGatewayBoxPub: z.string(),
	})
	.meta({ id: "CrossDomainRequestResult" });

export const CrossDomainConfirmResultSchema = z
	.object({
		ok: z.boolean(),
	})
	.meta({ id: "CrossDomainConfirmResult" });

export const CrossDomainCancelResultSchema = z
	.object({
		cancelled: z.boolean(),
	})
	.meta({ id: "CrossDomainCancelResult" });

// The receiver's view of its listening window (the cross_domain_listen_state poll). Before a
// pairing arrives it carries only pairingArrived=false (plus the window's expiry, or expired=true
// once the window is gone). Once the requester's commit-reveal lands the pairing, it carries the
// SAS the receiver computed plus the friend's keys the receiver phone must owner-sign its link
// over. The phone transitions to the type-the-code compare on pairingArrived.
export const CrossDomainListenStateResultSchema = z
	.object({
		// True once a requester paired against this window (the SAS + friend keys are then present).
		pairingArrived: z.boolean(),
		// The requester-minted rendezvous pin (present only when arrived). The receiver passes it
		// back to cross_domain_confirm so the gateway resolves this window's pairing (the receiver
		// never minted it; it learns it here, E2E sealed). Single-use, consumed at confirm.
		pin: z.string().optional(),
		// The 6-digit safety code, present only when pairingArrived. Identical to the requester's
		// so the two humans compare the same value.
		sas: z.string().optional(),
		// The friend's keys the receiver must owner-sign a link over (present only when arrived):
		// the friend owner root + the friend Gateway's sign/box keys, plus the friend Domain /
		// Gateway ids. The receiver phone signs mySignedLink binding these for cross_domain_confirm.
		friendOwnerSignPub: z.string().optional(),
		friendGatewaySignPub: z.string().optional(),
		friendGatewayBoxPub: z.string().optional(),
		friendDomainId: z.string().optional(),
		friendGatewayId: z.string().optional(),
		// When the window closes (epoch ms); the phone shows the countdown. Absent once the window
		// no longer exists (expired/cancelled).
		expiresAt: z.number().int().optional(),
		// True when the window is gone (unknown token, expired, or cancelled): the phone restarts.
		expired: z.boolean().optional(),
	})
	.meta({ id: "CrossDomainListenStateResult" });

////////////////////////////////
//  Per-session share op results (gateway -> console)
//
//  share/unshare are simple acks; list_shares returns this owner's current shares so
//  the console can render the per-session checkmarks (one entry per session per Domain).

export const CrossDomainShareResultSchema = z
	.object({
		ok: z.boolean(),
	})
	.meta({ id: "CrossDomainShareResult" });

export const CrossDomainUnshareResultSchema = z
	.object({
		ok: z.boolean(),
	})
	.meta({ id: "CrossDomainUnshareResult" });

// One share row in a list_shares result: a local session offered to an audience (a specific linked
// Domain, or everyone trusted). Named (.meta id) so the codegen emits it as a Kotlin nested class
// instead of erroring on an inline array-of-object.
export const CrossDomainShareEntrySchema = z
	.object({
		sessionTarget: z.string(),
		target: CrossDomainShareTargetSchema,
	})
	.meta({ id: "CrossDomainShareEntry" });

export const CrossDomainListSharesResultSchema = z
	.object({
		shares: z.array(CrossDomainShareEntrySchema),
	})
	.meta({ id: "CrossDomainListSharesResult" });

// The linked friend Domains the gateway has a cross-Domain peer for (the link is written; presence
// and shared-back state are NOT implied). The console unions these domainIds with the discovery-
// derived ones so a just-linked peer appears immediately, even while its gateway is offline.
export const CrossDomainListPeersResultSchema = z
	.object({
		peers: z.array(CrossDomainPeerEntrySchema),
	})
	.meta({ id: "CrossDomainListPeersResult" });

// The local unlink cleanup counts, so the console can confirm what was forgotten
// (and render a clean zero-count result when the Domain was already unlinked).
export const CrossDomainUnlinkResultSchema = z
	.object({
		// Peer gateways of the Domain dropped from the cross-Domain peer set.
		peersRemoved: z.number().int().nonnegative(),
		// Per-session shares to the Domain forgotten.
		sharesDropped: z.number().int().nonnegative(),
		// In-flight jobs bound to the Domain settled (failed fast) instead of stalling to TTL.
		jobsExpired: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainUnlinkResult" });

/** Shared by every board mutation: the op landed. A refusal never reaches here - it is an
 * ok=false + error on the reply body, so the console's queue can tell "retire" from "retry". */
export const ConsoleBoardWriteResultSchema = z
	.object({
		applied: z.boolean(),
		// Attachments the Gateway could not resolve on ANY machine and therefore did not store, by
		// filename. The write still applied; these are gone. Reported because dropping is a normal
		// outcome, and an unreported drop is indistinguishable from a picture vanishing on its own.
		dropped: z.array(z.string().min(1).max(255)).optional(),
	})
	.meta({ id: "ConsoleBoardWriteResult" });

export const ConsoleBoardReadResultSchema = z
	.object({
		entries: z.array(BoardEntrySchema),
		// True when the byte budget forced a subset; the console keeps its prior cache for the rest.
		truncated: z.boolean().optional(),
	})
	.meta({ id: "ConsoleBoardReadResult" });

export const ConsoleOpResultSchema = z.union([
	ConsoleRegisterResultSchema,
	ConsoleListTeamsResultSchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
	ConsolePollResultSchema,
	ConsoleReportReadResultSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleForgetResultSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleRenameSessionResultSchema,
	ConsoleListDirsResultSchema,
	ConsoleBlobStatResultSchema,
	ConsoleBlobPutResultSchema,
	ConsoleBlobGetResultSchema,
	ConsoleBoardWriteResultSchema,
	ConsoleBoardReadResultSchema,
	CrossDomainListenResultSchema,
	CrossDomainRequestResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainCancelResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainUnshareResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainUnlinkResultSchema,
]);

////////////////////////////////
//  Console Reply Body (the sealed inner reply)
//
//  The gateway seals this to the console's box key; the console unseals and decodes
//  the result for its op (correlated by opId).

export const ConsoleReplyBodySchema = z
	.object({
		ok: z.boolean(),
		result: ConsoleOpResultSchema.optional(),
		error: z.string().optional(),
	})
	.meta({ id: "ConsoleReplyBody" });

export const ConsoleRelayReplySchema = z
	.object({
		type: z.literal("console_relay_reply"),
		v: z.number().int().positive(),
		opId: z.string().min(1).max(128),
		// The sealed ConsoleReplyBody (normal path). Absent ONLY when the gateway could
		// not seal because the frame was unverifiable (malformed, or the signer is not
		// an admitted console) - then `error` carries a cleartext reason so the console can
		// surface "enroll this device". A pre-seal error is the only cleartext that
		// ever leaves the gateway on the console reply path.
		sealed: SealedEnvelopeSchema.optional(),
		error: z.string().optional(),
	})
	.meta({ id: "ConsoleRelayReply" });

////////////////////////////////
//  Provisioning Schema
//
//  The blob the user pastes at console setup. Credentials and endpoints only.
//  Runtime defaulting stays app-side (device from Build.MODEL, conversationId
//  minting a UUID, URL normalization); the schema carries only the shape.

// The pending-Domain discriminator carried inside a provisioning blob. Present iff the blob is
// for a pending (unrooted) Domain, both a friend invite and the admin's own fresh setup. A
// pending Domain has no gateway, so the app cannot learn it is pending from a register reply;
// it reads this off the blob and first-roots directly against evie with the nonce. Absent for a
// re-provision of an already-rooted Domain. Named (.meta id) so the codegen emits a nested class.
export const PendingTenantRefSchema = z
	.object({
		// The opaque pending Domain id the friend's first_root roots.
		domainId: slugField(),
		// The one-time invite nonce (base64) evie checks unspent before rooting.
		nonce: b64Field(),
	})
	.meta({ id: "PendingTenantRef" });

// The admin-enroll handshake seed the QR carries (present only on an ADMIN-ENROLL invite
// blob). Named (.meta id) so the codegen emits it as a nested Kotlin class.
export const EnrollHandshakeRefSchema = z
	.object({
		// The admin's OWNER keys + Domain, OOB-authenticated by the in-person scan; the friend
		// folds them into its local enroll SAS (ENROLL_SAS_V1).
		adminOwnerSignPub: b64Field(),
		adminOwnerBoxPub: b64Field(),
		adminDomainId: slugField(),
		// The unguessable id naming the evie broker window both phones drive.
		handshakeId: b64Field(),
		// The one-time shared secret both phones fold into the SAS but NEVER send to evie.
		pin: b64Field(),
	})
	.meta({ id: "EnrollHandshakeRef" });

export const ProvisioningSchema = z
	.object({
		apiUrl: z.string().min(1),
		caPem: z.string(),
		saToken: z.string(),
		appToken: z.string().optional(),
		namespace: z.string().optional(),
		service: z.string().optional(),
		port: z.number().int().positive().optional(),
		device: z.string().optional(),
		conversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
		// Set only for a pending (unrooted) Domain blob (a friend invite or the admin's own fresh
		// setup): the pending Domain id plus the one-time invite nonce. Its presence is the
		// discriminator: the app first-roots iff it is present, else it just provisions the
		// console. Absent for a re-provision of an already-rooted Domain.
		pendingTenant: PendingTenantRefSchema.optional(),
		// Present only on an ADMIN-ENROLL invite blob: the seed for the in-person mutual 6-digit
		// compare the friend runs AFTER first-root (see EnrollHandshakeRef). Absent for a plain
		// provision / re-provision.
		enrollHandshake: EnrollHandshakeRefSchema.optional(),
		// evie's public nonce-gated device-approval ingress, the reach a fresh device POSTs its
		// join/fetch to in the "Add a device" self-enroll. A held device stamps it into the
		// authorize-console QR; absent means this network has no public ingress and the Add-a-device
		// entry is shown disabled.
		deviceApprovalReach: z.string().optional(),
	})
	.meta({ id: "Provisioning" });

////////////////////////////////
//  Gateway bootstrap bundle (Console -> creds-less Gateway, LAN/paste delivered)
//
//  The owner Console mints this for a Gateway it just admitted and seals it to the
//  Gateway's box key (so plain-HTTP LAN delivery or a pasted blob stays confidential
//  and tamper-evident). It never crosses evie: the Console carries it to the Gateway
//  directly. `transport` is the same SA-token-over-service-proxy shape the Console
//  uses, so one credential mechanism serves both member kinds. `admission` is this
//  Gateway's own owner-signed admission; `domain` mirrors the keyring so the Gateway
//  can verify peers from its first boot.

export const GatewayBootstrapBundleSchema = z
	.object({
		// Echoes the one-time nonce from the admit-gateway QR; the Gateway installs the
		// bundle only if it matches the listener it opened, so a bundle cannot be
		// replayed into a later enrollment window.
		nonce: z.string().min(1),
		transport: GatewayTransportSchema,
		admission: SignedAdmissionSchema,
		domain: DomainSnapshotSchema,
		// the network this gateway joins; the gateway records it so it resolves the same Domain on its next boot
		domainId: z.string().min(1).max(64).optional(),
	})
	.meta({ id: "GatewayBootstrapBundle" });

export type GatewayBootstrapBundle = z.infer<typeof GatewayBootstrapBundleSchema>;

////////////////////////////////
//  Gateway bootstrap delivery frame (the sealed wrapper on the wire)
//
//  What the Console POSTs to the Gateway's LAN listener (or hands over as paste). The
//  Gateway verifies the seal against `signerSignPub`, opens it with its box key, then
//  pins the owner key from the enclosed snapshot. Trust-on-first-use gated by the SAS
//  the human confirmed, the one-time nonce, and LAN proximity.

export const GatewayBootstrapFrameSchema = z
	.object({
		v: z.number().int().positive(),
		signerSignPub: z.string().min(1),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "GatewayBootstrapFrame" });
