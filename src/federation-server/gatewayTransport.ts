import { timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";

function constantTimeBearerEquals(provided: string | null, expected: string): boolean {
	if (!provided) return false;
	const left = Buffer.from(provided);
	const right = Buffer.from(`Bearer ${expected}`);
	return left.length === right.length && timingSafeEqual(left, right);
}

////////////////////////////////
//  Interfaces & Types

export type ConnectionId = string;

export interface GatewayToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolProvider {
	listTools?(): GatewayToolSchema[];

	handleCall(connId: ConnectionId, name: string, params: Record<string, unknown>): Promise<unknown>;

	onConnect?(connId: ConnectionId): void;

	onDisconnect?(connId: ConnectionId): void;
}

////////////////////////////////
//  Parameters

export interface GatewayTransportParams {
	port: number;
	authToken: string;
	provider: ToolProvider;
	label?: string;
}

////////////////////////////////
//  Class

export const WS_MAX_PAYLOAD_BYTES = 67_108_864;

export class GatewayTransport {
	private connections: Map<ConnectionId, WebSocket> = new Map();
	private reverseConnections = new Map<WebSocket, ConnectionId>();
	private nextId = 0;
	private readonly authToken: string;
	private readonly provider: ToolProvider;
	private readonly label: string;

	public constructor({ port, authToken, provider, label }: GatewayTransportParams) {
		this.authToken = authToken;
		this.provider = provider;
		this.label = label ?? "GatewayTransport";
		this.handleOpen = this.handleOpen.bind(this);
		this.handleMessage = this.handleMessage.bind(this);
		this.handleClose = this.handleClose.bind(this);
	}

	public start(): void {
		throw new Error(`${this.label} requires RouterServer`);
	}

	public stop(): void {
		for (const ws of this.connections.values()) {
			try {
				ws.close();
			} catch {}
		}
		this.connections.clear();
		this.reverseConnections.clear();
	}

	public getConnection(connId: ConnectionId): WebSocket | null {
		return this.connections.get(connId) ?? null;
	}

	public listConnections(): ConnectionId[] {
		return [...this.connections.keys()];
	}

	public authorizeUpgrade(authorization: string | undefined): boolean {
		return constantTimeBearerEquals(authorization ?? null, this.authToken);
	}

	public handleOpen(ws: WebSocket): void {
		const connId = `c${++this.nextId}`;
		ws.on("error", () => {});
		this.connections.set(connId, ws);
		this.reverseConnections.set(ws, connId);
		console.log(`[${this.label}] Client ${connId} connected (${this.connections.size} active)`);
		// Dormant: no provider implements listTools, so this never fires. It would not work if one did -
		// `RouterInboundFrameSchema` has no `tool_registry` member, so the gateway drops the frame. Give
		// the schema a member before giving this a sender.
		const tools = this.provider.listTools?.();
		if (tools) ws.send(JSON.stringify({ type: "tool_registry", tools }));
		try {
			this.provider.onConnect?.(connId);
		} catch (err) {
			console.log(`[${this.label}] onConnect threw for ${connId}:`, err);
		}
	}

	public handleMessage(ws: WebSocket, data: WebSocket.RawData): void {
		const connId = this.reverseConnections.get(ws);
		if (!connId) return;
		let message: unknown;
		try {
			message = JSON.parse(typeof data === "string" ? data : data.toString());
		} catch {
			ws.send(JSON.stringify({ type: "tool_error", callId: null, error: `Invalid JSON` }));
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const msg = message as Record<string, unknown>;
		if (msg.type !== "tool_call") return;
		if (typeof msg.callId !== "string" || typeof msg.action !== "string") {
			ws.send(
				JSON.stringify({
					type: "tool_error",
					callId: null,
					error: `Invalid tool_call: callId and action must be strings`,
				}),
			);
			return;
		}
		const callId = msg.callId;
		const name = msg.action;
		const params = (msg.params ?? {}) as Record<string, unknown>;
		this.dispatchCall(ws, connId, callId, name, params).catch((error) => {
			console.error(`[${this.label}] dispatch failed for ${connId}: ${(error as Error).message}`);
		});
	}

	private async dispatchCall(
		ws: WebSocket,
		connId: ConnectionId,
		callId: string,
		name: string,
		params: Record<string, unknown>,
	): Promise<void> {
		let frame: string;
		try {
			const result = await this.provider.handleCall(connId, name, params);
			frame = JSON.stringify({ type: "tool_result", callId, result });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			frame = JSON.stringify({ type: "tool_error", callId, error: errorMessage });
		}
		// A send on a closing socket throws, and this call is launched unobserved.
		try {
			ws.send(frame);
		} catch (error) {
			console.warn(`[${this.label}] dropped reply to ${connId}: ${(error as Error).message}`);
		}
	}

	public handleClose(ws: WebSocket): void {
		const connId = this.reverseConnections.get(ws);
		if (!connId) return;
		this.connections.delete(connId);
		this.reverseConnections.delete(ws);
		console.log(`[${this.label}] Client ${connId} disconnected (${this.connections.size} active)`);
		try {
			this.provider.onDisconnect?.(connId);
		} catch (err) {
			console.log(`[${this.label}] onDisconnect threw for ${connId}:`, err);
		}
	}
}
