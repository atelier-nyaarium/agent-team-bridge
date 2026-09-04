import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import { isInsideContainer } from "../../shared/env.js";
import { BEARER_PREFIX } from "../../shared/wire-vocabulary.js";
import { getLoadedToolNames, getToolSchema } from "./projectTools.js";
import { addClient, type ClientData, getAllClients, getClient, getClientByInstance, removeClient } from "./sessions.js";

const TAG = "[connector]";

////////////////////////////////
//  Interfaces & Types

export interface ListenerState {
	mode: "http" | "https";
	hostname: string;
	port: number;
	server: Server<ClientData>;
}

interface PendingInvocation {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	clientHash: string;
}

/** A client opens one by sending a single frame, so count and size must both be refused. */
const MAX_CHUNK_STREAM_PARTS = 4096;
const MAX_CHUNK_STREAM_BYTES = 16_000_000;

interface ChunkStream {
	total: number;
	parts: (string | null)[];
	received: number;
	bytes: number;
}

////////////////////////////////
//  State

let state: ListenerState | null = null;
let authToken: string | null = null;
const pendingInvocations = new Map<string, PendingInvocation>();
const chunkStreams = new Map<string, ChunkStream>();
let requestCounter = 0;

////////////////////////////////
//  Functions & Helpers

export function setAuthToken(token: string | null): void {
	authToken = token;
}

export function getAuthToken(): string | null {
	return authToken;
}

export function getListenerState(): ListenerState | null {
	return state;
}

export function startListener(port: number): void {
	const hostname = isInsideContainer() ? "0.0.0.0" : "127.0.0.1";
	state = createServer({ hostname, port, mode: "http" });
	console.error(`${TAG} Listener started on ${hostname}:${port} (HTTP)`);
}

export function restartWithTls(connectorDir: string, port: number): void {
	const certPath = `${connectorDir}/server.crt`;
	const keyPath = `${connectorDir}/server.key`;

	if (!existsSync(certPath) || !existsSync(keyPath)) {
		throw new Error(`TLS certs not found in ${connectorDir}. Run mcpConnectorGenerateCert first.`);
	}

	const cert = readFileSync(certPath, "utf-8");
	const key = readFileSync(keyPath, "utf-8");

	stopListener();
	state = createServer({ hostname: "0.0.0.0", port, mode: "https", cert, key });
	console.error(`${TAG} Listener restarted on 0.0.0.0:${port} (HTTPS)`);
}

export function restartWithoutTls(port: number): void {
	stopListener();
	const hostname = isInsideContainer() ? "0.0.0.0" : "127.0.0.1";
	state = createServer({ hostname, port, mode: "http" });
	console.error(`${TAG} Listener restarted on ${hostname}:${port} (HTTP)`);
}

export function stopListener(): void {
	if (state) {
		state.server.stop(true);
		state = null;
	}
	for (const [id, pending] of pendingInvocations) {
		clearTimeout(pending.timer);
		pending.reject(new Error(`Listener stopped`));
		pendingInvocations.delete(id);
	}
}

export function resolveClient(
	clientId: string | undefined,
	instance: string | undefined,
): { client: ReturnType<typeof getClient>; label: string } {
	if (instance) {
		const client = getClientByInstance(instance);
		return { client, label: `instance "${instance}"` };
	}
	if (clientId) {
		const client = getClient(clientId);
		return { client, label: `client ${clientId}` };
	}
	return { client: undefined, label: "unknown" };
}

export function invokeOnClient(shortHash: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
	const client = getClient(shortHash);
	if (!client) {
		return Promise.reject(
			new Error(`Client ${shortHash} not connected. Call mcpConnectorStatus for active clients.`),
		);
	}

	const toolSchema = getToolSchema(tool);
	if (toolSchema) {
		const parsed = toolSchema.safeParse(args);
		if (!parsed.success) {
			return Promise.reject(new Error(`Invalid params for tool "${tool}": ${parsed.error.message}`));
		}
	}

	const id = `req-${++requestCounter}`;

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingInvocations.delete(id);
			reject(new Error(`Tool invocation timed out after 30s (${tool} on client ${shortHash})`));
		}, 30_000);

		pendingInvocations.set(id, { resolve, reject, timer, clientHash: shortHash });

		client.ws.send(JSON.stringify({ type: "invoke", id, tool, args }));
	});
}

export function invokeResolved(
	clientId: string | undefined,
	instance: string | undefined,
	tool: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { client, label } = resolveClient(clientId, instance);
	if (!client) {
		return Promise.reject(new Error(`${label} not connected. Call mcpConnectorStatus for active clients.`));
	}
	return invokeOnClient(client.shortHash, tool, args);
}

////////////////////////////////
//  Internal

function acceptChunk(hash: string, streamId: string, seq: number, total: number, payload: string): string | null {
	if (!hash || !streamId || total <= 0 || seq < 0 || seq >= total) {
		console.error(`${TAG} Invalid chunk frame from ${hash}: id=${streamId} seq=${seq} total=${total}`);
		return null;
	}
	const key = `${hash}:${streamId}`;
	let stream = chunkStreams.get(key);
	if (!stream) {
		if (total > MAX_CHUNK_STREAM_PARTS) {
			console.error(`${TAG} Refusing stream from ${hash}: ${total} parts over the ${MAX_CHUNK_STREAM_PARTS} cap`);
			return null;
		}
		stream = { total, parts: new Array<string | null>(total).fill(null), received: 0, bytes: 0 };
		chunkStreams.set(key, stream);
	}
	if (stream.parts[seq] == null) {
		// Bounded, or a client that keeps sending parts grows this map without limit.
		if (stream.bytes + payload.length > MAX_CHUNK_STREAM_BYTES) {
			console.error(`${TAG} Dropping stream from ${hash}: over the ${MAX_CHUNK_STREAM_BYTES}-byte cap`);
			chunkStreams.delete(key);
			return null;
		}
		stream.parts[seq] = payload;
		stream.bytes += payload.length;
		stream.received++;
	}
	if (stream.received < stream.total) return null;
	chunkStreams.delete(key);
	return stream.parts.join("");
}

function dispatchMessage(ws: ServerWebSocket<ClientData>, data: Record<string, unknown>): void {
	if (data.type === "register" && Array.isArray(data.tools)) {
		const clientTools: string[] = data.tools;
		const knownTools = getLoadedToolNames();
		const unknown = clientTools.filter((t: string) => !knownTools.includes(t));
		const valid = clientTools.filter((t: string) => knownTools.includes(t));

		if (unknown.length > 0) {
			console.error(`${TAG} Client ${ws.data.shortHash} registered unknown tools: ${unknown.join(", ")}`);
		}
		console.error(`${TAG} Client ${ws.data.shortHash} registered ${valid.length}/${clientTools.length} tool(s)`);

		const session = getClient(ws.data.shortHash);
		if (session) {
			session.registeredTools = clientTools;
			if (typeof data.instance === "string" && data.instance) {
				session.instance = data.instance;
				ws.data.instance = data.instance;
			}
		}
	} else if (data.type === "result" && typeof data.id === "string") {
		const pending = pendingInvocations.get(data.id);
		console.error(`${TAG} dispatching result id=${data.id} has_pending=${pending !== undefined}`);
		if (pending) {
			clearTimeout(pending.timer);
			pendingInvocations.delete(data.id);
			pending.resolve(data.data);
		}
	}
}

interface CreateServerParams {
	hostname: string;
	port: number;
	mode: "http" | "https";
	cert?: string;
	key?: string;
}

function createServer({ hostname, port, mode, cert, key }: CreateServerParams): ListenerState {
	const tls = mode === "https" && cert && key ? { cert, key } : undefined;

	const server = Bun.serve<ClientData>({
		hostname,
		port,
		tls,
		fetch(req, server) {
			const url = new URL(req.url);

			if (mode === "https" && authToken) {
				const authHeader = req.headers.get("Authorization") ?? "";
				const expected = BEARER_PREFIX + authToken;
				const a = Buffer.from(authHeader);
				const b = Buffer.from(expected);
				if (a.length !== b.length || !timingSafeEqual(a, b)) {
					return new Response(`Unauthorized`, { status: 401 });
				}
			}

			if (url.pathname === "/ws") {
				const instance = url.searchParams.get("instance") ?? "";
				const upgraded = server.upgrade(req, {
					data: { shortHash: "", instance },
				});
				// Bun expects undefined after upgrade; types require the cast.
				if (upgraded) return undefined as unknown as Response;
				return new Response(`WebSocket upgrade failed`, { status: 400 });
			}

			if (url.pathname === "/status") {
				const clients = getAllClients().map((c) => ({
					clientId: c.shortHash,
					...(c.instance && { instance: c.instance }),
					connectedAt: c.connectedAt.toISOString(),
					remoteAddress: c.remoteAddress,
				}));
				return Response.json({ mode, hostname, port, clients });
			}

			return new Response(`Not Found`, { status: 404 });
		},
		websocket: {
			open(ws) {
				const address = ws.remoteAddress || "unknown";
				const instance = ws.data.instance;
				const session = addClient(ws, address, instance);
				const instanceLabel = instance ? ` [${instance}]` : "";
				console.error(`${TAG} Client connected: ${session.shortHash}${instanceLabel} (${address})`);
			},
			message(ws, message) {
				const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
				const hash = ws.data.shortHash;

				let data: Record<string, unknown>;
				try {
					data = JSON.parse(raw);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`${TAG} JSON parse failed from ${hash}: ${msg} | head: ${raw.slice(0, 200)}`);
					return;
				}

				if (
					data.type === "chunk" &&
					typeof data.id === "string" &&
					typeof data.seq === "number" &&
					typeof data.total === "number" &&
					typeof data.payload === "string"
				) {
					console.error(
						`${TAG} chunk recv id=${data.id} seq=${data.seq}/${data.total - 1} from=${hash} msg_bytes=${raw.length}`,
					);
					const reassembled = acceptChunk(hash, data.id, data.seq, data.total, data.payload);
					if (reassembled == null) return;
					console.error(`${TAG} reassembled id=${data.id} total_chars=${reassembled.length} from=${hash}`);
					let inner: Record<string, unknown>;
					try {
						inner = JSON.parse(reassembled);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						console.error(
							`${TAG} Reassembled JSON parse failed id=${data.id}: ${msg} | head: ${reassembled.slice(0, 200)}`,
						);
						return;
					}
					dispatchMessage(ws, inner);
					return;
				}

				dispatchMessage(ws, data);
			},
			close(ws) {
				const hash = ws.data.shortHash;
				console.error(`${TAG} Client disconnected: ${hash}`);
				removeClient(hash);

				for (const [id, pending] of pendingInvocations) {
					if (pending.clientHash === hash) {
						clearTimeout(pending.timer);
						pending.reject(new Error(`Client ${hash} disconnected during invocation`));
						pendingInvocations.delete(id);
					}
				}

				const prefix = `${hash}:`;
				for (const key of chunkStreams.keys()) {
					if (key.startsWith(prefix)) chunkStreams.delete(key);
				}
			},
		},
	});

	return { mode, hostname, port, server };
}
