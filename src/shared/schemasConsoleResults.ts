import { z } from "zod";
import { DomainSnapshotSchema } from "./admission.js";
import { BoardEntrySchema } from "./schemasBoard.js";
import { CrossDomainShareTargetSchema, MailboxEntrySchema, SealedEnvelopeSchema } from "./schemasConsoleOp.js";
import { DomainStatusSchema } from "./schemasCore.js";
import {
	CrossDomainPeerEntrySchema,
	CrossDomainPresenceEntrySchema,
	LinkedPeersVersionSchema,
	PresenceVersionSchema,
	ReadAnchorsVersionSchema,
	ReadAnchorWireEntrySchema,
	TaskBoardVersionSchema,
	TeamInfoSchema,
} from "./schemasPresence.js";

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
		// Router register; the app then treats the Domain as already rooted.
		domainStatus: DomainStatusSchema.optional(),
	})
	.meta({ id: "ConsoleRegisterResult" });

/** How complete a mesh fan-out's answer is. A partial result must say so: without this, a peer
 * that could not be asked is indistinguishable from a peer with nothing to say, and its sessions
 * are swept as absent. `rosterKnown: false` means the peer list itself was unreadable (not
 * registered with the Router, or the roster call failed), so `asked` says nothing about the mesh. */
export const DiscoverCoverageSchema = z
	.object({
		rosterKnown: z.boolean(),
		asked: z.number().int().nonnegative(),
		answered: z.number().int().nonnegative(),
		// Same-Domain gateway ids that were asked and did not answer.
		unreachable: z.array(z.string().max(64)).max(64).optional(),
		// Linked-friend gateways that did not answer, as "domainId/gatewayId".
		unreachablePeers: z.array(z.string().max(130)).max(64).optional(),
	})
	.meta({ id: "DiscoverCoverage" });

export const ConsoleListTeamsResultSchema = z
	.object({
		teams: z.array(TeamInfoSchema),
		// Optional: absent from an older gateway, which claims nothing about completeness.
		coverage: DiscoverCoverageSchema.optional(),
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
		// True only when the pull PROVED the bytes exist nowhere: every named holder answered and had
		// nothing, and the asked Gateway holds nothing either. What lets a client retire a fetch that
		// can never succeed. Optional so an older Gateway simply never says it.
		absent: z.boolean().optional(),
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
