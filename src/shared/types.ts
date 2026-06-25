import type { z } from "zod";
import type {
	ChannelFileSchema,
	ConnectionModeSchema,
	EffortLevelSchema,
	RequestTypeSchema,
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
 * Presence of `base64` means the sender included the bytes and the host MCP
 * plugin should materialize the file under /tmp/evie-files/<msgId>/. Absence
 * means the entry is metadata-only; those bytes were not transferred (there is
 * no re-fetch path), so the agent only sees the metadata.
 */
export type ChannelFile = z.infer<typeof ChannelFileSchema>;

export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
export type RequestType = z.infer<typeof RequestTypeSchema>;
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;

////////////////////////////////
//  Note: CLI replies (crosstalk_reply) carry a status. Channel replies
//  (channel_reply) are stream messages with no status at all. The fields
//  below are optional so the same payload type serves both paths.

export interface InjectPayload {
	type: "inject";
	from: string;
	request_type: RequestType;
	body: string;
	effort: EffortLevel | "auto";
	session_id: string;
	is_follow_up: boolean;
}

export interface ChannelPushPayload {
	type: "channel_push";
	from: string;
	request_type: RequestType;
	body: string;
	effort: EffortLevel | "auto";
	session_id: string;
	is_follow_up: boolean;
	replyJsonSchema?: string;
	message_id?: string;
	discord_message_id?: string;
	files?: ChannelFile[];
}

export interface ResponsePayload {
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
	replyAsJson?: Record<string, unknown>;
	question?: string;
	reason?: string;
	estimated_minutes?: number;
	what_to_decide?: string;
	message?: string;
	files?: ChannelFile[];
}

export interface EffortEnv {
	simple?: string;
	standard?: string;
	complex?: string;
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
	LOG_PATH: string;
	RESPONSE_TIMEOUT_MS: number;
	// This Gateway's id, qualifying every local session name on the wire (GATEWAY_ID
	// env override, else the sanitized machine hostname).
	localGatewayId: string;
	// This Gateway's Domain id, from the required FEDERATION_DOMAIN_ID env (an opaque slug;
	// resolveLocalDomainId throws if it is unset, so there is no implicit default).
	localDomainId: string;
}

export interface WebSocketConfig {
	HEARTBEAT_INTERVAL_MS: number;
	MISSED_PINGS_LIMIT: number;
	// When set, a register for the reserved "host" team must present a matching token.
	// Unset (default) keeps the existing unauthenticated host registration.
	hostWsToken?: string;
}
