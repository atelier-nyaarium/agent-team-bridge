import crypto from "node:crypto";
import { basename } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import WebSocket from "ws";
import packageJson from "../../../package.json";
import { createReconnector } from "../../shared/reconnect.js";
import type { ChannelPushPayload, ConnectionMode, ResponsePushPayload } from "../../shared/types.js";
import { emitChannelNotification, emitResponseNotification } from "../channel/channelNotify.js";

////////////////////////////////
//  Interfaces & Types

export interface BridgeConfig {
	routerUrl: string;
	projectName: string;
	agentType: string;
}

interface RouterPostOptions {
	retries?: number;
	retryDelayMs?: number;
}

////////////////////////////////
//  Functions & Helpers

// Bridge state: set by initBridge(), read by tool handlers after MCP connects
let ROUTER_URL = "";
let PROJECT_NAME = "";
let AGENT_TYPE = "";

// Stable conversation id for the life of this MCP process. Regenerated on process start,
// reused across WebSocket reconnects so the gateway can keep the conversation tied to the
// same agent window / container instance.
const CONVERSATION_ID: string = crypto.randomUUID();

let routerWs: WebSocket | null = null;
let suppressReconnect = false;
const reconnector = createReconnector(() => connectToRouter());

// Server instance for channel notifications (set when Claude + channel mode)
let channelServer: Server | null = null;

// Whether this MCP instance is the main/lead agent (vs a team worker).
// true = auto-reply lead, false = auto-reply worker, null = let the LLM decide via notification.
let isMainOrLeadAgent: boolean | null = null;

export function initBridge(config: BridgeConfig): void {
	ROUTER_URL = config.routerUrl;
	PROJECT_NAME = config.projectName;
	AGENT_TYPE = config.agentType;
}

export function setChannelServer(server: Server): void {
	channelServer = server;
}

export function setIsMainOrLeadAgent(value: boolean): void {
	isMainOrLeadAgent = value;
}

export function bridgeProjectName(): string {
	return PROJECT_NAME;
}

export function bridgeAgentType(): string {
	return AGENT_TYPE;
}

export function bridgeConversationId(): string {
	return CONVERSATION_ID;
}

export async function routerPost(
	path: string,
	body: unknown,
	{ retries = 4, retryDelayMs = 1500 }: RouterPostOptions = {},
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${ROUTER_URL}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
				console.error(
					`[bridge] routerPost ${path} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${lastErr.message}`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
			continue;
		}
		const json = (await res.json()) as Record<string, unknown>;
		if (!res.ok) {
			throw new Error((json?.error as string) || `HTTP ${res.status}`);
		}
		return json;
	}
	throw lastErr!;
}

export async function routerGet(
	path: string,
	{ retries = 2, retryDelayMs = 1000 }: RouterPostOptions = {},
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${ROUTER_URL}${path}`);
			return res.json();
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}
	throw lastErr;
}

/** Build the register message from the bridge module state (rebuilt fresh on every reconnect).
 * The harness session id rides along so the gateway can `claude --resume <id>` the session on a
 * later wake; the cwd basename is the default session label for a self-appearing (manually
 * launched) session. The gateway records neither until the handshake confirms, so a channel-less
 * session that never answers never becomes a durable card. Pure given (module state, env),
 * exported for tests. */
export function buildRegisterMsg(subId: string, mode: ConnectionMode = "channel"): Record<string, string> {
	const registerMsg: Record<string, string> = {
		type: "register",
		team: PROJECT_NAME,
		mode,
		subId,
		conversationId: CONVERSATION_ID,
		version: packageJson.version,
	};
	if (process.env.PROJECT_HOST_PATH) {
		registerMsg.projectPath = process.env.PROJECT_HOST_PATH;
	}
	if (process.env.CLAUDE_CODE_SESSION_ID) {
		registerMsg.claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
	}
	const cwdName = basename(process.cwd());
	if (cwdName) registerMsg.cwdName = cwdName;
	return registerMsg;
}

// WebSocket connection to router

export function connectToRouter(): void {
	const wsUrl = `${ROUTER_URL.replace(/^http/, "ws")}/bridge`;
	routerWs = new WebSocket(wsUrl);

	const isChannel = AGENT_TYPE === "claude";
	const mode: ConnectionMode = "channel";

	routerWs.on("open", () => {
		console.error(`[bridge] connected to router (mode: ${mode})`);
		reconnector.reset();
		routerWs!.send(JSON.stringify(buildRegisterMsg(crypto.randomUUID().slice(0, 8), mode)));
	});

	routerWs.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		// Handshake from gateway: auto-reply if we know the answer, otherwise let the LLM decide
		if (msg.type === "channel_push" && msg.from === "gateway" && msg.replyJsonSchema) {
			if (isMainOrLeadAgent !== null) {
				const hsSessionId = msg.session_id as string;
				console.error(`[bridge] handshake auto-reply [${hsSessionId}], isMainOrLead=${isMainOrLeadAgent}`);
				routerPost("/respond", {
					session_id: hsSessionId,
					status: "completed",
					replyAsJson: { isMainOrLead: isMainOrLeadAgent },
				}).catch((err: Error) => {
					console.error(`[bridge] handshake reply failed: ${err.message}`);
				});
				return;
			}
			// isMainOrLeadAgent === null: let the LLM decide via channel notification (falls through)
		}

		// Handshake rejected: worker agent, stop reconnecting
		if (msg.type === "handshake_reject") {
			console.error(`[bridge] handshake rejected - this is a worker, disconnecting permanently`);
			suppressReconnect = true;
			routerWs?.close();
			return;
		}

		// Channel mode: receive channel_push messages for Claude
		if (msg.type === "channel_push" && isChannel && channelServer) {
			emitChannelNotification(channelServer, msg as unknown as ChannelPushPayload).catch((err: Error) => {
				console.error(`[channel] notification error: ${err.message}`);
			});
		}

		// Channel mode: receive response_push when a reply arrives for a sent request
		if (msg.type === "response_push" && isChannel && channelServer) {
			emitResponseNotification(channelServer, msg as unknown as ResponsePushPayload).catch((err: Error) => {
				console.error(`[channel] response notification error: ${err.message}`);
			});
		}
	});

	routerWs.on("close", () => {
		console.error(`[bridge] disconnected`);
		if (!suppressReconnect) {
			reconnector.schedule();
		}
	});

	routerWs.on("error", (err: Error) => {
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	// Cancel a pending reconnect first, else its timer fires connectToRouter() after the close.
	reconnector.cancel();
	if (routerWs) routerWs.close();
}
