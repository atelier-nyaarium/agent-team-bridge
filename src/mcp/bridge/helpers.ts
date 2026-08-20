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

let ROUTER_URL = "";
let PROJECT_NAME = "";
let AGENT_TYPE = "";

// Per process, reused across reconnects.
const CONVERSATION_ID: string = crypto.randomUUID();

let routerWs: WebSocket | null = null;
let suppressReconnect = false;
const reconnector = createReconnector(() => connectToRouter());

let channelServer: Server | null = null;

/** `confirm` only takes for an id this connection received, so a relayed handshake id cannot poison
 * a worker's own cache. The guard lives on the write, not at every call site. */
function createHandshakeRoleCache() {
	let role: boolean | null = null;
	let lastReceivedId: string | null = null;
	const receivedIds = new Set<string>();
	return {
		noteReceived(hsSessionId: string): void {
			receivedIds.add(hsSessionId);
			lastReceivedId = hsSessionId;
		},
		confirm(hsSessionId: string, value: boolean): boolean {
			if (!receivedIds.has(hsSessionId)) return false;
			role = value;
			return true;
		},
		get(): boolean | null {
			return role;
		},
		/** The handshake this process was challenged with and has not answered. The gateway refuses
		 * to name it (conversationId is not secret, so echoing it there would hand a victim's live
		 * handshake id to anyone who knows one), but THIS process was legitimately pushed it - the
		 * agent is simply the half that lost it, to a compaction or a turn boundary (issue #251).
		 * Null once answered, since the reconnect path auto-replies from `role` and needs no agent. */
		unanswered(): string | null {
			return role === null ? lastReceivedId : null;
		},
		/** A reconnect re-registers, and the gateway's mint() forgets the old id before pushing a
		 * fresh one - so until that push lands, the remembered id is known-dead. No hint beats a
		 * hint that 404s. receivedIds is kept: a late confirm of the old id must stay a no-op. */
		resetUnanswered(): void {
			lastReceivedId = null;
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

/** False (no-op) for an id `noteReceived` never saw. */
export function confirmHandshakeRole(hsSessionId: string, value: boolean): boolean {
	return handshakeRole.confirm(hsSessionId, value);
}

/** See the cache's own doc: the handshake this process owes, for naming back to an agent that lost it. */
export function unansweredHandshakeId(): string | null {
	return handshakeRole.unanswered();
}

export function bridgeProjectName(): string {
	return PROJECT_NAME;
}

export function bridgeConversationId(): string {
	return CONVERSATION_ID;
}

/** The gateway derives the sender from this rather than a body field. Read per call, not cached:
 * the module can load before the env is in place. */
function sessionTokenHeader(): Record<string, string> {
	const token = process.env.SWITCHBOARD_SESSION_TOKEN;
	return token ? { "x-session-token": token } : {};
}

/** A gateway `error` is a bare string on most routes and an object on typed refusals. Reading only
 * the string shape rendered every structured refusal as "[object Object]". */
export function routerErrorText(failure: unknown): string | undefined {
	if (typeof failure === "string") return failure;
	const message = (failure as { message?: unknown } | null)?.message;
	return typeof message === "string" ? message : undefined;
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
				headers: { "Content-Type": "application/json", ...sessionTokenHeader() },
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
		// KNOWN GAP (plans/pain-points.md): outside the try, so a non-JSON error body skips the retry
		// loop and its status never reaches the caller.
		const json = (await res.json()) as Record<string, unknown>;
		if (!res.ok) {
			throw new Error(routerErrorText(json?.error) || `HTTP ${res.status}`);
		}
		return json;
	}
	throw lastErr!;
}

/** Self-scoped: no target parameter, and `from` is always this process. Hand-rolling the POST body
 * instead of calling this is what would reopen the hole. */
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

/** Self-scoped like postPluginAction: `from` decides whose entries the call may touch. */
export async function postBoard(body: Record<string, unknown>): Promise<unknown> {
	// `from` LAST, so it overwrites rather than defaults.
	return routerPost("/task-board", { ...body, from: PROJECT_NAME });
}

export async function routerGet(
	path: string,
	{ retries = 2, retryDelayMs = 1000 }: RouterPostOptions = {},
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${ROUTER_URL}${path}`, { headers: sessionTokenHeader() });
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delay));
			}
			continue;
		}
		// KNOWN GAP (plans/pain-points.md): outside the try, so a non-JSON error body skips the retry
		// loop and its status never reaches the caller.
		const json = (await res.json()) as Record<string, unknown>;
		if (!res.ok) {
			throw new Error(routerErrorText(json?.error) || `HTTP ${res.status}`);
		}
		return json;
	}
	throw lastErr!;
}

/** Rebuilt on every reconnect. The gateway records nothing until the handshake confirms, so a
 * channel-less session never becomes a durable card. Exported for tests. */
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
	// A hand-launched session registers unbound: it works normally, but cannot claim a bound name.
	if (process.env.SWITCHBOARD_SESSION_TOKEN) {
		registerMsg.sessionToken = process.env.SWITCHBOARD_SESSION_TOKEN;
	}
	// Never false: a worker that answered false is evicted and never reconnects.
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
		// This register makes the gateway mint a FRESH handshake, so the previously remembered
		// unanswered id is dead from here until the new push lands (see resetUnanswered's doc).
		handshakeRole.resetUnanswered();
		routerWs!.send(JSON.stringify(buildRegisterMsg(crypto.randomUUID().slice(0, 8), mode)));
	});

	routerWs.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		// Gated on the hs- prefix, not the sender: another gateway push must reach the LLM rather than
		// be swallowed by this cached answer, and a future one may forget to change `from`.
		if (
			msg.type === "channel_push" &&
			msg.from === "gateway" &&
			msg.replyJsonSchema &&
			typeof msg.session_id === "string" &&
			msg.session_id.startsWith("hs-")
		) {
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
			// role === null falls through, so the LLM decides.
		}

		if (msg.type === "handshake_reject") {
			console.error(`[bridge] handshake rejected - this is a worker, disconnecting permanently`);
			suppressReconnect = true;
			routerWs?.close();
			return;
		}

		if (msg.type === "channel_push" && isChannel && channelServer) {
			emitChannelNotification(channelServer, msg as unknown as ChannelPushPayload).catch((err: Error) => {
				console.error(`[channel] notification error: ${err.message}`);
			});
		}

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
