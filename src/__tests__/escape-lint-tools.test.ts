import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { opLedgerRefusal, routerPost } from "../mcp/bridge/helpers.js";
import { handleChannelReply } from "../mcp/channel/channelReply.js";
import { blobIdFor } from "../shared/blob-store.js";
import { ChannelReplySchema, REAL_NEWLINES_GUIDANCE } from "../shared/schemas.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";
import { captureTools } from "./helpers/replyTool.js";

vi.mock("../mcp/bridge/helpers.js", () => ({
	opLedgerRefusal: vi.fn(() => null),
	routerPost: vi.fn(),
	bridgeProjectName: () => "test-team",
	bridgeConversationId: () => "conv-1",
	postPluginAction: vi.fn(async () => ({ delivered: true })),
	confirmHandshakeRole: vi.fn(),
}));

const mockRouterPost = vi.mocked(routerPost);
let realRouterPost: typeof routerPost;

beforeAll(async () => {
	({ routerPost: realRouterPost } =
		await vi.importActual<typeof import("../mcp/bridge/helpers.js")>("../mcp/bridge/helpers.js"));
});

// Reset blob state per test.
let wire: BlobWire;

beforeEach(() => {
	wire = mountBlobWire();
});

afterEach(() => {
	wire.dispose();
});

function resetRouterPost(reply: unknown = {}): void {
	mockRouterPost.mockReset();
	mockRouterPost.mockImplementation(async (route: string, body: unknown) =>
		isBlobRoute(route) ? wire.answer(route, body) : reply,
	);
}

beforeEach(() => {
	resetRouterPost();
});

describe("registered-handler lint enforcement (notify_human, crosstalk_send, designer_push_card)", () => {
	const bs = "\\";

	beforeEach(() => {
		resetRouterPost();
	});

	it("notify_human rejects a hazardous full, naming the field, without posting", async () => {
		const { registerHumanTools } = await import("../mcp/channel/humanTools.js");
		const tools = captureTools(registerHumanTools);
		const result = await tools.notify_human({
			title: "T",
			summary: "S.",
			full: `done.${bs}n- next`,
		} as never);
		expect(result.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("notify_human posts all four tiers to /human/notify", async () => {
		const { registerHumanTools } = await import("../mcp/channel/humanTools.js");
		const tools = captureTools(registerHumanTools);
		resetRouterPost({ delivered: true });
		const result = await tools.notify_human({
			title: "T",
			summary: "S.",
			full: "# body",
			fullSpoken: "The body, spoken.",
		} as never);
		expect(result.isError).toBeUndefined();
		expect(mockRouterPost).toHaveBeenCalledWith(
			"/human/notify",
			expect.objectContaining({
				title: "T",
				summary: "S.",
				full: "# body",
				fullSpoken: "The body, spoken.",
			}),
		);
	});

	it("notify_human rejects a hazardous fullSpoken, naming the field, without posting", async () => {
		const { registerHumanTools } = await import("../mcp/channel/humanTools.js");
		const tools = captureTools(registerHumanTools);
		const result = await tools.notify_human({
			title: "T",
			summary: "S.",
			full: "clean body.",
			fullSpoken: `spoken.${bs}n- hazard`,
		} as never);
		expect(result.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("crosstalk_send rejects a hazardous displayLabel but leaves body unlinted", async () => {
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		const rejected = await tools.crosstalk_send({
			to: "a.b.c.d",
			body: "hi",
			displayLabel: `Bug${bs}n- List`,
		} as never);
		expect(rejected.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();

		const hazardousBody = await tools.crosstalk_send({ to: "a.b.c.d", body: `task:${bs}n- item` } as never);
		expect(hazardousBody.isError).toBeUndefined();
		expect(mockRouterPost).toHaveBeenCalledWith("/send", expect.objectContaining({ body: `task:${bs}n- item` }));
	});

	// Refuse silent opId loss.
	it("crosstalk_send refuses rather than sending an opId the gateway cannot honour", async () => {
		vi.mocked(opLedgerRefusal).mockReturnValueOnce("gateway too old");
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);

		const refused = await tools.crosstalk_send({ to: "a.b.c.d", body: "hi" } as never);

		expect(refused.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("crosstalk_send carries attachments to /send as blob references", async () => {
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		const dir = mkdtempSync(join(tmpdir(), "crosstalk-att-"));
		const path = join(dir, "shot.png");
		writeFileSync(path, "bytes");

		try {
			const result = await tools.crosstalk_send({ to: "a.b.c.d", body: "look", attachments: [path] } as never);
			expect(result.isError).toBeUndefined();
			expect(mockRouterPost).toHaveBeenCalledWith(
				"/send",
				expect.objectContaining({
					files: [
						expect.objectContaining({
							filename: "shot.png",
							mime: "image/png",
							blobId: blobIdFor(Buffer.from("bytes")),
						}),
					],
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries the same send request body", async () => {
		const bodies: string[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(String(init?.body));
			if (bodies.length < 3) throw new Error("offline");
			return new Response("{}", { status: 200 });
		});
		mockRouterPost.mockImplementation((route, body) =>
			realRouterPost(route, body, { retries: 2, retryDelayMs: 0 }),
		);
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		await tools.crosstalk_send({ to: "a.b.c.d", body: "hello" } as never);
		expect(bodies).toHaveLength(3);
		expect(bodies[1]).toBe(bodies[0]);
		expect(bodies[2]).toBe(bodies[0]);
		fetchMock.mockRestore();
	});

	it("crosstalk_send with a session_id and attachments sends rather than polling", async () => {
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		const dir = mkdtempSync(join(tmpdir(), "crosstalk-att-"));
		const path = join(dir, "log.txt");
		writeFileSync(path, "trace");

		try {
			await tools.crosstalk_send({ to: "a.b.c.d", body: "here", session_id: "s1", attachments: [path] } as never);
			expect(mockRouterPost).toHaveBeenCalledWith("/send", expect.anything());
			expect(mockRouterPost).not.toHaveBeenCalledWith("/poll", expect.anything());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("crosstalk_send surfaces an unreadable attachment without posting", async () => {
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		const result = await tools.crosstalk_send({
			to: "a.b.c.d",
			body: "look",
			attachments: ["relative/path.png"],
		} as never);
		expect(result.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("crosstalk_send names a polled reply's attachments and says how to actually get them", async () => {
		// Poll results omit content references.
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		resetRouterPost({
			status: "completed",
			response: "done",
			session_id: "s1",
			files: [{ filename: "proof.png", mime: "image/png", size: 11, descriptiveKey: "proof.png" }],
		});

		const result = await tools.crosstalk_send({ session_id: "s1" } as never);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toBeTruthy();
	});

	it("designer_push_card rejects a hazardous message, naming the tool-facing field", async () => {
		const { registerDesignerTools } = await import("../mcp/designer/designerTools.js");
		const tools = captureTools(registerDesignerTools);
		const result = await tools.designer_push_card({
			session_id: "s1",
			name: "card.html",
			html: "<!-- @dsCard -->",
			message: `see:${bs}n- the card`,
		} as never);
		expect(result.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();
	});
});

describe("lint conformance (every guidance-marked schema field is lint-enforced)", () => {
	// Guidance and enforcement must stay aligned.
	const bs = "\\";

	beforeEach(() => {
		resetRouterPost();
	});

	function guidedFields(shape: Record<string, { description?: string }>): string[] {
		return Object.entries(shape)
			.filter(([, field]) => field.description?.includes(REAL_NEWLINES_GUIDANCE))
			.map(([name]) => name);
	}

	it("channel_reply rejects a hazard in each guidance-marked field, naming it", async () => {
		const fields = guidedFields(ChannelReplySchema.shape);
		expect(fields).toEqual(expect.arrayContaining(["title", "summary", "full", "fullSpoken"]));
		for (const field of fields) {
			mockRouterPost.mockClear();
			const args = ChannelReplySchema.parse({
				session_id: "s1",
				title: "T",
				summary: "S.",
				full: "body.",
				fullSpoken: "body, spoken.",
				[field]: `x.${bs}n- y`,
			});
			const result = await handleChannelReply(args);
			expect(result.isError, `guidance-marked field "${field}" is not lint-enforced`).toBe(true);
			expect(mockRouterPost).not.toHaveBeenCalled();
		}
	});

	it("notify_human rejects a hazard in each guidance-marked field, naming it", async () => {
		const { registerHumanTools, NotifyHumanSchema } = await import("../mcp/channel/humanTools.js");
		const tools = captureTools(registerHumanTools);
		const fields = guidedFields(NotifyHumanSchema.shape as never);
		expect(fields).toEqual(expect.arrayContaining(["title", "summary", "full", "fullSpoken"]));
		for (const field of fields) {
			mockRouterPost.mockClear();
			const result = await tools.notify_human({
				title: "T",
				summary: "S.",
				full: "body.",
				fullSpoken: "body, spoken.",
				[field]: `x.${bs}n- y`,
			} as never);
			expect(result.isError, `guidance-marked field "${field}" is not lint-enforced`).toBe(true);
			expect(mockRouterPost).not.toHaveBeenCalled();
		}
	});

	it("the enforced fields outside the derived loops still promise the guard in their describe", async () => {
		// Direct handlers must retain guidance.
		const { PushCardSchema } = await import("../mcp/designer/designerTools.js");
		const { BridgeSendSchema } = await import("../mcp/bridge/bridgeSend.js");

		for (const [label, description] of [
			["designer_push_card.message", PushCardSchema.shape.message.description],
			["crosstalk_send.displayLabel", BridgeSendSchema.shape.displayLabel.description],
		] as const) {
			expect(description, `${label} is lint-enforced but its describe does not say so`).toContain(
				REAL_NEWLINES_GUIDANCE,
			);
		}
	});
});
