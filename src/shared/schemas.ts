import { z } from "zod";
import { DomainSnapshotSchema, SignedAdmissionSchema } from "./admission.js";
import { b64Field, slugField } from "./crypto.js";
import { SignedFirstRootSchema } from "./enrollment.js";
import { SignedXDomainLinkSchema } from "./federation-protocol.js";

////////////////////////////////
//  Shared enum schemas
//
//  The single truth for the wire enums; the TS types in types.ts derive from
//  these via z.infer. Decode-side tolerance note: these closed enums validate
//  what OUR side composes or what a closed protocol surface accepts. Fields a
//  console DECODES (e.g. MailboxEntry.request_type) stay open strings, per the
//  additive decode-tolerance rule.

export const ConnectionModeSchema = z.enum(["cli", "channel"]).meta({ id: "ConnectionMode" });
export const EffortLevelSchema = z.enum(["simple", "standard", "complex"]).meta({ id: "EffortLevel" });
export const RequestTypeSchema = z.enum(["feature", "bugfix", "question"]).meta({ id: "RequestType" });
export const TeamKindSchema = z.enum(["devcontainer", "loose", "console", "gateway"]).meta({ id: "TeamKind" });
export const ResponseStatusSchema = z
	.enum(["completed", "clarification", "deferred", "needs_human", "error", "timeout", "running"])
	.meta({ id: "ResponseStatus" });
// Whether a console's Domain is rooted yet. `unrooted` is a fresh, never-provisioned home (no
// owner, no pending tenant); `pending` is an operator-staged tenant the friend has not yet
// first-rooted; `rooted` just provisions the console. Mirrors evie's getDomainStatus 3-value
// union. The gateway register reply only ever carries `rooted`/`unrooted` (a pending Domain has
// no gateway to register against); `pending` reaches the app via the provisioning blob's
// `pendingTenant` instead. Decode-side this stays an open String in Kotlin.
export const DomainStatusSchema = z.enum(["unrooted", "pending", "rooted"]).meta({ id: "DomainStatus" });

////////////////////////////////
//  Channel Reply Schema
//
//  Channel-mode conversations are streams: the conversation stays open for the
//  life of the process, and the agent can reply any number of times. There is
//  no status because there is no "end". Every reply is just another message in
//  the stream.

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
//  Validates the register message at the bridge WebSocket boundary - the one
//  message where a blind-cast team name could key the registry on undefined.
//  mode stays an open string (the handler maps anything non-"channel" to
//  "cli", tolerant of future modes).

export const WsRegisterSchema = z.object({
	type: z.literal("register"),
	team: z.string().min(1).max(64),
	mode: z.string().optional(),
	subId: z.string().optional(),
	conversationId: z.string().optional(),
	// The plugin version (package.json) the MCP process is running. Optional so an
	// older plugin that predates this field still registers cleanly.
	version: z.string().optional(),
	// Shared secret the host daemon presents so a LAN peer cannot squat the reserved
	// "host" slot and drive agent terminals. Optional + only enforced when the gateway
	// has HOST_WS_TOKEN set (coexistence: an un-configured deploy is unchanged).
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
		// Gateways' identically-named sessions apart. Optional for decode tolerance:
		// a pre-federation Gateway omits it and the console falls back to its connected
		// Gateway id (bare resolves local).
		gatewayId: z.string().optional(),
		// The Domain id of the Gateway that owns this session. A gateway id is unique only
		// within a Domain, so the full (domainId, gatewayId) pair is what addresses a
		// session unambiguously: two linked friend Domains may run a gateway whose id
		// collides with the local or each other's. The local listing stamps the local
		// Domain id; a cross-Domain discovery entry is tagged with the peer's Domain id.
		// Optional for decode tolerance: a pre-federation Gateway omits it and consumers
		// fall back to the home Domain.
		domainId: z.string().optional(),
		// The friendly NETWORK display name of the Domain that owns this session, propagated
		// over the discovery roster so a linked friend Domain shows the owner's self-set label
		// (e.g. "Carol") instead of a local alias. Optional/nullable for decode tolerance: a
		// pre-feature Gateway omits it and consumers fall back to the domainId / a local label.
		operatorName: z.string().nullish(),
		status: z.enum(["online", "available"]),
		mode: ConnectionModeSchema.optional(),
		// Optional for decode tolerance: old gateways omit kind and consumers
		// default it to "loose" (the hand Kotlin client always did).
		kind: TeamKindSchema.optional(),
		// The plugin version the agent's MCP process reported at register. Optional:
		// consoles, offline-catalog entries, and pre-feature gateways omit it. The
		// console shows it as a chip only when it differs from the app's own expected
		// version - a benign, self-correcting lag (the host auto-updates daily).
		version: z.string().optional(),
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

export const ConsoleOpSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("register"),
			// Build identity for server-side observability: the gateway logs these at
			// register so the operator never has to guess which build (and debug-vs-
			// release variant) a console is running. Optional + additive: an older console
			// that omits them still registers.
			clientVersion: z.string().max(64).optional(),
			clientVariant: z.string().max(16).optional(),
		}),
		// First-root a PENDING (rootless) Domain at the friend's silently-generated owner key.
		// A pending Domain has NO gateway, so first-rooting does NOT travel this op: the app
		// learns it is pending plus the one-time invite nonce from the provisioning blob's
		// `pendingTenant` (a register reply can never report pending - a sealed register to a
		// gateway-less pending Domain 503s before any reply), then POSTs the SignedFirstRoot
		// DIRECTLY to evie's console-bridge firstRoot intake. This gateway-side variant is a
		// defensive reject: a gateway only exists once the Domain is already rooted, so a
		// first_root reaching it is rejected (the Domain is past rooting).
		z.object({ kind: z.literal("first_root"), firstRoot: SignedFirstRootSchema }),
		z.object({ kind: z.literal("list_teams") }),
		z.object({
			kind: z.literal("send"),
			to: z.string().min(1).max(128),
			// The Domain id of the target session, present only for a cross-Domain send (a session
			// from a linked friend Domain). A gateway id is unique only within a Domain, so the
			// gateway resolves the seal target by the full (domainId, gatewayId) pair when this is
			// set; absent (or the local Domain) keeps the existing home/cross-Gateway resolution.
			domainId: z.string().min(1).max(64).optional(),
			request_type: RequestTypeSchema.optional(),
			effort: z.enum(["simple", "standard", "complex", "auto"]).optional(),
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
			// the poll reply only when it differs, so the Console stays fresh within one poll
			// cycle at near-zero steady cost.
			knownDomainVersion: z.string().optional(),
		}),
		// Fetch the home Gateway's bootstrap transport creds (the gateway-bridge SA + token) so
		// the Console can seal them into a bundle for a creds-less Gateway it is enrolling. No
		// params: the Gateway returns its own bootstrap transport. Replaces carrying these creds
		// in the provisioning blob.
		z.object({ kind: z.literal("get_gateway_transport") }),
		// Capture an agent's VISIBLE tmux pane for the console terminal view. `target` is the
		// gateway-qualified session name; the gateway resolves it to the host-agent's own
		// tmux or a devcontainer and relays to the host daemon. `sinceHash` lets the console
		// skip an unchanged frame (the result returns unchanged=true with no ansi). (Scrollback
		// browsing is deferred: a per-request line count would be an unbounded cache/exec key.)
		z.object({
			kind: z.literal("peek"),
			target: z.string().min(1).max(128),
			sinceHash: z.string().max(64).optional(),
		}),
		// Send input to an agent's tmux pane: a literal text line (sent with a trailing Enter)
		// OR a single named control key (Enter, Escape, C-c, Up, Down, Left, Right, Tab, BTab).
		// Exactly one of text/key; the gateway whitelists the key name. Idempotent per opId.
		z.object({
			kind: z.literal("tmux_send"),
			target: z.string().min(1).max(128),
			text: z.string().max(4096).optional(),
			key: z.string().max(32).optional(),
		}),
		// Cross-Domain listening-mode handshake (cross-domain-federation.md). These four
		// ops drive the mutual pairing that links two Gateways owned by DIFFERENT owners.
		// The owner root key is phone-held, so each side SIGNS its link on the phone; the
		// Gateway mints/holds the listening window + pin pairing and writes the confirmed
		// peer. The Console only accepts a request while its listening window is open, so
		// there is no unsolicited cross-Domain surface.

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
		// calls this on a short interval while on the link screen: the requester drives the
		// commit-reveal, which lands the pairing on the receiver's window SILENTLY, so this read is
		// the receiver's only path to the SAS + the friend's keys it must owner-sign a link over.
		// Read-only: it does not advance or consume the window. An unknown / expired token returns
		// pairingArrived=false (with expired=true) rather than an error.
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
		// Per-session sharing (cross-domain-federation.md). These three ops manage which of
		// THIS owner's local sessions are offered to a LINKED friend Domain. Checking a share
		// IS the consent (no double-confirm); the friend's agents may then reach the shared
		// session. Only devcontainer/loose sessions may be shared - never the host-agent, the
		// cli host, or a console - which the gateway enforces against its local team registry.
		// Authenticated by the existing console seal (the frame is opened + the signer verified
		// before dispatch), so there is no second signature scheme.

		// Mark a local session shared to a friend Domain. Idempotent on `(sessionTarget,
		// domainId)`: a re-share refreshes the share rather than duplicating it.
		z.object({
			kind: z.literal("cross_domain_share"),
			// The canonical `gateway/name` target of the local session to share.
			sessionTarget: z.string().min(1).max(128),
			// The friend Domain (slug) this session is shared TO. Must be a linked Domain.
			domainId: z.string().min(1).max(64),
		}),
		// Withdraw a local session's share to a friend Domain.
		z.object({
			kind: z.literal("cross_domain_unshare"),
			sessionTarget: z.string().min(1).max(128),
			domainId: z.string().min(1).max(64),
		}),
		// Read this owner's current shares (so the console can render the share checkmarks).
		z.object({ kind: z.literal("cross_domain_list_shares") }),
		// Read the linked friend Domains from the gateway's cross-Domain peer set. Distinct from
		// discovery: a peer is listed the moment it is linked, regardless of whether its gateway is
		// online or has shared anything back, so the freshly-linked peer is visible (and its detail
		// reachable) before any session crosses. Read-only roster; presence comes from discovery.
		z.object({ kind: z.literal("cross_domain_list_peers") }),
		// Unlink a linked friend Domain: drop the LOCAL trust + share state for it (every
		// peer gateway of that Domain, every share offered to it, and any in-flight job bound
		// to it). Keyed by `domainId` (a Domain may run more than one gateway), so the whole
		// Domain is forgotten at once. After this the sealer can no longer resolve that peer,
		// so outbound seals + inbound opens to it fail closed. The owner's phone separately
		// owner-signs + submits the link-edge revocation so the Router drops its relay edge.
		z.object({
			kind: z.literal("cross_domain_unlink"),
			// The friend Domain (slug) to unlink.
			domainId: z.string().min(1).max(64),
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
		// The console's raw Ed25519 signing public key (base64). Selects the key the
		// gateway verifies the seal against, then checked against the owner-signed
		// allowlist (must be an admitted kind:console subject). Cleartext: it is a
		// public key, not a secret. conversationId + device + the op move INSIDE the
		// seal, so evie sees only this opaque blob - it cannot read or forge the op.
		signerSignPub: z.string().min(1),
		// The Gateway this op targets, so evie routes per-target under direct multi-home
		// (the Console seals to each Gateway directly). Plaintext routing metadata, like
		// signerSignPub; absent falls back to evie's latest-Gateway routing (single-home).
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
		conversationId: z.string().min(1).max(128),
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
//  open String (decode-side rule). `request_type` is open even here: the
//  gateway itself composes out-of-union values (e.g. "handoff" on transfer
//  briefs), so a closed enum would reject real traffic.

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
		// console features never parse it back out of the body. Always sent by
		// current gateways; optional for decode tolerance of older wires.
		summary: z.string().optional(),
		body: z.string().optional(),
		// Reply/notice state on the wire (e.g. "running"/"error"). A `sent` echo never
		// carries it: an owner's own outgoing message is always settled (status null).
		status: z.string().optional(),
		replyAsJson: z.record(z.string(), z.unknown()).optional(),
		question: z.string().optional(),
		reason: z.string().optional(),
		request_type: z.string().optional(),
		effort: z.string().optional(),
		is_follow_up: z.boolean().optional(),
		files: ChannelFilesSchema.optional(),
	})
	.meta({ id: "MailboxEntry" });

////////////////////////////////
//  Gateway transport creds (the gateway-bridge SA token + endpoint)
//
//  A dep-free leaf shared by two consumers below: the get_gateway_transport op
//  result (the Console fetches it to enroll a creds-less Gateway) and the
//  GatewayBootstrapBundle it seals. Defined here so both can reference it.

export const GatewayTransportSchema = z
	.object({
		apiUrl: z.string().min(1),
		saToken: z.string().min(1),
		caPem: z.string().min(1),
		appToken: z.string().min(1),
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
		// Gateway and migrates pre-federation bare-keyed threads onto it. Optional
		// for decode tolerance of a pre-federation Gateway.
		gatewayId: z.string().optional(),
		// Current mailbox high-water seq so a reconnecting console can resync its cursor.
		cursor: z.number().int().nonnegative(),
		// Mailbox instance id. If it differs from the console's stored epoch, the
		// mailbox was recreated and the console must reset its cursor to 0.
		epoch: z.number().int().nonnegative(),
		// Whether this console's Domain is rooted yet, as the connected gateway sees it. A
		// gateway only exists for a Domain that is already past rooting, so this register reply
		// only ever reports `rooted` (or `unrooted` for a fresh, never-provisioned home); it can
		// NEVER report `pending`, because a pending Domain has no gateway to register against. The
		// pending case is learned earlier, from the provisioning blob's `pendingTenant`, and the
		// app first-roots DIRECTLY against evie. Optional for decode tolerance: a pre-feature
		// Gateway omits it and the app treats the Domain as already rooted (the legacy path).
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

export const ConsoleGatewayTransportResultSchema = z
	.object({
		transport: GatewayTransportSchema,
	})
	.meta({ id: "ConsoleGatewayTransportResult" });

export const ConsolePeekResultSchema = z
	.object({
		// The captured pane, ANSI-colored. Absent when unchanged (the console's sinceHash
		// matched), so an idle terminal costs only the hash round-trip.
		ansi: z.string().optional(),
		// Short content hash of the pane; the console sends it back as sinceHash next cycle.
		hash: z.string(),
		unchanged: z.boolean().optional(),
	})
	.meta({ id: "ConsolePeekResult" });

export const ConsoleTmuxSendResultSchema = z
	.object({
		sent: z.boolean(),
	})
	.meta({ id: "ConsoleTmuxSendResult" });

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
// pairing arrives it carries only pairingArrived=false (+ the window's expiry, or expired=true
// once the window is gone). Once the requester's commit-reveal lands the pairing, it carries the
// SAS the receiver computed (the same 12-digit value the requester sees) plus the friend's keys
// the receiver phone must owner-sign its link over: the four friend* keys + the friend Domain /
// Gateway ids. The phone transitions to the type-the-code compare on pairingArrived.
export const CrossDomainListenStateResultSchema = z
	.object({
		// True once a requester paired against this window (the SAS + friend keys are then present).
		pairingArrived: z.boolean(),
		// The requester-minted rendezvous pin (present only when arrived). The receiver passes it
		// back to cross_domain_confirm so the gateway resolves this window's pairing (the receiver
		// never minted it; it learns it here, E2E sealed). Single-use, consumed at confirm.
		pin: z.string().optional(),
		// The 12-digit safety code, present only when pairingArrived. Identical to the requester's
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

// One share row in a list_shares result: a local session offered to one friend Domain.
// Named (.meta id) so the codegen emits it as a Kotlin nested class instead of erroring
// on an inline array-of-object.
export const CrossDomainShareEntrySchema = z
	.object({
		sessionTarget: z.string(),
		domainId: z.string(),
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
	ConsoleGatewayTransportResultSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
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
//  The blob the user pastes at console setup. Credentials + endpoints only;
//  user taste lives in prefs. Runtime defaulting stays app-side (device from
//  Build.MODEL, conversationId minting a UUID, trimEnd('/') URL normalization)
//  - the schema carries the shape, the Kotlin wrapper owns those behaviors.

// The pending-Domain discriminator carried inside a provisioning blob. Present iff the blob is
// for a PENDING (unrooted) Domain - both a friend invite AND the operator's own fresh-home
// (R1) setup. A pending Domain has no gateway, so the app cannot learn it is pending from a
// register reply; it reads this off the blob and first-roots DIRECTLY against evie with the
// nonce. Absent for a re-provision of an already-rooted Domain (which just provisions the
// console). Named (.meta id) so the codegen emits it as a nested Kotlin class.
export const PendingTenantRefSchema = z
	.object({
		// The opaque pending Domain id the friend's first_root roots.
		domainId: slugField(),
		// The one-time invite nonce (base64) evie checks unspent before rooting.
		nonce: b64Field(),
	})
	.meta({ id: "PendingTenantRef" });

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
		conversationId: z.string().optional(),
		// STTS (TTS playback) creds. DEVICE-OWNED now: entered in the app's Voice settings and
		// persisted on the phone, NOT emitted by provisioning. Kept optional only so the app's
		// one-release blob->settings migration can read a legacy hand-pasted blob; do not re-add
		// these to the provisioning blob writer.
		sttsUrl: z.string().optional(),
		sttsKey: z.string().optional(),
		// Console identity: a JSON-encoded Crypto.Identity ({sign,box} keypairs) minted
		// AND admitted by provision-console.sh --setup. When present, the app imports it
		// on provision and is enrolled from the blob alone - no separate enroll/QR step.
		// Absent for a legacy blob (the app then needs an interactive enroll).
		identity: z.string().optional(),
		// The home Gateway's id + public keys, also set by provision-console.sh --setup.
		// The app seals its FIRST op (register is itself sealed) TO the Gateway's box key,
		// so it must hold these before connecting - the admit-gateway scan used to deliver
		// them. With these in the blob, no admit-gateway step is needed either.
		gatewayId: z.string().optional(),
		gatewaySignPub: z.string().optional(),
		gatewayBoxPub: z.string().optional(),
		// Set only for a PENDING (unrooted) Domain blob (a friend invite or the operator's own
		// fresh-home setup): the pending Domain id + the one-time invite nonce. Its presence is
		// the discriminator - the app first-roots (POSTs the SignedFirstRoot to evie with this
		// nonce) iff it is present, else it just provisions the console. Absent for a re-provision
		// of an already-rooted Domain.
		pendingTenant: PendingTenantRefSchema.optional(),
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
	})
	.meta({ id: "GatewayBootstrapBundle" });

export type GatewayBootstrapBundle = z.infer<typeof GatewayBootstrapBundleSchema>;

////////////////////////////////
//  Gateway bootstrap delivery frame (the sealed wrapper on the wire)
//
//  What the Console POSTs to the Gateway's LAN listener (or hands over as paste). The
//  Gateway verifies the seal against `signerSignPub`, opens it with its box key, then
//  pins the owner key from the enclosed snapshot - trust-on-first-use gated by the SAS
//  the human confirmed, the one-time nonce, and LAN proximity.

export const GatewayBootstrapFrameSchema = z
	.object({
		v: z.number().int().positive(),
		signerSignPub: z.string().min(1),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "GatewayBootstrapFrame" });
