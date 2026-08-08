import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerPost } from "../mcp/bridge/helpers.js";
import { handleChannelReply } from "../mcp/channel/channelReply.js";
import { blobIdFor } from "../shared/blob-store.js";
import { ChannelReplySchema, REAL_NEWLINES_GUIDANCE } from "../shared/schemas.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";
import { captureTools } from "./helpers/replyTool.js";

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: vi.fn(),
	bridgeProjectName: () => "test-team",
	bridgeConversationId: () => "conv-1",
	postPluginAction: vi.fn(async () => ({ delivered: true })),
	confirmHandshakeRole: vi.fn(),
}));

const mockRouterPost = vi.mocked(routerPost);

////////////////////////////////
//  The blob plane under the tools
//
//  Attaching a file stages its bytes on the gateway before the tool posts anything, so a router
//  mock that answers everything with {} reports a failed transfer.

// Per test, not per file. A shared store lets one test's upload satisfy the next test's dedup
// check, so a transfer that never happened looks like one that did.
let wire: BlobWire;

beforeEach(() => {
	wire = mountBlobWire();
});

afterEach(() => {
	wire.dispose();
});

/** Point the router mock at a real blob store for the three transfer routes, and at [reply] for
 * everything else. Resets call history, so a test that asserts "did not post" still reads clean. */
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
		expect(result.content[0].text).toContain('"full"');
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
		expect(result.content[0].text).toContain('"fullSpoken"');
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
		expect(rejected.content[0].text).toContain('"displayLabel"');
		expect(mockRouterPost).not.toHaveBeenCalled();

		const hazardousBody = await tools.crosstalk_send({ to: "a.b.c.d", body: `task:${bs}n- item` } as never);
		expect(hazardousBody.isError).toBeUndefined();
		expect(mockRouterPost).toHaveBeenCalledWith("/send", expect.objectContaining({ body: `task:${bs}n- item` }));
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
		expect(result.content[0].text).toContain("absolute");
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("crosstalk_send names a polled reply's attachments and says how to actually get them", async () => {
		// A poll reads the PERSISTENT copy, which deliberately carries no reference (stripFileRefs:
		// /poll authorizes nobody, so a reference there would be a bearer token for the content).
		// Naming them is therefore the most this branch can honestly do, and saying so is the point -
		// claiming the sender attached nothing would be false AND would stop the agent asking for the
		// one thing that recovers them.
		const { registerBridgeSend } = await import("../mcp/bridge/bridgeSend.js");
		const tools = captureTools(registerBridgeSend);
		resetRouterPost({
			status: "completed",
			response: "done",
			session_id: "s1",
			files: [{ filename: "proof.png", mime: "image/png", size: 11, descriptiveKey: "proof.png" }],
		});

		const result = await tools.crosstalk_send({ session_id: "s1" } as never);
		expect(result.content[0].text).toContain("proof.png");
		expect(result.content[0].text).toContain("ask for a re-send");
		expect(result.content[0].text).not.toContain("carried no bytes");
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
		expect(result.content[0].text).toContain('"message"');
		expect(result.content[0].text).not.toContain('"response"');
		expect(mockRouterPost).not.toHaveBeenCalled();
	});
});

describe("lint conformance (every guidance-marked schema field is lint-enforced)", () => {
	// The guard has two halves: REAL_NEWLINES_GUIDANCE on a field's describe (the visible half)
	// and the handlers' enforcement loops (the enforcing half). They are coupled by convention
	// only, so this suite derives the field list from the SCHEMAS and drives the REAL handlers -
	// a field whose describe promises the guard but whose handler loop forgot it fails here.
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
			expect(result.content[0].text).toContain(`"${field}"`);
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
			expect(result.content[0].text).toContain(`"${field}"`);
			expect(mockRouterPost).not.toHaveBeenCalled();
		}
	});
});
