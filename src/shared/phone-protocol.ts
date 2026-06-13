import type { z } from "zod";
import type {
	MailboxEntrySchema,
	PhoneListTeamsResultSchema,
	PhoneOpResultSchema,
	PhoneOpSchema,
	PhonePollResultSchema,
	PhoneRegisterResultSchema,
	PhoneRelayFrameSchema,
	PhoneRelayReplySchema,
	PhoneRespondResultSchema,
	PhoneSendResultSchema,
} from "./schemas.js";

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

export type PhoneRelayFrame = z.infer<typeof PhoneRelayFrameSchema>;
export type PhoneRelayReply = z.infer<typeof PhoneRelayReplySchema>;

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
export const NOTICE_SESSION_PREFIX = "notice:";

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
export const CONV_SESSION_PREFIX = "conv:";

export function composeConvSessionId(conversationId: string, team: string): string {
	return `${CONV_SESSION_PREFIX}${conversationId}:${team}`;
}

/** The target team of a conv session id, or null if the id is not a conv. */
export function parseConvSessionTeam(sessionId: string): string | null {
	if (!sessionId.startsWith(CONV_SESSION_PREFIX)) return null;
	return sessionId.slice(sessionId.lastIndexOf(":") + 1) || null;
}

////////////////////////////////
//  Mailbox

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxEntryKind = MailboxEntry["kind"];
export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
