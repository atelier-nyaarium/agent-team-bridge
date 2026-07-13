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

/** This MCP instance's remembered main/lead-vs-worker answer, and the handshake ids it may use to
 * write it. `confirm` only takes effect for an id this connection actually received via
 * `noteReceived` first, so a lead delegating a channel_reply_structured (carrying a relayed hs id)
 * to a separate-harness worker teammate can never poison the WORKER's own cache to true via an id
 * it never received - the guard lives on the write itself instead of at every call site. */
function createHandshakeRoleCache() {
	let role: boolean | null = null;
	const receivedIds = new Set<string>();
	return {
		noteReceived(hsSessionId: string): void {
			receivedIds.add(hsSessionId);
		},
		confirm(hsSessionId: string, value: boolean): boolean {
			if (!receivedIds.has(hsSessionId)) return false;
			role = value;
			return true;
		},
		get(): boolean | null {
			return role;
		},
	};
}
const handshakeRole = createHandshakeRoleCache();

export function initBridge(config: BridgeConfig): void {
	ROUTER_URL = config.routerUrl;
	PROJECT_NAME = config.projectName;
	AGENT_TYPE = config.agentType;
}

export function setChannelServer(server: Server): void {
	channelServer = server;
}

/** Record this process's main/lead-vs-worker answer for a handshake it actually received. Returns
 * false (no-op) for an id `noteReceived` never saw, so a relayed/foreign id can never write the
 * cache. */
export function confirmHandshakeRole(hsSessionId: string, value: boolean): boolean {
	return handshakeRole.confirm(hsSessionId, value);
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

/** POST a plugin-action envelope to the gateway's /plugin-action route, self-scoped to THIS
 * container's own identity. Deliberately takes no target/team/session_id parameter - `from` is
 * always this process's own PROJECT_NAME, so a plugin-action tool cannot smuggle a different
 * destination through this helper even by mistake. New plugin-action tools should call this
 * rather than routerPost("/plugin-action", ...) directly - hand-rolling the POST body is what
 * would reopen the hole this closes. */
export async function postPluginAction(
	pluginId: string,
	actionType: string,
	payload?: Record<string, unknown>,
): Promise<{ delivered?: boolean }> {
	return (await routerPost("/plugin-action", {
		from: PROJECT_NAME,
		pluginId,
		actionType,
		...(payload ? { payload } : {}),
	})) as { delivered?: boolean };
}

export async function routerGet(
	path: string,
	{ retries = 2, retryDelayMs = 1000 }: RouterPostOptions = {},
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${ROUTER_URL}${path}`);
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
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

/** Build the register message from the bridge module state (rebuilt fresh on every reconnect).
 * The harness session id rides along so the gateway can `claude --resume <id>` the session on a
 * later wake; the cwd basename is the default session label for a self-appearing (manually
 * launched) session. The gateway records neither until the handshake confirms, so a channel-less
 * session that never answers never becomes a durable card. Pure given (module state, env),
 * exported for tests. */
export function buildRegisterMsg(subId: string, mode: ConnectionMode = "channel"): Record<string, string | boolean> {
	const registerMsg: Record<string, string | boolean> = {
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
	// Carry the remembered handshake answer so a reconnect confirms silently instead of re-asking -
	// never sent false, since a worker that answered false is evicted and never reconnects.
	if (handshakeRole.get() === true) registerMsg.isMainOrLead = true;
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
			const hsSessionId = msg.session_id as string;
			handshakeRole.noteReceived(hsSessionId);
			const role = handshakeRole.get();
			if (role !== null) {
				console.error(`[bridge] handshake auto-reply [${hsSessionId}], isMainOrLead=${role}`);
				routerPost("/respond", {
					session_id: hsSessionId,
					status: "completed",
					replyAsJson: { isMainOrLead: role },
				}).catch((err: Error) => {
					console.error(`[bridge] handshake reply failed: ${err.message}`);
				});
				return;
			}
			// role === null: let the LLM decide via channel notification (falls through)
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
