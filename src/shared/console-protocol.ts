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
// Documented floor, not negotiated.
export const CONSOLE_PROTOCOL_VERSION = 3;
export const MAX_OPS_PER_CONVERSATION = 256;

export type ConsoleOp = z.infer<typeof ConsoleOpSchema>;
export type ConsoleOpKind = ConsoleOp["kind"];
export type CrossDomainShareTarget = z.infer<typeof CrossDomainShareTargetSchema>;
export type CrossDomainPeerEntry = z.infer<typeof CrossDomainPeerEntrySchema>;
export type ReadAnchorWireEntry = z.infer<typeof ReadAnchorWireEntrySchema>;
export type CrossDomainPresenceEntry = z.infer<typeof CrossDomainPresenceEntrySchema>;
export type BoardEntry = z.infer<typeof BoardEntrySchema>;
export type BoardAttachment = z.infer<typeof BoardAttachmentSchema>;
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

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxEntryKind = MailboxEntry["kind"];
export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
