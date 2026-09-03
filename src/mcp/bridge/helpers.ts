import crypto from "node:crypto";
import { basename } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import WebSocket from "ws";
import packageJson from "../../../package.json";
import { createReconnector } from "../../shared/reconnect.js";
import { OP_LEDGER_PROTOCOL } from "../../shared/schemas.js";
import type { ChannelPushPayload, ConnectionMode, ResponsePushPayload } from "../../shared/types.js";
import { emitChannelNotification, emitResponseNotification } from "../channel/channelNotify.js";

export interface BridgeConfig {
	routerUrl: string;
	projectName: string;
	agentType: string;
}

interface RouterPostOptions {
	retries?: number;
	retryDelayMs?: number;
}

const MAX_ROUTER_ERROR_BODY = 4096;

class RouterHttpError extends Error {
	constructor(
		readonly status: number,
		body: string,
	) {
		super(`HTTP ${status}: ${body.slice(0, MAX_ROUTER_ERROR_BODY)}`);
	}
}

async function readResponseBody(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	try {
		while (bytesRead < maxBytes) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			const chunk = value.subarray(0, maxBytes - bytesRead);
			chunks.push(chunk);
			bytesRead += chunk.byteLength;
			if (chunk.byteLength < value.byteLength) await reader.cancel();
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytesRead);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

let ROUTER_URL = "";
let PROJECT_NAME = "";
let AGENT_TYPE = "";

const CONVERSATION_ID: string = crypto.randomUUID();

let routerWs: WebSocket | null = null;
let suppressReconnect = false;
const reconnector = createReconnector(() => connectToRouter());

let channelServer: Server | null = null;

/** Confirm only received ids. */
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
		/** Pending handshake id. */
		unanswered(): string | null {
			return role === null ? lastReceivedId : null;
		},
		/** Clear the stale pending id. */
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

/** Unknown ids are no-ops. */
export function confirmHandshakeRole(hsSessionId: string, value: boolean): boolean {
	return handshakeRole.confirm(hsSessionId, value);
}

/** Return the pending handshake id. */
export function unansweredHandshakeId(): string | null {
	return handshakeRole.unanswered();
}

export function bridgeProjectName(): string {
	return PROJECT_NAME;
}

export function bridgeConversationId(): string {
	return CONVERSATION_ID;
}

/** Read the token per call. */
function sessionTokenHeader(): Record<string, string> {
	const token = process.env.SWITCHBOARD_SESSION_TOKEN;
	return token ? { "x-session-token": token } : {};
}

/** Read string and object errors. */
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
	return routerRequest(
		`${ROUTER_URL}${path}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...sessionTokenHeader() },
			body: JSON.stringify(body),
		},
		retries,
		retryDelayMs,
		"routerPost",
	);
}

async function routerRequest(
	url: string,
	init: RequestInit,
	retries: number,
	retryDelayMs: number,
	label: string,
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, init);
			const body = res.ok ? await res.text() : await readResponseBody(res, MAX_ROUTER_ERROR_BODY);
			let json: unknown;
			try {
				json = JSON.parse(body) as unknown;
			} catch {
				throw new RouterHttpError(res.status, body);
			}
			if (!res.ok) throw new RouterHttpError(res.status, routerErrorText(json) ?? body);
			return json;
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (err instanceof RouterHttpError) throw err;
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
				console.error(
					`[bridge] ${label} ${url} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${lastErr.message}`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}
	throw lastErr!;
}

/** Post a self-scoped action. */
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

/** Post a self-scoped board action. */
export async function postBoard(body: Record<string, unknown>): Promise<unknown> {
	// Force the caller identity.
	return routerPost("/task-board", { ...body, from: PROJECT_NAME });
}

export async function routerGet(
	path: string,
	{ retries = 2, retryDelayMs = 1000 }: RouterPostOptions = {},
): Promise<unknown> {
	return routerRequest(`${ROUTER_URL}${path}`, { headers: sessionTokenHeader() }, retries, retryDelayMs, "routerGet");
}

/** Delivery acknowledgement contract. */
export const DELIVERY_PROTOCOL = 1;

let opLedgerProtocol = 0;

/** Refuse sends without op-ledger support. */
export function opLedgerRefusal(): string | null {
	if (opLedgerProtocol >= OP_LEDGER_PROTOCOL) return null;
	return opLedgerProtocol === 0
		? `The gateway has not advertised an op-ledger version. Update the gateway before the plugin.`
		: `The gateway's op-ledger version ${opLedgerProtocol} is older than this plugin's ${OP_LEDGER_PROTOCOL}.`;
}

export function buildRegisterMsg(
	subId: string,
	mode: ConnectionMode = "channel",
): Record<string, string | boolean | number> {
	const registerMsg: Record<string, string | boolean | number> = {
		type: "register",
		team: PROJECT_NAME,
		mode,
		subId,
		conversationId: CONVERSATION_ID,
		version: packageJson.version,
		deliveryProtocol: DELIVERY_PROTOCOL,
	};
	if (process.env.PROJECT_HOST_PATH) {
		registerMsg.projectPath = process.env.PROJECT_HOST_PATH;
	}
	if (process.env.CLAUDE_CODE_SESSION_ID) {
		registerMsg.claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
	}
	const cwdName = basename(process.cwd());
	if (cwdName) registerMsg.cwdName = cwdName;
	if (process.env.SWITCHBOARD_SESSION_TOKEN) {
		registerMsg.sessionToken = process.env.SWITCHBOARD_SESSION_TOKEN;
	}
	if (handshakeRole.get() === true) registerMsg.isMainOrLead = true;
	return registerMsg;
}

export function connectToRouter(): void {
	const wsUrl = `${ROUTER_URL.replace(/^http/, "ws")}/bridge`;
	// Reset capabilities per connection.
	opLedgerProtocol = 0;
	routerWs = new WebSocket(wsUrl);

	const isChannel = AGENT_TYPE === "claude";
	const mode: ConnectionMode = "channel";

	routerWs.on("open", () => {
		console.error(`[bridge] connected to router (mode: ${mode})`);
		reconnector.reset();
		// Discard the stale handshake id.
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
				const refusal = opLedgerRefusal();
				if (refusal) {
					console.error(`[bridge] handshake reply withheld: ${refusal}`);
					return;
				}
				console.error(`[bridge] handshake auto-reply [${hsSessionId}], isMainOrLead=${role}`);
				routerPost("/respond", {
					opId: crypto.randomUUID(),
					session_id: hsSessionId,
					status: "completed",
					replyAsJson: { isMainOrLead: role },
				}).catch((err: Error) => {
					console.error(`[bridge] handshake reply failed: ${err.message}`);
				});
				return;
			}
		}

		if (msg.type === "register_ok") {
			opLedgerProtocol = typeof msg.opLedgerProtocol === "number" ? msg.opLedgerProtocol : 0;
			return;
		}

		if (msg.type === "handshake_reject") {
			console.error(`[bridge] handshake rejected - this is a worker, disconnecting permanently`);
			suppressReconnect = true;
			routerWs?.close();
			return;
		}

		if (msg.type === "channel_push" && isChannel && channelServer) {
			const deliveryId = typeof msg.delivery_id === "string" ? msg.delivery_id : undefined;
			emitChannelNotification(channelServer, msg as unknown as ChannelPushPayload)
				.then(() => {
					// Acknowledge after delivery.
					if (deliveryId)
						routerWs?.send(JSON.stringify({ type: "channel_delivery_ack", delivery_id: deliveryId }));
				})
				.catch((err: Error) => {
					// Retain failed deliveries.
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
		opLedgerProtocol = 0;
		if (!suppressReconnect) {
			reconnector.schedule();
		}
	});

	routerWs.on("error", (err: Error) => {
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	// Cancel reconnect before closing.
	reconnector.cancel();
	opLedgerProtocol = 0;
	if (routerWs) routerWs.close();
}
