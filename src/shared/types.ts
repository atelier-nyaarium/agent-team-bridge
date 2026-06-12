////////////////////////////////
//  Bridge Types

/**
 * Discord attachment metadata propagated from evie-bot through the bridge.
 *
 * Presence of `base64` means the bot fetched the bytes and the host MCP
 * plugin should materialize the file under /tmp/evie-files/<msgId>/. Absence
 * means the entry is metadata-only and the agent should reach the file via
 * `evie_fetch_message_files` instead.
 *
 * Mirror: evie-bot's `ForwardDmFile` in `app/features/bridge/BridgeServer.ts`.
 * Wire validation lives in `ChannelFileSchema` (`shared/schemas.ts`).
 */
export interface ChannelFile {
	filename: string;
	mime: string;
	size: number;
	descriptiveKey: string;
	base64?: string;
}

export type ConnectionMode = "cli" | "channel";
export type EffortLevel = "simple" | "standard" | "complex";
export type RequestType = "feature" | "bugfix" | "question";
export type ResponseStatus =
	| "completed"
	| "clarification"
	| "deferred"
	| "needs_human"
	| "error"
	| "timeout"
	| "running";

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
export type TeamKind = "devcontainer" | "loose";

export interface TeamInfo {
	team: string;
	status: "online" | "available";
	mode?: ConnectionMode;
	kind: TeamKind;
	queue_depth: number;
}

export interface CatalogMessage {
	type: "catalog";
	projects: Array<{ team: string; projectPath: string }>;
}

////////////////////////////////
//  Config Types

export interface ArbiterConfig {
	LOG_PATH: string;
	RESPONSE_TIMEOUT_MS: number;
}

export interface WebSocketConfig {
	HEARTBEAT_INTERVAL_MS: number;
	MISSED_PINGS_LIMIT: number;
}
