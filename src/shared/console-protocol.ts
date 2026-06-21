import type { z } from "zod";
import type {
	ConsoleListTeamsResultSchema,
	ConsoleOpEnvelopeSchema,
	ConsoleOpResultSchema,
	ConsoleOpSchema,
	ConsolePeekResultSchema,
	ConsolePollResultSchema,
	ConsoleRegisterResultSchema,
	ConsoleRelayFrameSchema,
	ConsoleRelayReplySchema,
	ConsoleReplyBodySchema,
	ConsoleRespondResultSchema,
	ConsoleSendResultSchema,
	ConsoleTmuxSendResultSchema,
	MailboxEntrySchema,
	SealedEnvelopeSchema,
} from "./schemas.js";
// The session-id grammar constants are OWNED by session-id.ts now; imported for
// the wire helpers below and re-exported so existing importers of this module
// (codegen, host-id, un-migrated callers) keep resolving from here.
import { CONV_SESSION_PREFIX, GATEWAY_QUALIFIER_SEP, NOTICE_SESSION_PREFIX } from "./session-id.js";

export { CONV_SESSION_PREFIX, GATEWAY_QUALIFIER_SEP, NOTICE_SESSION_PREFIX };

////////////////////////////////
//  Console bridge protocol
//
//  The Android app reaches the gateway through evie, which relays opaque
//  envelopes between the console connection and the existing gateway<->evie
//  WebSocket. Evie understands none of these shapes; it pipes by (device, opId).
//  All console/chat semantics live in the gateway.
//
//  The wire SHAPES live as zod schemas in shared/schemas.ts (the single
//  truth); this module derives the TS types from them and owns the protocol
//  CONSTANTS and session-id grammars. The Kotlin side consumes generated
//  types + constants from scripts/codegen-kotlin.ts.

export const CONSOLE_PROTOCOL_VERSION = 1;

////////////////////////////////
//  Ops (console -> gateway)

export type ConsoleOp = z.infer<typeof ConsoleOpSchema>;
export type ConsoleOpKind = ConsoleOp["kind"];
export type ConsoleRegisterOp = Extract<ConsoleOp, { kind: "register" }>;
export type ConsoleListTeamsOp = Extract<ConsoleOp, { kind: "list_teams" }>;
export type ConsoleSendOp = Extract<ConsoleOp, { kind: "send" }>;
export type ConsoleRespondOp = Extract<ConsoleOp, { kind: "respond" }>;
export type ConsolePollOp = Extract<ConsoleOp, { kind: "poll" }>;
export type ConsolePeekOp = Extract<ConsoleOp, { kind: "peek" }>;
export type ConsoleTmuxSendOp = Extract<ConsoleOp, { kind: "tmux_send" }>;

////////////////////////////////
//  Relay frames (carried over the gateway<->evie WebSocket)
//
//  The wire frame is sealed: only opId + signerSignPub are cleartext, the op rides
//  inside `sealed` as a ConsoleOpEnvelope. The gateway opens the seal into an
//  OpenedConsoleFrame (the flattened op + its verified signer) before dispatch, and
//  seals a ConsoleReplyBody back. evie sees neither.

export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;
export type ConsoleRelayFrame = z.infer<typeof ConsoleRelayFrameSchema>;
export type ConsoleOpEnvelope = z.infer<typeof ConsoleOpEnvelopeSchema>;
export type ConsoleRelayReply = z.infer<typeof ConsoleRelayReplySchema>;
export type ConsoleReplyBody = z.infer<typeof ConsoleReplyBodySchema>;

/** An inbound console op AFTER the gateway has opened + verified its seal: the
 * flattened op carried by the envelope plus the cleartext correlation/signer. The
 * handler operates on this, never on the raw sealed frame. */
export interface OpenedConsoleFrame {
	opId: string;
	signerSignPub: string;
	/** The Domain owner that admitted this console (the allowlist root). All of an
	 * owner's devices resolve to the same value, which keys their shared inbox. */
	ownerSignPub: string;
	conversationId: string;
	device: string;
	op: ConsoleOp;
}

////////////////////////////////
//  Op results (gateway -> console)

export type ConsoleRegisterResult = z.infer<typeof ConsoleRegisterResultSchema>;
export type ConsoleListTeamsResult = z.infer<typeof ConsoleListTeamsResultSchema>;
export type ConsoleSendResult = z.infer<typeof ConsoleSendResultSchema>;
export type ConsoleRespondResult = z.infer<typeof ConsoleRespondResultSchema>;
export type ConsolePollResult = z.infer<typeof ConsolePollResultSchema>;
export type ConsolePeekResult = z.infer<typeof ConsolePeekResultSchema>;
export type ConsoleTmuxSendResult = z.infer<typeof ConsoleTmuxSendResultSchema>;
export type ConsoleOpResult = z.infer<typeof ConsoleOpResultSchema>;

////////////////////////////////
//  Session-id grammars
//
//  Two grammars cross the language boundary; both constants are emitted into
//  the generated Kotlin so the console never hand-mirrors them.

// Broadcast notices: the console parses the sender out of the session id to
// thread the notice under the sender's name. Never respondable.
export function noticeSessionId(from: string): string {
	return `${NOTICE_SESSION_PREFIX}${from}`;
}

/** The sender of a notice session id, or null if the id is not a notice. */
export function parseNoticeSession(sessionId: string): string | null {
	return sessionId.startsWith(NOTICE_SESSION_PREFIX) ? sessionId.slice(NOTICE_SESSION_PREFIX.length) : null;
}

// Channel conversations: one string serves as the pending-job store key, the
// wire session_id, and the console's thread-attribution tail-parse. The tail
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
//  Gateway qualification
//
//  A session's address is host-qualified as `<gatewayId>/<name>` so the console (and,
//  in later federation phases, evie) can tell two Gateways' identically-named
//  sessions apart. A BARE name (no separator) resolves to the local Gateway: the
//  gateway canonicalizes an inbound target to the qualified form before keying
//  the channel job, and the console normalizes a bare name off the wire to its
//  connected Gateway. The separator is emitted into the generated Kotlin so the
//  console never hand-mirrors it. Gateway ids and local names never contain the
//  separator, so the FIRST separator splits Gateway id from name unambiguously.

/** Qualify a bare local name under a Gateway id; a name that is already qualified
 * (contains the separator) is returned unchanged. */
export function qualifyTeam(gatewayId: string, name: string): string {
	return name.includes(GATEWAY_QUALIFIER_SEP) ? name : `${gatewayId}${GATEWAY_QUALIFIER_SEP}${name}`;
}

/** Split a (possibly qualified) team into its Gateway id and local name. A bare name
 * yields a null gatewayId (caller resolves it to the local Gateway). */
export function parseQualifiedTeam(team: string): { gatewayId: string | null; name: string } {
	const i = team.indexOf(GATEWAY_QUALIFIER_SEP);
	if (i === -1) return { gatewayId: null, name: team };
	return { gatewayId: team.slice(0, i), name: team.slice(i + 1) };
}

////////////////////////////////
//  Mailbox

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxEntryKind = MailboxEntry["kind"];
export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
