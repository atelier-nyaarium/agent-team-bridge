import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";

////////////////////////////////
//  Interfaces & Types

export interface ClientData {
	shortHash: string;
	instance: string;
}

export interface ClientSession {
	shortHash: string;
	instance: string;
	ws: ServerWebSocket<ClientData>;
	connectedAt: Date;
	remoteAddress: string;
	registeredTools: string[];
}

////////////////////////////////
//  State

const clients = new Map<string, ClientSession>();

////////////////////////////////
//  Functions & Helpers

function generateShortHash(): string {
	for (let i = 0; i < 10; i++) {
		const hash = randomUUID().replace(/-/g, "").slice(0, 6);
		if (!clients.has(hash)) return hash;
	}
	throw new Error(`Failed to generate unique short hash after 10 attempts`);
}

export function addClient(ws: ServerWebSocket<ClientData>, remoteAddress: string, instance: string): ClientSession {
	if (instance) {
		for (const [hash, existing] of clients) {
			if (existing.instance === instance) {
				existing.ws.close(1000, `Replaced by new connection with instance "${instance}"`);
				clients.delete(hash);
				break;
			}
		}
	}

	const shortHash = generateShortHash();
	ws.data.shortHash = shortHash;
	ws.data.instance = instance;
	const session: ClientSession = {
		shortHash,
		instance,
		ws,
		connectedAt: new Date(),
		remoteAddress,
		registeredTools: [],
	};
	clients.set(shortHash, session);
	return session;
}

export function removeClient(shortHash: string): void {
	clients.delete(shortHash);
}

export function getClient(shortHash: string): ClientSession | undefined {
	return clients.get(shortHash);
}

export function getClientByInstance(instance: string): ClientSession | undefined {
	for (const session of clients.values()) {
		if (session.instance === instance) return session;
	}
	return undefined;
}

export function getAllClients(): ClientSession[] {
	return Array.from(clients.values());
}
