import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initBridge, routerErrorText, routerPost } from "../mcp/bridge/helpers.js";
import { codexRequestBody } from "../mcp/codex/codexTools.js";
import { CodexRequestErrorSchema, sanitizeCodexErrorText } from "../shared/codex-agent.js";

describe("Codex request identities", () => {
	it("mints distinct ids for mutations and none for reads", () => {
		const first = codexRequestBody("start", { prompt: "Audit" });
		const second = codexRequestBody("start", { prompt: "Audit" });
		expect(first.operationId).not.toBe(second.operationId);
		expect(codexRequestBody("await", { agentId: "codex_0123456789abcdef0123456789abcdef" })).not.toHaveProperty(
			"operationId",
		);
		expect(codexRequestBody("list")).not.toHaveProperty("operationId");
	});

	it("applies start defaults without copying them to later turns", () => {
		expect(codexRequestBody("start", { prompt: "Audit" })).toMatchObject({
			model: expect.any(String),
			serviceTier: "priority",
		});
		expect(codexRequestBody("start", { prompt: "Audit", model: "gpt-5.6-sol" })).not.toHaveProperty("serviceTier");
		expect(
			codexRequestBody("message", { agentId: "codex_0123456789abcdef0123456789abcdef", prompt: "Continue" }),
		).not.toHaveProperty("model");
	});
});

describe("routerPost", () => {
	let server: http.Server;
	let reply: { status: number; body: unknown };

	beforeAll(async () => {
		server = http.createServer((_request, response) => {
			response.writeHead(reply.status, { "content-type": "application/json" });
			response.end(JSON.stringify(reply.body));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		initBridge({ routerUrl: `http://127.0.0.1:${port}`, projectName: "recipe-app.work", agentType: "claude" });
	});

	afterAll(() => server.close());

	it("returns the parsed gateway value", async () => {
		reply = { status: 200, body: { agentId: "codex_0123456789abcdef0123456789abcdef", observation: "terminal" } };
		expect(await routerPost("/codex", codexRequestBody("list"), { retries: 0 })).toEqual(reply.body);
	});

	it("exposes structured HTTP failures as an error object", async () => {
		reply = {
			status: 400,
			body: CodexRequestErrorSchema.parse({
				error: { code: "invalid_input", retryable: false, message: sanitizeCodexErrorText("invalid request") },
			}),
		};
		try {
			await routerPost("/codex", codexRequestBody("list"), { retries: 0 });
			expect.fail("request should reject");
		} catch (error) {
			expect(error).toMatchObject({ status: 400 });
		}
	});

	it("preserves status when the error body is null", async () => {
		reply = { status: 502, body: null };
		try {
			await routerPost("/codex", codexRequestBody("list"), { retries: 0 });
			expect.fail("request should reject");
		} catch (error) {
			expect(error).toMatchObject({ status: 502 });
		}
	});
});

describe("routerErrorText", () => {
	it.each([
		["plain", "plain"],
		[{ message: "structured" }, "structured"],
		[undefined, undefined],
		[{ code: "invalid_input" }, undefined],
		[42, undefined],
	] as const)("extracts a supported value", (failure, expected) => expect(routerErrorText(failure)).toBe(expected));
});
