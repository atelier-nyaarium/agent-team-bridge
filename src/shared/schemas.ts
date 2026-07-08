import { z } from "zod";
import { DomainSnapshotSchema, SignedAdmissionSchema } from "./admission.js";
import { b64Field, slugField } from "./crypto.js";
import { SignedFirstRootSchema } from "./federation-lifecycle.js";
import { SignedXDomainLinkSchema } from "./federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
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
//  Channel Reply Schema
//
//  Channel-mode conversations are streams: the conversation stays open for the
//  life of the process and the agent can reply any number of times. There is no
//  status because there is no end.

export const ChannelReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		respondAsMarkdownString: z
			.string()
			.optional()
			.describe(
				`Your prose reply for the HUMAN to read, as a markdown string - put your message here. It renders as fully-featured markdown (headings, lists, tables, fenced code) AND mermaid diagrams, so use them when they help. Lead with the answer itself: no lead-in labels ("Short answer:", "TLDR:") and no restating the question; replies often render on a console. Mutually exclusive with respondAsStructuredData.`,
			),
		respondAsStructuredData: z
			.string()
			.optional()
			.describe(
				`Your structured reply, as a JSON string (object/array). Use ONLY when the request specifies a Reply Schema; pass valid JSON matching it. For ordinary prose use respondAsMarkdownString instead. Mutually exclusive with respondAsMarkdownString.`,
			),
		title: z
			.string()
			.optional()
			.describe(
				`Optional one-line headline (a few words) for this reply - shown in the notification bar and read as the shortest text-to-speech tier. Add it when prettifying a substantial reply; omit for a short or plain one. respondAsMarkdownString stays the full body.`,
			),
		summary: z
			.string()
			.optional()
			.describe(
				`Optional short summary (a few sentences) of this reply, read as the medium text-to-speech tier. Omit for a short or plain reply.`,
			),
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach to this reply (e.g. screenshots, logs). Images render inline on the console; other files appear as download chips.`,
			),
	})
	.strict()
	.refine((data) => !(data.respondAsMarkdownString && data.respondAsStructuredData), {
		message: "Provide respondAsMarkdownString or respondAsStructuredData, not both.",
	});

export type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;

////////////////////////////////
//  Channel File Schema (inbound from evie-bot bridge)
//
//  Owned by evie-protocol.ts (the self-contained module synced into
//  evie-bot); re-exported here so the console-protocol schemas and existing
//  importers keep one import surface.

import { ChannelFilesSchema } from "./evie-protocol.js";

export { ChannelFileSchema, ChannelFilesSchema } from "./evie-protocol.js";

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
		// The plugin version the agent's MCP process reported at register. Absent for
		// consoles and offline-catalog entries (no plugin process behind them). The console
		// shows it as a chip only when it differs from the app's own expected version.
		version: z.string().optional(),
		// Epoch ms a session was last seen (from the session-resume map). Stamped for
		// sessions the gateway has a resume entry for, so the console can order the list and
		// show recency ("active 5m ago"). Absent for sessions with no resume record.
		lastActive: z.number().int().optional(),
		queue_depth: z.number().int().nonnegative(),
	})
	.meta({ id: "TeamInfo" });

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

export const ConsoleOpSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("register"),
			// Build identity for server-side observability: the gateway logs these at
			// register so the admin can see which build and variant a console runs.
			// Optional and additive: an older console that omits them still registers.
			clientVersion: z.string().max(64).optional(),
			clientVariant: z.string().max(16).optional(),
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
			holdMs: z.number().int().nonnegative().max(45_000).optional(),
			// The keyring version the Console last synced; the Gateway returns the snapshot in
			// the poll reply only when it differs, so the Console stays fresh at near-zero cost.
			knownDomainVersion: z.string().optional(),
		}),
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
		// (Enter, Escape, C-c, Up, Down, Left, Right, Tab, BTab). Exactly one of text/key; the gateway
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
		kind: z.enum(["message", "reply", "notice", "sent"]),
		session_id: z.string(),
		from: z.string().optional(),
		// The originating send's opId on a `sent` echo (an owner's own outgoing message
		// mirrored to all their devices). The sending device matches it to its optimistic
		// row and settles it instead of double-rendering; other devices render it fresh.
		opId: z.string().optional(),
		// Notification-bar line for notices; the body carries the full report.
		title: z.string().optional(),
		// The Short tier of a notice (4-6 sentences), addressable on its own so
		// console features never parse it back out of the body. Present on notices;
		// absent on a plain reply or a `sent` echo.
		summary: z.string().optional(),
		body: z.string().optional(),
		// Reply/notice state on the wire (e.g. "running"/"error"). A `sent` echo never
		// carries it: an owner's own outgoing message is always settled (status null).
		status: z.string().optional(),
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		question: z.string().optional(),
		reason: z.string().optional(),
		files: ChannelFilesSchema.optional(),
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

// One peer row in a list_peers result: a linked friend Domain projected from the gateway's
// cross-Domain peer set. A Domain may run more than one gateway, so the same domainId can repeat
// once per gateway; the console groups by domainId. Named (.meta id) so the codegen emits it as a
// Kotlin nested class instead of erroring on an inline array-of-object.
export const CrossDomainPeerEntrySchema = z
	.object({
		domainId: z.string(),
		gatewayId: z.string(),
		// The friend OWNER's signing key (base64) - the owner-keyed identity the Users surface joins on
		// (a roster row is keyed by owner, so this maps a linked Domain back to the person who owns it).
		ownerSignPub: z.string(),
	})
	.meta({ id: "CrossDomainPeerEntry" });

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

export const ConsoleOpResultSchema = z.union([
	ConsoleRegisterResultSchema,
	ConsoleListTeamsResultSchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
	ConsolePollResultSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleForgetResultSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleRenameSessionResultSchema,
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
