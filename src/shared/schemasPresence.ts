import { z } from "zod";
import { CrossDomainPresenceSessionSchema } from "./federation-protocol.js";
import { ConnectionModeSchema, TeamKindSchema } from "./schemasCore.js";

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
