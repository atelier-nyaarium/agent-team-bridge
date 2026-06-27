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
	CrossDomainCancelResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainListenResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainRequestResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainShareTargetSchema,
	CrossDomainUnlinkResultSchema,
	CrossDomainUnshareResultSchema,
	MailboxEntrySchema,
	SealedEnvelopeSchema,
} from "./schemas.js";
// The session-id grammar constants are owned by session-id.ts; imported for the
// wire helpers below and re-exported so existing importers keep resolving here.
import { CONV_SESSION_PREFIX, GATEWAY_QUALIFIER_SEP, NOTICE_SESSION_PREFIX } from "./session-id.js";

// Composite project<SEP>session grammar + helpers, also owned by session-id.ts; re-exported so
// consoleHandler resolves the whole addressing layer from one place.
export { composeSessionName, DEFAULT_SESSION, parseSessionName, SESSION_SEP } from "./session-id.js";
export { CONV_SESSION_PREFIX, GATEWAY_QUALIFIER_SEP, NOTICE_SESSION_PREFIX };

////////////////////////////////
//  Console bridge protocol
//
//  The Android app reaches the gateway through evie, which relays opaque
//  envelopes by (device, opId) and understands none of these shapes. All
//  console/chat semantics live in the gateway.
//
//  The wire shapes are zod schemas in shared/schemas.ts; this module derives
//  the TS types from them and owns the protocol constants and session-id
//  grammars. The Kotlin side consumes generated types from codegen-kotlin.ts.

export const CONSOLE_PROTOCOL_VERSION = 1;

////////////////////////////////
//  Ops (console -> gateway)

export type ConsoleOp = z.infer<typeof ConsoleOpSchema>;
export type ConsoleOpKind = ConsoleOp["kind"];
export type CrossDomainShareTarget = z.infer<typeof CrossDomainShareTargetSchema>;
export type ConsoleRegisterOp = Extract<ConsoleOp, { kind: "register" }>;
export type ConsoleListTeamsOp = Extract<ConsoleOp, { kind: "list_teams" }>;
export type ConsoleSendOp = Extract<ConsoleOp, { kind: "send" }>;
export type ConsoleRespondOp = Extract<ConsoleOp, { kind: "respond" }>;
export type ConsolePollOp = Extract<ConsoleOp, { kind: "poll" }>;
export type ConsolePeekOp = Extract<ConsoleOp, { kind: "peek" }>;
export type ConsoleTmuxSendOp = Extract<ConsoleOp, { kind: "tmux_send" }>;
export type CrossDomainListenOp = Extract<ConsoleOp, { kind: "cross_domain_listen" }>;
export type CrossDomainRequestOp = Extract<ConsoleOp, { kind: "cross_domain_request" }>;
export type CrossDomainConfirmOp = Extract<ConsoleOp, { kind: "cross_domain_confirm" }>;
export type CrossDomainCancelOp = Extract<ConsoleOp, { kind: "cross_domain_cancel" }>;
export type CrossDomainListenStateOp = Extract<ConsoleOp, { kind: "cross_domain_listen_state" }>;
export type CrossDomainShareOp = Extract<ConsoleOp, { kind: "cross_domain_share" }>;
export type CrossDomainUnshareOp = Extract<ConsoleOp, { kind: "cross_domain_unshare" }>;
export type CrossDomainListSharesOp = Extract<ConsoleOp, { kind: "cross_domain_list_shares" }>;
export type CrossDomainListPeersOp = Extract<ConsoleOp, { kind: "cross_domain_list_peers" }>;
export type CrossDomainUnlinkOp = Extract<ConsoleOp, { kind: "cross_domain_unlink" }>;

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
export type CrossDomainListenResult = z.infer<typeof CrossDomainListenResultSchema>;
export type CrossDomainRequestResult = z.infer<typeof CrossDomainRequestResultSchema>;
export type CrossDomainConfirmResult = z.infer<typeof CrossDomainConfirmResultSchema>;
export type CrossDomainCancelResult = z.infer<typeof CrossDomainCancelResultSchema>;
export type CrossDomainListenStateResult = z.infer<typeof CrossDomainListenStateResultSchema>;
export type CrossDomainShareResult = z.infer<typeof CrossDomainShareResultSchema>;
export type CrossDomainUnshareResult = z.infer<typeof CrossDomainUnshareResultSchema>;
export type CrossDomainListSharesResult = z.infer<typeof CrossDomainListSharesResultSchema>;
export type CrossDomainListPeersResult = z.infer<typeof CrossDomainListPeersResultSchema>;
export type CrossDomainUnlinkResult = z.infer<typeof CrossDomainUnlinkResultSchema>;
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
//  A session's address is host-qualified as `<gatewayId>/<name>` so two Gateways'
//  identically-named sessions stay distinct. A bare name (no separator) resolves
//  to the local Gateway. The separator is emitted into the generated Kotlin so
//  the console never hand-mirrors it. Gateway ids and local names never contain
//  the separator, so the FIRST separator splits Gateway id from name unambiguously.

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
