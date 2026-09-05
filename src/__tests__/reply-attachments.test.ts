import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readReplyAttachment, readReplyAttachments, wireModifiedAt } from "../mcp/bridge/replyTool.js";
import {
	buildChannelReplyPayload,
	buildStructuredReplyPayload,
	isEmptyResponseData,
} from "../mcp/channel/channelReply.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { ChannelFilesSchema, ChannelReplySchema, ChannelReplyStructuredSchema } from "../shared/schemas.js";

const storeRoot = join(tmpdir(), `reply-attachments-${process.pid}`);
const store = new BlobStore(storeRoot);

vi.mock("../mcp/bridge/helpers.js", () => ({
	opLedgerRefusal: () => null,
	routerPost: async (route: string, body: { blobId: string; offset?: number; chunk?: string; final?: boolean }) => {
		if (route === "/blob/stat") return store.stat(body.blobId);
		if (route === "/blob/put")
			return store.write(
				body.blobId,
				body.offset ?? 0,
				Buffer.from(body.chunk ?? "", "base64"),
				body.final ?? false,
			);
		throw new Error(`unexpected route ${route}`);
	},
	bridgeProjectName: () => "test-team",
	bridgeConversationId: () => "conv-1",
}));

describe("reply payloads and attachments", () => {
	it("maps prose and structured input to wire payloads", () => {
		expect(
			buildChannelReplyPayload(
				ChannelReplySchema.parse({
					session_id: "s",
					title: "t",
					summary: "s",
					full: "body",
					fullSpoken: "spoken",
				}),
			),
		).toMatchObject({
			session_id: "s",
			response: "body",
			conversationId: "conv-1",
		});
		expect(
			buildStructuredReplyPayload(
				ChannelReplyStructuredSchema.parse({ session_id: "s", responseData: { ok: true } }),
			),
		).toEqual({
			session_id: "s",
			replyAsJson: { ok: true },
			conversationId: "conv-1",
		});
	});

	it("classifies empty response data and valid modified times", () => {
		expect(isEmptyResponseData({})).toBe(true);
		expect(isEmptyResponseData({ ok: true })).toBe(false);
		expect(wireModifiedAt(new Date(1_552_555_613_589))).toEqual({ modifiedAt: 1_552_555_613_589 });
		expect(wireModifiedAt(new Date(Number.NaN))).toEqual({});
	});

	it("uploads a real file and returns schema-valid attachment metadata", async () => {
		const dir = mkdtempSync(join(tmpdir(), "reply-file-"));
		try {
			const filePath = join(dir, "note.txt");
			writeFileSync(filePath, "hello");
			const file = await readReplyAttachment(filePath);
			expect(file).toMatchObject({
				filename: "note.txt",
				mime: "text/plain",
				size: 5,
				role: "attachment",
				blobId: blobIdFor(Buffer.from("hello")),
			});
			expect(ChannelFilesSchema.safeParse([file]).success).toBe(true);
			expect(readFileSync(store.path(file.blobId!)!).toString()).toBe("hello");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recognizes cards, rejects directories, preserves order, and enforces the byte budget", async () => {
		const dir = mkdtempSync(join(tmpdir(), "reply-files-"));
		try {
			const card = join(dir, "card.html");
			const plain = join(dir, "plain.txt");
			writeFileSync(card, '<!-- @dsCard group="Kit" width="800" --><title>Editor</title>');
			writeFileSync(plain, "two");
			expect((await readReplyAttachment(card)).role).toBe("design-card");
			expect((await readReplyAttachments([plain, card])).map((file) => file.filename)).toEqual([
				"plain.txt",
				"card.html",
			]);
			await expect(readReplyAttachment(dir)).rejects.toThrow();
			expect(statSync(plain).size).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
