import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsoleSurface } from "../federation-server/consoleSurface.js";
import { PublicApproval } from "../federation-server/publicApproval.js";
import { loadRouterTls } from "../federation-server/routerTls.js";

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
					approvalId: "a",
					nonce: "b",
					newSignPub: "c",
					newBoxPub: "d",
					device: "e",
				}),
			}),
		);
		expect(miss.status).toBe(200);
		const privateStep = await server.handleRequest(
			new Request("https://router/device-approval", {
				method: "POST",
				body: JSON.stringify({ step: "arm", approvalId: "a", nonce: "b" }),
			}),
		);
		expect(privateStep.status).toBe(404);
	});

	it("keeps health token-free and gates console requests", async () => {
		const surface = new ConsoleSurface({ port: 0, authToken: "secret", getBridge: () => null });
		expect((await surface.handleRequest(new Request("https://router/health"))).status).toBe(405);
		expect(
			(await surface.handleRequest(new Request("https://router/console", { method: "POST", body: "{}" }))).status,
		).toBe(401);
	});
});
