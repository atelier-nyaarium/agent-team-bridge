import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitChannelNotification } from "../mcp/channel/channelNotify.js";
import { BlobStore, blobIdFor } from "../shared/blob-store.js";

const root = join(tmpdir(), `channel-notify-${process.pid}`);
const store = new BlobStore(root);
const buckets = ["message-1", "message-2"].map((id) => join("/tmp/switchboard-channel-files", id));

beforeEach(() => {
	for (const bucket of buckets) rmSync(bucket, { recursive: true, force: true });
});

vi.mock("../mcp/bridge/helpers.js", () => ({
	opLedgerRefusal: () => null,
	routerPost: async (route: string, body: { blobId: string; offset?: number; length?: number }) => {
		if (route !== "/blob/get") throw new Error(`unexpected route ${route}`);
		const read = store.read(body.blobId, body.offset ?? 0, body.length ?? 1_048_576);
		return { chunk: read.bytes.toString("base64"), eof: read.eof };
	},
}));

describe("channel notification delivery", () => {
	it("materializes bytes and delivers decoded metadata", async () => {
		const bytes = Buffer.from("trace");
		const blobId = blobIdFor(bytes);
		store.write(blobId, 0, bytes, true);
		const sent: unknown[] = [];

		await emitChannelNotification({ notification: async (value: unknown) => sent.push(value) } as never, {
			type: "channel_push",
			from: "peer",
			body: "attached",
			session_id: "s1",
			message_id: "message-1",
			files: [
				{
					filename: "trace.log",
					mime: "text/plain",
					size: bytes.length,
					descriptiveKey: "trace.log",
					role: "attachment",
					blobId,
				},
			],
		});

		const target = join("/tmp/switchboard-channel-files", "message-1", "trace.log");
		const notification = sent[0] as { params: { content: string; meta: Record<string, unknown> } };
		expect({
			content: notification.params.content,
			meta: notification.params.meta,
			bytes: statSync(target).size,
		}).toEqual({
			content: expect.stringContaining(target),
			meta: { session_id: "s1", from: "peer", instructions: expect.any(String) },
			bytes: bytes.length,
		});
	});

	it("removes snapshots by declared role and keeps ordinary names", async () => {
		const bytes = Buffer.from("yes");
		const blobId = blobIdFor(bytes);
		store.write(blobId, 0, bytes, true);
		const sent: unknown[] = [];
		await emitChannelNotification({ notification: async (value: unknown) => sent.push(value) } as never, {
			type: "channel_push",
			from: "peer",
			body: "files",
			session_id: "s1",
			message_id: "message-2",
			files: [
				{
					filename: "switchboard-references.json",
					mime: "application/json",
					size: 3,
					descriptiveKey: "manifest",
					role: "attachment",
					blobId,
				},
				{
					filename: "snapshot.txt",
					mime: "text/plain",
					size: 3,
					descriptiveKey: "snapshot",
					role: "ref-snapshot",
					blobId,
				},
			],
		});
		expect((sent[0] as { params: { content: string } }).params.content).toContain("switchboard-references.json");
	});
});
