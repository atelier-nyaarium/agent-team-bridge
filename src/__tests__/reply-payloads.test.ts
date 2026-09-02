import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerPost } from "../mcp/bridge/helpers.js";
import { readReplyAttachment } from "../mcp/bridge/replyTool.js";
import {
	buildChannelReplyPayload,
	buildStructuredReplyPayload,
	handleChannelReply,
	handleChannelReplyStructured,
	isEmptyResponseData,
} from "../mcp/channel/channelReply.js";
import { blobIdFor } from "../shared/blob-store.js";
import { ChannelReplySchema, ChannelReplyStructuredSchema } from "../shared/schemas.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";

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

/** The first post a tool made on its OWN behalf. An attachment's chunk transfers land ahead of it,
 * so the raw call list no longer starts with the call under test. */
function firstToolPost<T>(): [string, T] {
	const call = mockRouterPost.mock.calls.find(([route]) => !isBlobRoute(route as string));
	if (!call) throw new Error("no non-blob post was made");
	return call as [string, T];
}

describe("buildChannelReplyPayload", () => {
	it("maps full to the wire response field, with no full key on the payload", () => {
		const args = ChannelReplySchema.parse({
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			full: "The full prose reply.",
			fullSpoken: "The full prose reply, spoken.",
		});
		const payload = buildChannelReplyPayload(args);
		expect(payload).toEqual({
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			response: "The full prose reply.",
			fullSpoken: "The full prose reply, spoken.",
			conversationId: "conv-1",
		});
		expect(payload).not.toHaveProperty("full");
	});
});

describe("buildStructuredReplyPayload", () => {
	it("maps responseData to the wire replyAsJson field, with no response key", () => {
		const args = ChannelReplyStructuredSchema.parse({ session_id: "s1", responseData: { isMainOrLead: true } });
		const payload = buildStructuredReplyPayload(args);
		expect(payload).toEqual({ session_id: "s1", replyAsJson: { isMainOrLead: true }, conversationId: "conv-1" });
		expect(payload).not.toHaveProperty("response");
	});
});

describe("isEmptyResponseData", () => {
	it("flags an empty object", () => {
		expect(isEmptyResponseData({})).toBe(true);
	});

	it("does not flag a populated object", () => {
		expect(isEmptyResponseData({ isMainOrLead: true })).toBe(false);
	});

	it("flags null/undefined instead of throwing", () => {
		expect(isEmptyResponseData(null as unknown as Record<string, unknown>)).toBe(true);
		expect(isEmptyResponseData(undefined as unknown as Record<string, unknown>)).toBe(true);
	});
});

describe("readReplyAttachment", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("stages an attachment's bytes and names them, inferring its mime type from extension", async () => {
		dir = mkdtempSync(join(tmpdir(), "reply-tool-test-"));
		const filePath = join(dir, "note.txt");
		writeFileSync(filePath, "hello");
		const file = await readReplyAttachment(filePath);
		expect(file.filename).toBe("note.txt");
		expect(file.mime).toBe("text/plain");
		// The reference names the bytes, and the gateway is holding them: a message carries no copy.
		expect(file.blobId).toBe(blobIdFor(Buffer.from("hello")));
		expect(wire.read(file.blobId!).toString("utf8")).toBe("hello");
	});

	it("rejects a relative path", async () => {
		await expect(readReplyAttachment("relative/path.txt")).rejects.toThrow("must be absolute");
	});
});

describe("handleChannelReply / handleChannelReplyStructured (the actual registered handlers)", () => {
	let dir: string | undefined;

	beforeEach(() => {
		resetRouterPost();
	});

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("posts the mapped payload for a prose reply", async () => {
		const args = ChannelReplySchema.parse({
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			full: "Body.",
			fullSpoken: "Body, spoken.",
		});
		const result = await handleChannelReply(args);
		expect(mockRouterPost).toHaveBeenCalledWith("/respond", {
			opId: expect.any(String),
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			response: "Body.",
			fullSpoken: "Body, spoken.",
			conversationId: "conv-1",
		});
		expect(result.isError).toBeUndefined();
	});

	it("resolves attachments into a files array before posting", async () => {
		dir = mkdtempSync(join(tmpdir(), "reply-tool-test-"));
		const filePath = join(dir, "note.txt");
		writeFileSync(filePath, "hello");
		const args = ChannelReplySchema.parse({
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			full: "Body.",
			fullSpoken: "Body, spoken.",
			attachments: [filePath],
		});
		await handleChannelReply(args);
		const [, payload] = firstToolPost<Record<string, unknown>>();
		expect(payload.files).toEqual([
			{
				filename: "note.txt",
				mime: "text/plain",
				size: 5,
				descriptiveKey: "note.txt",
				modifiedAt: statSync(filePath).mtime.getTime(),
				blobId: blobIdFor(Buffer.from("hello")),
				role: "attachment",
			},
		]);
	});

	it("posts the mapped payload for a structured reply", async () => {
		const args = ChannelReplyStructuredSchema.parse({ session_id: "s1", responseData: { isMainOrLead: true } });
		const result = await handleChannelReplyStructured(args);
		expect(mockRouterPost).toHaveBeenCalledWith("/respond", {
			opId: expect.any(String),
			session_id: "s1",
			replyAsJson: { isMainOrLead: true },
			conversationId: "conv-1",
		});
		expect(result.isError).toBeUndefined();
	});

	it("rejects an empty responseData without ever posting", async () => {
		const args = ChannelReplyStructuredSchema.parse({ session_id: "s1", responseData: {} });
		const result = await handleChannelReplyStructured(args);
		expect(result.isError).toBe(true);
		expect(mockRouterPost).not.toHaveBeenCalled();
	});
});
