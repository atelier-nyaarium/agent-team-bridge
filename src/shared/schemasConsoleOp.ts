import { z } from "zod";
import { ChannelFilesSchema } from "./channel-file.js";
import { SignedFirstRootSchema } from "./federation-lifecycle.js";
import { SignedXDomainLinkSchema } from "./federation-protocol.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { BlobGetOpSchema, BlobPutOpSchema, BlobStatOpSchema } from "./schemasBlob.js";
import {
	BOARD_ATTACHMENTS_MAX,
	BOARD_BATCH_MAX,
	BOARD_BODY_MAX,
	BOARD_RANK_MAX,
	BoardAttachmentSchema,
	BoardEntrySchema,
} from "./schemasBoard.js";
import { EnabledPluginSchema } from "./schemasCapability.js";
import {
	CrossDomainPresenceKnownVersionSchema,
	FocusIntentSchema,
	LinkedPeersVersionSchema,
	PresenceVersionSchema,
	ReadAnchorsVersionSchema,
	TaskBoardVersionSchema,
} from "./schemasPresence.js";

////////////////////////////////
//  Console Relay Frame Schema
//
//  Validates console_relay frames at the gateway trust boundary. The frame body
//  is console-authored and the Router relays it opaquely, so the gateway must not
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
		// and POSTs the SignedFirstRoot directly to the Router's console-bridge firstRoot intake.
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
			// WHICH host spawn point's filesystem to browse. Absent means the host's own, so a console
			// that predates this keeps the behaviour it always had. A `windows` spawn point is browsed
			// by Windows itself, and its paths are `C:/...` with forward slashes, since backslash stays
			// in the forbidden set for every path on this wire.
			spawn: z.string().min(1).max(64).optional(),
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
		// conversationId, device, and the op move inside the seal, so the Router sees only this
		// opaque blob and cannot read or forge the op.
		signerSignPub: z.string().min(1),
		// The Gateway this op targets, so the Router routes per-target (the Console seals to each
		// Gateway directly). Plaintext routing metadata, like signerSignPub; absent falls back to
		// the Router's latest-Gateway routing.
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
		files: ChannelFilesSchema.optional(),
		// A `plugin_action` entry only: which plugin, which action, and its opaque payload. Routed
		// by the console to a plugin-claimed handler instead of being rendered as a chat message.
		pluginId: z.string().optional(),
		actionType: z.string().optional(),
		payload: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "MailboxEntry" });
