import { z } from "zod";
import { DomainSnapshotSchema, SignedAdmissionSchema } from "./admission.js";

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
		z.object({ kind: z.literal("list_teams") }),
		z.object({
			kind: z.literal("send"),
			to: z.string().min(1).max(128),
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
		kind: z.enum(["message", "reply", "notice"]),
		session_id: z.string(),
		from: z.string().optional(),
		// Notification-bar line for notices; the body carries the full report.
		title: z.string().optional(),
		// The Short tier of a notice (4-6 sentences), addressable on its own so
		// console features never parse it back out of the body. Always sent by
		// current gateways; optional for decode tolerance of older wires.
		summary: z.string().optional(),
		body: z.string().optional(),
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

export const ConsoleOpResultSchema = z.union([
	ConsoleRegisterResultSchema,
	ConsoleListTeamsResultSchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
	ConsolePollResultSchema,
	ConsoleGatewayTransportResultSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
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
