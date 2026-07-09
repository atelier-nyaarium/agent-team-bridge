import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ChannelReplySchema, ChannelReplyStructuredSchema } from "../shared/schemas.js";

vi.mock("../mcp/bridge/helpers.js", () => ({ routerPost: vi.fn() }));

const mockRouterPost = vi.mocked(routerPost);

describe("buildChannelReplyPayload", () => {
	it("maps full to the wire response field, with no full key on the payload", () => {
		const args = ChannelReplySchema.parse({
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			full: "The full prose reply.",
		});
		const payload = buildChannelReplyPayload(args);
		expect(payload).toEqual({
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			response: "The full prose reply.",
		});
		expect(payload).not.toHaveProperty("full");
	});
});

describe("buildStructuredReplyPayload", () => {
	it("maps responseData to the wire replyAsJson field, with no response key", () => {
		const args = ChannelReplyStructuredSchema.parse({ session_id: "s1", responseData: { isMainOrLead: true } });
		const payload = buildStructuredReplyPayload(args);
		expect(payload).toEqual({ session_id: "s1", replyAsJson: { isMainOrLead: true } });
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

	it("reads and base64-encodes an attachment, inferring its mime type from extension", async () => {
		dir = mkdtempSync(join(tmpdir(), "reply-tool-test-"));
		const filePath = join(dir, "note.txt");
		writeFileSync(filePath, "hello");
		const file = await readReplyAttachment(filePath);
		expect(file.filename).toBe("note.txt");
		expect(file.mime).toBe("text/plain");
		expect(file.base64).toBe(Buffer.from("hello").toString("base64"));
	});

	it("rejects a relative path", async () => {
		await expect(readReplyAttachment("relative/path.txt")).rejects.toThrow("must be absolute");
	});
});

describe("handleChannelReply / handleChannelReplyStructured (the actual registered handlers)", () => {
	let dir: string | undefined;

	beforeEach(() => {
		mockRouterPost.mockReset();
		mockRouterPost.mockResolvedValue({});
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
		});
		const result = await handleChannelReply(args);
		expect(mockRouterPost).toHaveBeenCalledWith("/respond", {
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			response: "Body.",
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
			attachments: [filePath],
		});
		await handleChannelReply(args);
		const [, payload] = mockRouterPost.mock.calls[0] as [string, Record<string, unknown>];
		expect(payload.files).toEqual([
			{ filename: "note.txt", mime: "text/plain", size: 5, descriptiveKey: "note.txt", base64: "aGVsbG8=" },
		]);
	});

	it("posts the mapped payload for a structured reply", async () => {
		const args = ChannelReplyStructuredSchema.parse({ session_id: "s1", responseData: { isMainOrLead: true } });
		const result = await handleChannelReplyStructured(args);
		expect(mockRouterPost).toHaveBeenCalledWith("/respond", {
			session_id: "s1",
			replyAsJson: { isMainOrLead: true },
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
