import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSecretStore } from "../../federation-server/fileSecretStore.js";
import { RouterServer } from "../../federation-server/routerServer.js";
import { loadRouterTls } from "../../federation-server/routerTls.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { signAdmission, signRegister } from "../../shared/admission.js";
import { generateIdentity, type Identity } from "../../shared/crypto.js";

export const FEDERATION_TOKEN = "federation-test-token";
export const CONSOLE_TOKEN = "console-test-token";

export function randomPort(): number {
	return 30000 + Math.floor(Math.random() * 20000);
}

export interface RouterFixture {
	dir: string;
	port: number;
	server: RouterServer;
	owner: Identity;
	host: Identity;
	friendOwner: Identity;
	admission: ReturnType<typeof signAdmission>;
	stop(): Promise<void>;
}

export async function startRouter(options: { pendingTenant?: boolean } = {}): Promise<RouterFixture> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "switchboard-router-"));
	const store = new FileSecretStore(dir);
	await store.init();
	const owner = generateIdentity();
	const friendOwner = generateIdentity();
	const host = generateIdentity();
	const admission = signAdmission(
		{
			kind: "gateway",
			signPub: host.sign.pub,
			boxPub: host.box.pub,
			gatewayId: "laptop",
			issuedAt: Date.now(),
			nonce: "admission-nonce",
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	store.saveDomain("admin", {
		ownerSignPub: owner.sign.pub,
		ownerBoxPub: owner.box.pub,
		admissions: [admission],
		revocations: [],
		isAdminDomain: true,
	});
	await store.flushDomain("admin");
	store.saveDomain("friend", {
		ownerSignPub: friendOwner.sign.pub,
		ownerBoxPub: friendOwner.box.pub,
		admissions: [],
		revocations: [],
	});
	await store.flushDomain("friend");
	if (options.pendingTenant) {
		store.saveDomain("pending", {
			ownerSignPub: null,
			ownerBoxPub: null,
			admissions: [],
			revocations: [],
			pendingTenant: {
				displayName: "Pending",
				nonce: "pending-invite",
				issuedAt: Date.now(),
				ttlMs: 86_400_000,
				rooted: false,
			},
		});
		await store.flushDomain("pending");
	}
	const port = 0;
	const server = new RouterServer({
		port,
		dataDir: dir,
		consoleToken: CONSOLE_TOKEN,
		federationToken: FEDERATION_TOKEN,
		store,
		tls: loadRouterTls(dir),
	});
	await server.start();
	const listeningPort = server.listeningPort;
	if (listeningPort === null) throw new Error("router did not bind");
	return {
		dir,
		port: listeningPort,
		server,
		owner,
		friendOwner,
		host,
		admission,
		stop: async () => {
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function registerParams(
	fixture: RouterFixture,
	gatewayId = "laptop",
	nonce: string = crypto.randomUUID(),
	domainId = "admin",
) {
	const proofAt = Date.now();
	const domainOwner = domainId === "friend" ? fixture.friendOwner : fixture.owner;
	const admission = signAdmission(
		{
			kind: "gateway",
			signPub: fixture.host.sign.pub,
			boxPub: fixture.host.box.pub,
			gatewayId,
			issuedAt: proofAt,
			nonce: `admission-${gatewayId}`,
		},
		domainOwner.sign.priv,
		domainOwner.sign.pub,
	);
	return {
		domainId,
		gatewayId,
		protocolVersion: 1,
		signPub: fixture.host.sign.pub,
		boxPub: fixture.host.box.pub,
		admission: JSON.stringify(admission),
		proof: signRegister(gatewayId, proofAt, nonce, fixture.host.sign.priv),
		proofAt,
		proofNonce: nonce,
	};
}

export type Frame = Record<string, unknown>;

export function openGateway(port: number, token = FEDERATION_TOKEN): WebSocket {
	const Ctor = WebSocket as unknown as new (
		url: string,
		options?: { headers: Record<string, string>; rejectUnauthorized: boolean },
	) => WebSocket;
	return new Ctor(`wss://localhost:${port}/gateway`, {
		headers: { Authorization: `Bearer ${token}` },
		rejectUnauthorized: false,
	});
}

export function nextFrame(ws: WebSocket, predicate: (frame: Frame) => boolean): Promise<Frame> {
	return new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent) => {
			const frame = JSON.parse(String(event.data)) as Frame;
			if (!predicate(frame)) return;
			ws.removeEventListener("message", onMessage);
			resolve(frame);
		};
		const onError = () => {
			ws.removeEventListener("message", onMessage);
			reject(new Error("gateway socket error"));
		};
		ws.addEventListener("message", onMessage);
		ws.addEventListener("error", onError, { once: true });
	});
}

export async function callTool(ws: WebSocket, action: string, params: Record<string, unknown>): Promise<Frame> {
	const callId = crypto.randomUUID();
	ws.send(JSON.stringify({ type: "tool_call", callId, action, params }));
	// A refused call answers tool_error; only matching tool_result would hang the test on it.
	return nextFrame(
		ws,
		(frame) => (frame.type === "tool_result" || frame.type === "tool_error") && frame.callId === callId,
	);
}
