import crypto from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import WebSocket from "ws";
import { debugLog } from "../../shared/debug-log.js";
import { createReconnector } from "../../shared/reconnect.js";
import type {
	ChannelPushPayload,
	ConnectionMode,
	EffortEnv,
	InjectPayload,
	ResponsePushPayload,
} from "../../shared/types.js";
import { emitChannelNotification, emitResponseNotification } from "../channel/channelNotify.js";
import { handleInject } from "../cli/handleInject.js";

////////////////////////////////
//  Interfaces & Types

export interface BridgeConfig {
	routerUrl: string;
	projectName: string;
	agentType: string;
	effortEnv: EffortEnv;
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
let EFFORT_ENV: EffortEnv = {};

// Stable conversation id for the life of this MCP process. Regenerated on process start,
// reused across WebSocket reconnects so the arbiter can keep the conversation tied to the
// same agent window / container instance.
const CONVERSATION_ID: string = crypto.randomUUID();

let routerWs: WebSocket | null = null;
let previousSubId: string | null = null;
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
	EFFORT_ENV = config.effortEnv;
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

// WebSocket connection to router

export function connectToRouter(): void {
	const wsUrl = `${ROUTER_URL.replace(/^http/, "ws")}/bridge`;
	routerWs = new WebSocket(wsUrl);

	const isChannel = AGENT_TYPE === "claude";
	const mode: ConnectionMode = isChannel ? "channel" : "cli";

	routerWs.on("open", () => {
		console.error(`[bridge] connected to router (mode: ${mode})`);
		reconnector.reset();
		const subId = crypto.randomUUID().slice(0, 8);

		// #region Hypothesis F: track subId lifecycle across reconnects
		debugLog("F", "src/mcp/bridge/helpers.ts:connectToRouter", "registering new subId", {
			pid: process.pid,
			team: PROJECT_NAME,
			newSubId: subId,
			previousSubId: previousSubId ?? "none",
			mode,
		});
		previousSubId = subId;
		// #endregion

		const registerMsg: Record<string, string> = {
			type: "register",
			team: PROJECT_NAME,
			mode,
			subId,
			conversationId: CONVERSATION_ID,
		};
		if (process.env.PROJECT_HOST_PATH) {
			registerMsg.projectPath = process.env.PROJECT_HOST_PATH;
		}
		routerWs!.send(JSON.stringify(registerMsg));
	});

	routerWs.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		// Handshake from arbiter: auto-reply if we know the answer, otherwise let the LLM decide
		if (msg.type === "channel_push" && msg.from === "arbiter" && msg.replyJsonSchema) {
			if (isMainOrLeadAgent !== null) {
				const hsSessionId = msg.session_id as string;
				console.error(`[bridge] handshake auto-reply [${hsSessionId}], isMainOrLead=${isMainOrLeadAgent}`);
				// #region Hypothesis H: confirm auto-reply fires with correct payload
				debugLog("H", "src/mcp/bridge/helpers.ts:handshake", "auto-reply firing", {
					sessionId: hsSessionId,
					isMainOrLeadAgent,
					team: PROJECT_NAME,
					replyPayload: { isMainOrLead: isMainOrLeadAgent },
				});
				// #endregion
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

		// CLI mode: receive inject messages for non-Claude agents
		if (msg.type === "inject" && !isChannel) {
			handleInject(msg as unknown as InjectPayload, AGENT_TYPE, EFFORT_ENV).catch((err: Error) => {
				console.error(`[bridge] handleInject error: ${err.message}`);
			});
		}
	});

	routerWs.on("close", () => {
		// #region Hypothesis F: log disconnect with subId that arbiter should clean up
		debugLog("F", "src/mcp/bridge/helpers.ts:connectToRouter", "disconnected", {
			pid: process.pid,
			team: PROJECT_NAME,
			subId: previousSubId ?? "unknown",
			suppressReconnect,
		});
		// #endregion
		console.error(`[bridge] disconnected`);
		if (!suppressReconnect) {
			reconnector.schedule();
		}
	});

	routerWs.on("error", (err: Error) => {
		// #region Hypothesis F: log connection error
		debugLog("F", "src/mcp/bridge/helpers.ts:connectToRouter", "ws error", {
			pid: process.pid,
			team: PROJECT_NAME,
			subId: previousSubId ?? "unknown",
			error: err.message,
		});
		// #endregion
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	if (routerWs) routerWs.close();
}
