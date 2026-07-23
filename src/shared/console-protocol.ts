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
	ConsoleReportReadResultSchema,
	ConsoleRespondResultSchema,
	ConsoleSendResultSchema,
	ConsoleTmuxSendResultSchema,
	CrossDomainCancelResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainListenResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainPeerEntrySchema,
	CrossDomainPresenceEntrySchema,
	CrossDomainRequestResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainShareTargetSchema,
	CrossDomainUnlinkResultSchema,
	CrossDomainUnshareResultSchema,
	MailboxEntrySchema,
	ReadAnchorWireEntrySchema,
	SealedEnvelopeSchema,
} from "./schemas.js";
////////////////////////////////
//  Console bridge protocol
//
//  The Android app reaches the gateway through evie, which relays opaque
//  envelopes by (device, opId) and understands none of these shapes. All
//  console/chat semantics live in the gateway.
//
//  The wire shapes are zod schemas in shared/schemas.ts; this module derives
//  the TS types from them and owns the protocol constants. The session-id
//  grammar lives in session-id.ts. The Kotlin side consumes generated types
//  from codegen-kotlin.ts.

// A diagnostic signal, not a hard compatibility gate: every wire addition here is additive and
// optional, so an older client decoding a newer server's reply (or vice versa) already degrades
// gracefully field-by-field without needing this to change client behavior.
export const CONSOLE_PROTOCOL_VERSION = 2;

////////////////////////////////
//  Ops (console -> gateway)

export type ConsoleOp = z.infer<typeof ConsoleOpSchema>;
export type ConsoleOpKind = ConsoleOp["kind"];
export type CrossDomainShareTarget = z.infer<typeof CrossDomainShareTargetSchema>;
export type CrossDomainPeerEntry = z.infer<typeof CrossDomainPeerEntrySchema>;
export type ReadAnchorWireEntry = z.infer<typeof ReadAnchorWireEntrySchema>;
export type CrossDomainPresenceEntry = z.infer<typeof CrossDomainPresenceEntrySchema>;
export type ConsoleReportReadOp = Extract<ConsoleOp, { kind: "report_read" }>;
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
export type ConsoleReportReadResult = z.infer<typeof ConsoleReportReadResultSchema>;
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
//  Mailbox

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxEntryKind = MailboxEntry["kind"];
export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
