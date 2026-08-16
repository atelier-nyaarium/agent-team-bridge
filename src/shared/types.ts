import type { z } from "zod";
import type { NoticeTierWire } from "./notice.js";
import type {
	ChannelFileSchema,
	ConnectionModeSchema,
	ResponseStatusSchema,
	TeamInfoSchema,
	TeamKindSchema,
} from "./schemas.js";

////////////////////////////////
//  Bridge Types
//
//  Wire shapes derive from the zod schemas in shared/schemas.ts (the single
//  truth). Local-only types (payloads, config) stay hand-written here.

/**
 * Channel attachment metadata carried over the bridge (console-origin files).
 *
 * A `blobId` names the bytes on the blob plane, which the host MCP plugin pulls down a chunk at a
 * time into /tmp/switchboard-channel-files/<msgId>/. Absence means the entry is metadata-only: the sender could
 * not stage the bytes, so the agent sees the file was there and nothing more.
 */
export type ChannelFile = z.infer<typeof ChannelFileSchema>;

export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;

////////////////////////////////
//  Reply payloads. Fields are optional because a channel reply (channel_reply) is a
//  stream message that may carry only a partial update (status, a chunk, or the final).

export interface ChannelPushPayload {
	type: "channel_push";
	from: string;
	body: string;
	session_id: string;
	replyJsonSchema?: string;
	message_id?: string;
	files?: ChannelFile[];
	// Awareness only: the push asks for no reply and its session_id routes nowhere. Nothing can
	// ENFORCE no-reply, so this only changes the instructions the harness renders; the gateway still
	// has to absorb a reply that comes anyway.
	no_ack?: boolean;
}

// Extends the spoken-tier trio (notice.ts NoticeTierWire): title (notification-bar line +
// shortest spoken tier), summary (medium spoken tier), fullSpoken (what the FULL play tier
// speaks in the body's place). Absent on a plain reply; response stays the full body.
export interface ResponsePayload extends NoticeTierWire {
	session_id: string;
	status?: ResponseStatus;
	response?: string;
	replyAsJson?: Record<string, unknown>;
	question?: string;
	reason?: string;
	estimated_minutes?: number;
	what_to_decide?: string;
	message?: string;
	files?: ChannelFile[];
}

export interface ResponsePushPayload {
	type: "response_push";
	session_id: string;
	status?: string;
	response?: string;
	message_id?: string;
	files?: ChannelFile[];
}

////////////////////////////////
//  WebSocket Types

export interface RegisterMessage {
	type: "register";
	team: string;
	mode?: ConnectionMode;
	subId?: string;
	conversationId: string;
}

/** Devcontainer-backed teams are wakeable projects; loose teams are ad-hoc
 * sessions (host windows, one-off peers) that end when their process does. */
export type TeamKind = z.infer<typeof TeamKindSchema>;

export type TeamInfo = z.infer<typeof TeamInfoSchema>;

export interface CatalogMessage {
	type: "catalog";
	projects: Array<{ team: string; projectPath: string }>;
}

////////////////////////////////
//  Config Types

export interface GatewayConfig {
	// This Gateway's id, qualifying every local session name on the wire (GATEWAY_ID
	// env override, else the sanitized machine hostname).
	localGatewayId: string;
	// This Gateway's Domain id, or null until enrollment delivers it (arming mode). Resolved from
	// the enrollment-delivered domain-id file, else the FEDERATION_DOMAIN_ID env.
	localDomainId: string | null;
}

export interface WebSocketConfig {
	HEARTBEAT_INTERVAL_MS: number;
	MISSED_PINGS_LIMIT: number;
	// When set, a register for the reserved "host" team must present a matching token.
	// Unset (default) keeps the existing unauthenticated host registration.
	hostWsToken?: string;
}
