import type { z } from "zod";
import type {
	BoardAttachmentSchema,
	BoardEntrySchema,
	ConsoleListDirsResultSchema,
	ConsoleOpResultSchema,
	ConsoleOpSchema,
	ConsolePeekResultSchema,
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
	DiscoverCoverageSchema,
	MailboxEntrySchema,
	ReadAnchorWireEntrySchema,
} from "./schemas.js";
////////////////////////////////
//  Console bridge protocol
//
//  The Android app reaches the gateway through the Router, which relays opaque
//  envelopes by (device, opId) and understands none of these shapes. All
//  console/chat semantics live in the gateway.
//
//  The wire shapes are zod schemas in shared/schemas.ts; this module derives
//  the TS types from them and owns the protocol constants. The session-id
//  grammar lives in session-id.ts. The Kotlin side consumes generated types
//  from codegen-kotlin.ts.

// A documented floor, not a negotiated one: no console sends this number and no gateway checks it.
// Additions stay optional and degrade field by field. REMOVING an accepted kind is not additive: it
// bumps this number, docs/console.md records what went, and a console built before the bump gets
// the existing "not allowed" refusal until it updates.
//   3: the nine board_* delivery kinds (the board lives on the Router) and peek as a delivery op.
export const CONSOLE_PROTOCOL_VERSION = 3;

// Shared by consoleHandler.ts's in-memory opCache and durableOpStore.ts's durable record store -
// a durable op can never outnumber the mutating ops that pass through the in-memory cache above
// it, so both caps stay in lockstep off this one constant rather than two independent literals.
export const MAX_OPS_PER_CONVERSATION = 256;

////////////////////////////////
//  Ops (console -> gateway)

export type ConsoleOp = z.infer<typeof ConsoleOpSchema>;
export type ConsoleOpKind = ConsoleOp["kind"];
export type CrossDomainShareTarget = z.infer<typeof CrossDomainShareTargetSchema>;
export type CrossDomainPeerEntry = z.infer<typeof CrossDomainPeerEntrySchema>;
export type ReadAnchorWireEntry = z.infer<typeof ReadAnchorWireEntrySchema>;
export type CrossDomainPresenceEntry = z.infer<typeof CrossDomainPresenceEntrySchema>;
export type BoardEntry = z.infer<typeof BoardEntrySchema>;
export type BoardAttachment = z.infer<typeof BoardAttachmentSchema>;
export type ConsoleReportReadOp = Extract<ConsoleOp, { kind: "report_read" }>;
export type ConsoleSendOp = Extract<ConsoleOp, { kind: "send" }>;
export type ConsoleRespondOp = Extract<ConsoleOp, { kind: "respond" }>;
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
//  Op results (gateway -> console)

export type DiscoverCoverage = z.infer<typeof DiscoverCoverageSchema>;
export type ConsoleSendResult = z.infer<typeof ConsoleSendResultSchema>;
export type ConsoleRespondResult = z.infer<typeof ConsoleRespondResultSchema>;
export type ConsoleReportReadResult = z.infer<typeof ConsoleReportReadResultSchema>;
export type ConsolePeekResult = z.infer<typeof ConsolePeekResultSchema>;
export type ConsoleTmuxSendResult = z.infer<typeof ConsoleTmuxSendResultSchema>;
export type ConsoleListDirsResult = z.infer<typeof ConsoleListDirsResultSchema>;
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
export type ConsoleOpResult = z.infer<typeof ConsoleOpResultSchema> | { applied: true; dropped?: string[] };

////////////////////////////////
//  Mailbox

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxEntryKind = MailboxEntry["kind"];
export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
