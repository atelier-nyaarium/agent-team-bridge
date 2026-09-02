import { describe, expect, it, vi } from "vitest";
import { type BoardMutation, createBoardClient } from "../gateway/router/boardClient.js";
import type { BoardAttachment } from "../shared/console-protocol.js";
import { openContent, sealContent } from "../shared/content-envelope.js";
import type { BoardStoredEntry } from "../shared/schemasBoardState.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";

const domainId = "domain";
const gatewayId = "gateway";
const ownerSignPub = "owner-signing-public-key";
const key = Buffer.alloc(32, 7);

const keys = {
	seal: (
		plaintext: Buffer,
		aad: { domainId: string; ownerSignPub: string; kind: "board.title" | "board.body" | "board.name" },
	) => ({
		kind: "ok" as const,
		envelope: sealContent(plaintext, key, { ...aad, epoch: 1 }),
	}),
	open: (
		envelope: ContentEnvelope,
		aad: {
			domainId: string;
			ownerSignPub: string;
			epoch: number;
			kind: "board.title" | "board.body" | "board.name";
		},
	) => {
		if (envelope.epoch !== 1) return { kind: "missing_epoch" as const, epoch: envelope.epoch };
		try {
			return { kind: "ok" as const, plaintext: openContent(envelope, key, aad) };
		} catch {
			return { kind: "bad_tag" as const };
		}
	},
};

const client = (
	call: (action: string, params: Record<string, unknown>) => Promise<{ result?: unknown; error?: string }>,
	attempts?: number,
) => createBoardClient({ call, domainId, gatewayId, ownerSignPub: () => ownerSignPub, keys, attempts });

const sealed = (text: string, kind: "board.title" | "board.body" | "board.name", epoch = 1): ContentEnvelope =>
	sealContent(Buffer.from(text), key, { domainId, ownerSignPub, kind, epoch });

const stored = (id: string, title: string, extra: Partial<BoardStoredEntry["clear"]> = {}): BoardStoredEntry => ({
	clear: { id, state: "open", rank: "A", version: 1, ...extra },
	sealed: { title: sealed(title, "board.title") },
});

const clearAttachment = ({ blobId, size, mime, blobGateway }: BoardAttachment) => ({
	blobId,
	size,
	mime,
	blobGateway,
});

const storedWithText = (id: string, title: string, body: string, attachment?: BoardAttachment): BoardStoredEntry => ({
	...stored(id, title, attachment ? { attachments: [clearAttachment(attachment)] } : {}),
	sealed: {
		title: sealed(title, "board.title"),
		body: sealed(body, "board.body"),
		...(attachment ? { names: { [attachment.blobId]: sealed(attachment.filename, "board.name") } } : {}),
	},
});

const readAnswer = (revision: number, entries: BoardStoredEntry[]) => ({ result: { revision, entries } });

describe("board client", () => {
	it("opens titles, bodies, and attachment filenames", async () => {
		const attachment = {
			blobId: "blob-1",
			filename: "report.txt",
			mime: "text/plain",
			size: 12,
			blobGateway: "gateway",
		};
		const call = vi.fn().mockResolvedValue(readAnswer(3, [storedWithText("one", "Title", "Body", attachment)]));

		const answer = await client(call).read();

		expect(answer).toEqual({
			kind: "ok",
			revision: 3,
			entries: [{ id: "one", title: "Title", body: "Body", state: "open", rank: "A", attachments: [attachment] }],
		});
		expect(call).toHaveBeenCalledWith("board_read", {});
	});

	it("keeps entries whose title epoch is unavailable", async () => {
		const entry = stored("one", "ignored");
		entry.sealed.title = sealed("hidden", "board.title", 2);
		const call = vi.fn().mockResolvedValue(readAnswer(1, [entry]));

		expect(await client(call).read()).toEqual({
			kind: "ok",
			revision: 1,
			entries: [{ id: "one", title: "[unavailable]", state: "open", rank: "A" }],
		});
	});

	it("seals mutation text before sending it to the Router", async () => {
		const entry = stored("one", "Old");
		const call = vi
			.fn()
			.mockResolvedValueOnce(readAnswer(1, [entry]))
			.mockResolvedValueOnce({ result: { outcome: "applied", revision: 2, entries: [entry], cascaded: [] } });

		await client(call).mutate("alpha", () => [
			{ kind: "upsert", id: "two", rank: "B", title: "Secret title", body: "Secret body" },
		]);

		const params = call.mock.calls[1]?.[1] as {
			write: { ops: Array<{ title?: ContentEnvelope; body?: ContentEnvelope }> };
		};
		const op = params.write.ops[0]!;
		expect(op.title).toMatchObject({ v: 1, epoch: 1 });
		expect(op.body).toMatchObject({ v: 1, epoch: 1 });
		// Over the whole frame: the plaintext must not survive anywhere in what the Router receives.
		const wire = JSON.stringify(params);
		expect(wire).not.toContain("Secret title");
		expect(wire).not.toContain("Secret body");
	});

	it("rebuilds a conflict from its carried entries and retries", async () => {
		const initial = stored("one", "Initial");
		const conflict = stored("one", "Winner");
		const applied = stored("one", "Winner", { state: "done", version: 2 });
		const seenTitles: string[] = [];
		const mutation: BoardMutation = (view) => {
			seenTitles.push(view.entry("one")!.title);
			return [{ kind: "set_state", id: "one", state: "done" }];
		};
		const call = vi
			.fn()
			.mockResolvedValueOnce(readAnswer(1, [initial]))
			.mockResolvedValueOnce({ result: { outcome: "conflict", revision: 2, entries: [conflict], cascaded: [] } })
			.mockResolvedValueOnce({ result: { outcome: "applied", revision: 3, entries: [applied], cascaded: [] } });

		const answer = await client(call).mutate("alpha", mutation);

		expect(call).toHaveBeenCalledTimes(3);
		expect(seenTitles).toEqual(["Initial", "Winner"]);
		expect(call.mock.calls[2]?.[1]).toMatchObject({ write: { expectedRevision: 2 } });
		expect(answer).toMatchObject({ kind: "applied", revision: 3, entries: [{ title: "Winner", state: "done" }] });
	});

	it("reports unavailable after conflicts exhaust the attempts limit", async () => {
		const entry = stored("one", "Title");
		const call = vi
			.fn()
			.mockResolvedValue({ result: { outcome: "conflict", revision: 2, entries: [entry], cascaded: [] } });

		const answer = await client(call, 2).mutate("alpha", () => [{ kind: "set_state", id: "one", state: "done" }]);

		expect(call).toHaveBeenCalledTimes(3);
		expect(answer).toEqual({ kind: "unavailable", error: "board is busy" });
	});

	it("preserves refusal answers", async () => {
		const entry = stored("one", "Title");
		const call = vi
			.fn()
			.mockResolvedValueOnce(readAnswer(1, [entry]))
			.mockResolvedValueOnce({
				result: { outcome: "refused", revision: 1, entries: [entry], refusal: "held", cascaded: [] },
			});

		expect(await client(call).mutate("alpha", () => [{ kind: "set_state", id: "one", state: "done" }])).toEqual({
			kind: "refused",
			refused: "held",
		});
	});

	it("round-trips local session keys", async () => {
		const entry = stored("one", "Title", { session: { domainId, gatewayId, sessionId: "alpha" } });
		const call = vi
			.fn()
			.mockResolvedValueOnce(readAnswer(1, []))
			.mockResolvedValueOnce({ result: { outcome: "applied", revision: 2, entries: [entry], cascaded: [] } });

		const answer = await client(call).mutate("alpha", () => [
			{ kind: "upsert", id: "one", rank: "A", title: "Title", sessionKey: "alpha" },
		]);

		expect(call.mock.calls[1]?.[1]).toMatchObject({ sessionId: "alpha" });
		expect(call.mock.calls[1]?.[1]).toMatchObject({
			write: { ops: [{ session: { domainId, gatewayId, sessionId: "alpha" } }] },
		});
		expect(await client(vi.fn().mockResolvedValue(readAnswer(2, [entry]))).read()).toMatchObject({
			entries: [{ id: "one", sessionId: "alpha" }],
		});
		expect(answer).toMatchObject({ kind: "applied" });
	});
});
