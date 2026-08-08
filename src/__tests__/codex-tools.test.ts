import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initBridge, routerErrorText, routerPost } from "../mcp/bridge/helpers.js";
import { codexRequestBody } from "../mcp/codex/codexTools.js";
import {
	CodexGatewayRequestSchema,
	CodexRequestErrorSchema,
	sanitizeCodexErrorText,
} from "../shared/codex-thinking.js";

describe("what a tool actually sends", () => {
	it("builds a request the gateway's own schema accepts, for every kind", () => {
		const bodies = [
			codexRequestBody("start", { prompt: "Audit" }),
			codexRequestBody("message", { agentId: "codex_0123456789abcdef0123456789abcdef", prompt: "Continue" }),
			codexRequestBody("await", { agentId: "codex_0123456789abcdef0123456789abcdef" }),
			codexRequestBody("stop", { agentId: "codex_0123456789abcdef0123456789abcdef" }),
			codexRequestBody("list"),
		];

		// The gateway is strict, so an extra or misnamed field is a 400 the caller cannot act on.
		for (const body of bodies) expect(CodexGatewayRequestSchema.safeParse(body).success).toBe(true);
	});

	it("mints a distinct operation id per invocation, and only where one is needed", () => {
		const first = codexRequestBody("start", { prompt: "Audit" });
		const second = codexRequestBody("start", { prompt: "Audit" });

		// Two tool calls are two mutations even with identical text; sharing an id would make the
		// second a replay of the first.
		expect(first.operationId).not.toBe(second.operationId);
		expect(codexRequestBody("await", { agentId: "codex_0123456789abcdef0123456789abcdef" })).not.toHaveProperty(
			"operationId",
		);
		expect(codexRequestBody("list")).not.toHaveProperty("operationId");
	});

	it("omits an absent model rather than sending it undefined", () => {
		// A strict schema rejects a key that is present and undefined, so this is not cosmetic.
		expect(codexRequestBody("start", { prompt: "Audit" })).not.toHaveProperty("model");
		expect(codexRequestBody("start", { prompt: "Audit", model: "gpt-5.6-sol" })).toMatchObject({
			model: "gpt-5.6-sol",
		});
		// A model belongs to a thread's whole life, so it exists on start alone.
		expect(
			codexRequestBody("message", { agentId: "codex_0123456789abcdef0123456789abcdef", prompt: "x", model: "s" }),
		).not.toHaveProperty("model");
	});

	it("defaults awaitResponse to true, and carries an explicit false", () => {
		expect(codexRequestBody("start", { prompt: "Audit" })).toMatchObject({ awaitResponse: true });
		expect(codexRequestBody("start", { prompt: "Audit", awaitResponse: false })).toMatchObject({
			awaitResponse: false,
		});
	});
});

describe("what a caller reads back from the gateway", () => {
	let server: http.Server;
	let reply: { status: number; body: unknown } = { status: 200, body: {} };
	const received: unknown[] = [];

	beforeAll(async () => {
		// A real socket, not a mock: a mock that hands back a plain string for `error` would pass even
		// though a structured refusal object stringifies to the literal text "[object Object]", hiding
		// exactly the shape mismatch this test exists to catch.
		server = http.createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				received.push(JSON.parse(raw));
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(reply.body));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		initBridge({ routerUrl: `http://127.0.0.1:${port}`, projectName: "recipe-app.work", agentType: "claude" });
	});

	afterAll(() => {
		server.close();
	});

	it("renders a structured refusal's message rather than its object", async () => {
		reply = {
			status: 400,
			body: CodexRequestErrorSchema.parse({
				error: {
					code: "invalid_input",
					retryable: false,
					message: sanitizeCodexErrorText("agent already has an unresolved prompt delivery"),
				},
			}),
		};

		await expect(routerPost("/codex", codexRequestBody("list"), { retries: 0 })).rejects.toThrow(
			"agent already has an unresolved prompt delivery",
		);
	});

	it("still renders a plain string error, which most routes answer with", async () => {
		reply = { status: 404, body: { error: "not found" } };
		await expect(routerPost("/codex", codexRequestBody("list"), { retries: 0 })).rejects.toThrow("not found");
	});

	it("returns the gateway's result unchanged on success", async () => {
		reply = { status: 200, body: { agentId: "codex_0123456789abcdef0123456789abcdef", observation: "terminal" } };
		await expect(routerPost("/codex", codexRequestBody("list"), { retries: 0 })).resolves.toMatchObject({
			observation: "terminal",
		});
	});

	it("sends a body the gateway can parse", async () => {
		reply = { status: 200, body: {} };
		received.length = 0;
		await routerPost("/codex", codexRequestBody("start", { prompt: "Audit", awaitResponse: false }), {
			retries: 0,
		});

		expect(CodexGatewayRequestSchema.safeParse(received[0]).success).toBe(true);
	});
});

describe("routerErrorText", () => {
	it("falls back rather than inventing text when the shape is neither", () => {
		expect(routerErrorText(undefined)).toBeUndefined();
		expect(routerErrorText({ code: "invalid_input" })).toBeUndefined();
		expect(routerErrorText(42)).toBeUndefined();
	});
});
