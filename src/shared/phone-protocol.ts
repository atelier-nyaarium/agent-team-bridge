import type { z } from "zod";
import type {
	MailboxEntrySchema,
	PhoneListTeamsResultSchema,
	PhoneOpEnvelopeSchema,
	PhoneOpResultSchema,
	PhoneOpSchema,
	PhonePollResultSchema,
	PhoneRegisterResultSchema,
	PhoneRelayFrameSchema,
	PhoneRelayReplySchema,
	PhoneReplyBodySchema,
	PhoneRespondResultSchema,
	PhoneSendResultSchema,
	SealedEnvelopeSchema,
} from "./schemas.js";
// The session-id grammar constants are OWNED by session-id.ts now; imported for
// the wire helpers below and re-exported so existing importers of this module
// (codegen, host-id, un-migrated callers) keep resolving from here.
import { CONV_SESSION_PREFIX, HOST_QUALIFIER_SEP, NOTICE_SESSION_PREFIX } from "./session-id.js";

export { CONV_SESSION_PREFIX, HOST_QUALIFIER_SEP, NOTICE_SESSION_PREFIX };

////////////////////////////////
//  Phone bridge protocol
//
//  The Android app reaches the arbiter through evie, which relays opaque
//  envelopes between the phone connection and the existing arbiter<->evie
//  WebSocket. Evie understands none of these shapes; it pipes by (device, opId).
//  All phone/chat semantics live in the arbiter.
//
//  The wire SHAPES live as zod schemas in shared/schemas.ts (the single
//  truth); this module derives the TS types from them and owns the protocol
//  CONSTANTS and session-id grammars. The Kotlin side consumes generated
//  types + constants from scripts/codegen-kotlin.ts.

export const PHONE_PROTOCOL_VERSION = 1;

////////////////////////////////
//  Ops (phone -> arbiter)

export type PhoneOp = z.infer<typeof PhoneOpSchema>;
export type PhoneOpKind = PhoneOp["kind"];
export type PhoneRegisterOp = Extract<PhoneOp, { kind: "register" }>;
export type PhoneListTeamsOp = Extract<PhoneOp, { kind: "list_teams" }>;
export type PhoneSendOp = Extract<PhoneOp, { kind: "send" }>;
export type PhoneRespondOp = Extract<PhoneOp, { kind: "respond" }>;
export type PhonePollOp = Extract<PhoneOp, { kind: "poll" }>;

////////////////////////////////
//  Relay frames (carried over the arbiter<->evie WebSocket)
//
//  The wire frame is sealed: only opId + signerSignPub are cleartext, the op rides
//  inside `sealed` as a PhoneOpEnvelope. The arbiter opens the seal into an
//  OpenedPhoneFrame (the flattened op + its verified signer) before dispatch, and
//  seals a PhoneReplyBody back. evie sees neither.

export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;
export type PhoneRelayFrame = z.infer<typeof PhoneRelayFrameSchema>;
export type PhoneOpEnvelope = z.infer<typeof PhoneOpEnvelopeSchema>;
export type PhoneRelayReply = z.infer<typeof PhoneRelayReplySchema>;
export type PhoneReplyBody = z.infer<typeof PhoneReplyBodySchema>;

/** An inbound phone op AFTER the arbiter has opened + verified its seal: the
 * flattened op carried by the envelope plus the cleartext correlation/signer. The
 * handler operates on this, never on the raw sealed frame. */
export interface OpenedPhoneFrame {
	opId: string;
	signerSignPub: string;
	conversationId: string;
	device: string;
	op: PhoneOp;
}

////////////////////////////////
//  Op results (arbiter -> phone)

export type PhoneRegisterResult = z.infer<typeof PhoneRegisterResultSchema>;
export type PhoneListTeamsResult = z.infer<typeof PhoneListTeamsResultSchema>;
export type PhoneSendResult = z.infer<typeof PhoneSendResultSchema>;
export type PhoneRespondResult = z.infer<typeof PhoneRespondResultSchema>;
export type PhonePollResult = z.infer<typeof PhonePollResultSchema>;
export type PhoneOpResult = z.infer<typeof PhoneOpResultSchema>;

////////////////////////////////
//  Session-id grammars
//
//  Two grammars cross the language boundary; both constants are emitted into
//  the generated Kotlin so the phone never hand-mirrors them.

// Broadcast notices: the phone parses the sender out of the session id to
// thread the notice under the sender's name. Never respondable.
export function noticeSessionId(from: string): string {
	return `${NOTICE_SESSION_PREFIX}${from}`;
}

/** The sender of a notice session id, or null if the id is not a notice. */
export function parseNoticeSession(sessionId: string): string | null {
	return sessionId.startsWith(NOTICE_SESSION_PREFIX) ? sessionId.slice(NOTICE_SESSION_PREFIX.length) : null;
}

// Channel conversations: one string serves as the pending-job store key, the
// wire session_id, and the phone's thread-attribution tail-parse. The tail
// after the LAST colon is the target team (conversation ids never contain
// colons; team names may not either, but last-colon parsing matches the
// Kotlin client's substringAfterLast).
export function composeConvSessionId(conversationId: string, team: string): string {
	return `${CONV_SESSION_PREFIX}${conversationId}:${team}`;
}

/** The target team of a conv session id, or null if the id is not a conv. */
export function parseConvSessionTeam(sessionId: string): string | null {
	if (!sessionId.startsWith(CONV_SESSION_PREFIX)) return null;
	return sessionId.slice(sessionId.lastIndexOf(":") + 1) || null;
}

////////////////////////////////
//  Host qualification
//
//  A session's address is host-qualified as `<hostId>/<name>` so the phone (and,
//  in later federation phases, evie) can tell two Hosts' identically-named
//  sessions apart. A BARE name (no separator) resolves to the local Host: the
//  arbiter canonicalizes an inbound target to the qualified form before keying
//  the channel job, and the phone normalizes a bare name off the wire to its
//  connected Host. The separator is emitted into the generated Kotlin so the
//  phone never hand-mirrors it. Host ids and local names never contain the
//  separator, so the FIRST separator splits host from name unambiguously.

/** Qualify a bare local name under a host; a name that is already qualified
 * (contains the separator) is returned unchanged. */
export function qualifyTeam(host: string, name: string): string {
	return name.includes(HOST_QUALIFIER_SEP) ? name : `${host}${HOST_QUALIFIER_SEP}${name}`;
}

/** Split a (possibly qualified) team into its host and local name. A bare name
 * yields a null host (caller resolves it to the local Host). */
export function parseQualifiedTeam(team: string): { host: string | null; name: string } {
	const i = team.indexOf(HOST_QUALIFIER_SEP);
	if (i === -1) return { host: null, name: team };
	return { host: team.slice(0, i), name: team.slice(i + 1) };
}

////////////////////////////////
//  Mailbox

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxEntryKind = MailboxEntry["kind"];
export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
