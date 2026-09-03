import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsoleSurface } from "../federation-server/consoleSurface.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { PublicApproval } from "../federation-server/publicApproval.js";
import { RouterServer } from "../federation-server/routerServer.js";
import { loadRouterTls } from "../federation-server/routerTls.js";
import { generateIdentity } from "../shared/crypto.js";
import { signFirstRoot } from "../shared/federation-lifecycle.js";

describe("federation router surfaces", () => {
	it("persists the router certificate and rejects a corrupt pair", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "router-tls-"));
		try {
			const first = loadRouterTls(dir);
			const second = loadRouterTls(dir);
			expect(second.certFp).toBe(first.certFp);
			expect(readFileSync(path.join(dir, "router-key.pem"), "utf8")).toContain("PRIVATE KEY");
			rmSync(path.join(dir, "router-key.pem"));
			expect(() => loadRouterTls(dir)).toThrow(/present together/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps approval misses opaque and rejects non-public steps", async () => {
		const server = new PublicApproval({ port: 0, onApproval: async () => ({ ok: false, error: "miss" }) });
		const miss = await server.handleRequest(
			new Request("https://router/device-approval", {
				method: "POST",
				body: JSON.stringify({
					step: "join",
					approvalId: "YQ==",
					nonce: "Yg==",
					newSignPub: "Yw==",
					newBoxPub: "ZA==",
					device: "e",
				}),
			}),
		);
		expect(miss.status).toBe(200);
		const privateStep = await server.handleRequest(
			new Request("https://router/device-approval", {
				method: "POST",
				body: JSON.stringify({ step: "arm", approvalId: "YQ==", nonce: "Yg==" }),
			}),
		);
		expect(privateStep.status).toBe(404);
	});

	it("keeps health token-free and gates console requests", async () => {
		const surface = new ConsoleSurface({ port: 0, authToken: "secret" });
		expect((await surface.handleRequest(new Request("https://router/health"))).status).toBe(405);
		expect(
			(await surface.handleRequest(new Request("https://router/console", { method: "POST", body: "{}" }))).status,
		).toBe(401);
	});

	// reach and gateways are configuration and a roster, not state a signer could contest, so the
	// app token is their whole gate. Behind it, the answers are what the Router was handed.
	it("serves reach and gateways behind the app token, publicPort only when advertised", async () => {
		const surface = new ConsoleSurface({
			port: 0,
			authToken: "secret",
			onReach: () => ({
				publicHost: "switchboard.example.com",
				publicPort: 8443,
				lanAddresses: ["192.168.1.238"],
			}),
			onGateways: () => ({ gateways: [{ gatewayId: "sakura", signFp: "3E9A-77C1-0B4D-F2A6" }] }),
		});
		const post = (body: string, token?: string) =>
			surface.handleRequest(
				new Request("https://router/console", {
					method: "POST",
					headers: token ? { "x-console-bridge-token": `Bearer ${token}` } : {},
					body,
				}),
			);
		expect((await post('{"gateways":{}}')).status).toBe(401);
		const reach = await post('{"reach":{}}', "secret");
		expect(reach.status).toBe(200);
		expect(await reach.json()).toEqual({
			publicHost: "switchboard.example.com",
			publicPort: 8443,
			lanAddresses: ["192.168.1.238"],
		});
		const gateways = await post('{"gateways":{}}', "secret");
		expect(gateways.status).toBe(200);
		expect(await gateways.json()).toEqual({ gateways: [{ gatewayId: "sakura", signFp: "3E9A-77C1-0B4D-F2A6" }] });
	});

	it("refuses a first root when the owner key already roots another Domain", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "router-root-"));
		try {
			const store = new FileSecretStore(dir);
			await store.init();
			const owner = generateIdentity();
			store.saveDomain("admin", {
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [],
				revocations: [],
				isAdminDomain: true,
			});
			store.saveDomain("pending", {
				ownerSignPub: null,
				ownerBoxPub: null,
				admissions: [],
				revocations: [],
				pendingTenant: {
					displayName: "Pending",
					nonce: "cGVuZGluZy1pbnZpdGU=",
					issuedAt: Date.now(),
					ttlMs: 86_400_000,
					rooted: false,
				},
			});
			await store.flushDomain("admin");
			await store.flushDomain("pending");
			const router = new RouterServer({
				port: 0,
				dataDir: dir,
				consoleToken: "console-token",
				federationToken: "federation-token",
				store,
				tls: loadRouterTls(dir),
			});
			const signed = signFirstRoot(
				{
					domainId: "pending",
					ownerSignPub: owner.sign.pub,
					ownerBoxPub: owner.box.pub,
					nonce: "cGVuZGluZy1pbnZpdGU=",
					issuedAt: Date.now(),
				},
				owner.sign.priv,
			);
			const response = await router.consoleSurface.handleRequest(
				new Request("https://router/console", {
					method: "POST",
					headers: { "x-console-bridge-token": "Bearer console-token" },
					body: JSON.stringify({ firstRoot: signed }),
				}),
			);
			expect(response.ok).toBe(false);
			expect(await response.json()).toMatchObject({ ok: false });
			expect(store.loadDomain("pending")?.ownerSignPub).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
