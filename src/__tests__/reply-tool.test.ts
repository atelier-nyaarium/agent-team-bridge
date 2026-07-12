import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerPost } from "../mcp/bridge/helpers.js";
import { literalEscapeHazard, literalEscapeReject, postReply, readReplyAttachment } from "../mcp/bridge/replyTool.js";
import {
	buildChannelReplyPayload,
	buildStructuredReplyPayload,
	handleChannelReply,
	handleChannelReplyStructured,
	isEmptyResponseData,
} from "../mcp/channel/channelReply.js";
import { ChannelReplySchema, ChannelReplyStructuredSchema } from "../shared/schemas.js";

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: vi.fn(),
	bridgeProjectName: () => "test-team",
	bridgeConversationId: () => "conv-1",
	postPluginAction: vi.fn(async () => ({ delivered: true })),
}));

const mockRouterPost = vi.mocked(routerPost);

/** Captures registered tool handlers so a registrar's REAL closures are testable without an MCP
 * server. Returned handlers are invoked directly. */
function captureTools(register: (server: never) => void): Record<string, (args: never) => Promise<ToolResultLike>> {
	const tools: Record<string, (args: never) => Promise<ToolResultLike>> = {};
	const fake = {
		registerTool: (name: string, _meta: unknown, handler: (args: never) => Promise<ToolResultLike>) => {
			tools[name] = handler;
		},
	};
	register(fake as never);
	return tools;
}

type ToolResultLike = { content: Array<{ type: string; text: string }>; isError?: boolean };

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
			fullSpoken: "Body, spoken.",
		});
		const result = await handleChannelReply(args);
		expect(mockRouterPost).toHaveBeenCalledWith("/respond", {
			session_id: "s1",
			title: "Title",
			summary: "Summary sentence.",
			response: "Body.",
			fullSpoken: "Body, spoken.",
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

describe("literalEscapeHazard (the escaped-newline lint)", () => {
	const bs = "\\"; // one backslash character, so hazards below read as the agent would type them

	it("catches a literal escape used as a list break (the live incident's shape)", () => {
		expect(literalEscapeHazard(`app, everywhere.${bs}n- **Phase 2** (4990554): the decorator`)).toContain("n- ");
		expect(literalEscapeHazard(`edges.${bs}n${bs}n**Accepted v1 limitation**`)).toContain(`${bs}n${bs}n`);
		expect(literalEscapeHazard(`intro${bs}n# Heading`)).toContain("n# ");
	});

	it("passes real newlines, non-structural escape mentions, and Windows paths", () => {
		expect(literalEscapeHazard("line one\n- a real bullet\n\n# heading")).toBeNull();
		expect(literalEscapeHazard(`use ${bs}n in printf to end a line`)).toBeNull();
		expect(literalEscapeHazard(`saved under C:${bs}new-folder${bs}notes.txt`)).toBeNull();
	});

	it("exempts code: fenced blocks (backtick and tilde), inline spans, and an unclosed fence", () => {
		expect(literalEscapeHazard(`look:\n\`\`\`\nprintf("a${bs}n- b");\n\`\`\`\ndone`)).toBeNull();
		expect(literalEscapeHazard(`look:\n~~~\na${bs}n${bs}n b\n~~~\ndone`)).toBeNull();
		expect(literalEscapeHazard(`the regex \`${bs}n|${bs}r\` splits lines`)).toBeNull();
		// CommonMark treats an unterminated fence as code to end-of-string; so does the lint.
		expect(literalEscapeHazard(`look:\n\`\`\`\nprintf("a${bs}n- b");\nno closing fence`)).toBeNull();
	});

	it("still catches a hazard in prose before an unclosed fence", () => {
		expect(literalEscapeHazard(`broken${bs}n- bullet\nthen:\n\`\`\`\ncode tail`)).toContain("n- ");
	});

	it("does not manufacture a hazard by gluing text around stripped code", () => {
		// Deleting a span outright would turn these into "...\n- ..." - blanking must not.
		expect(literalEscapeHazard(`hello${bs}n\`world\`- test`)).toBeNull();
		expect(literalEscapeHazard(`Status codes:${bs}n\`404\`- Not Found`)).toBeNull();
	});

	it("follows CommonMark's strict closing-fence rule (delimiter plus whitespace only)", () => {
		// A delimiter line with trailing text inside a fence is CODE CONTENT, not a closer - the
		// renderer keeps the block open, so escapes there are exempt and the block runs on.
		expect(
			literalEscapeHazard(`\`\`\`\nfirst\n\`\`\` not-a-closer\nsecond${bs}n- still code\n\`\`\`\nafter`),
		).toBeNull();
		// An escape glued onto a would-be closer line keeps the fence open the same way the
		// renderer does - the whole tail stays code.
		expect(literalEscapeHazard(`intro\n\`\`\`\ncode\n\`\`\`${bs}n- glued after delimiter`)).toBeNull();
		// An opener's info string is never rendered; a tilde line cannot close a backtick fence.
		expect(
			literalEscapeHazard(`\`\`\`js${bs}n- in the info string\ncode\n~~~\nstill code${bs}n- x\n\`\`\`\ndone`),
		).toBeNull();
	});

	it("exempts double-backtick inline spans (run-length aware)", () => {
		expect(literalEscapeHazard(`code: \`\`${bs}n- x\`\``)).toBeNull();
		// A real hazard beside an unrelated double-backtick span is still caught.
		expect(literalEscapeHazard(`see \`\`code\`\` then${bs}n- REAL HAZARD`)).toContain("n- ");
	});

	it("is not derailed by a fence delimiter mentioned mid-line", () => {
		// A prose mention of ``` (not at a line start) must not open a fence and swallow a
		// later hazard.
		expect(
			literalEscapeHazard(`Use \` \`\`\` \` to start a fence.\nmore prose${bs}n- bullet hazard after`),
		).toContain("n- ");
	});

	it("produces a reject an agent can quote back verbatim without re-tripping the lint", () => {
		// Every snippet shape must round-trip: plain, backtick-bearing (the apostrophe swap), and
		// the double-escape shape.
		for (const hazardous of [
			`everywhere.${bs}n- Phase 2`,
			// An UNPAIRED backtick survives span-blanking into the snippet - the apostrophe swap
			// is what keeps the reject's own code span intact.
			`an unpaired \` tick${bs}n- struct`,
			`edges.${bs}n${bs}n**Accepted**`,
		]) {
			const snippet = literalEscapeHazard(hazardous);
			expect(snippet).not.toBeNull();
			const reject = literalEscapeReject("channel_reply", "full", snippet as string);
			expect(reject).toContain(`${bs}n`);
			expect(literalEscapeHazard(reject)).toBeNull();
		}
	});
});

describe("postReply escape-lint enforcement", () => {
	beforeEach(() => {
		mockRouterPost.mockReset();
		mockRouterPost.mockResolvedValue({});
	});

	it("rejects a hazardous field without posting, naming the field and showing the literal sequence", async () => {
		const result = await postReply(
			{ session_id: "s1", title: "T", summary: "S.", response: "done.\\n- next item" },
			{ toolName: "channel_reply", logPrefix: "channel" },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('"response"');
		// The error must SHOW the two-character sequence, not a real line break.
		expect(result.content[0].text).toContain("\\n");
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("names the tool-facing field the agent filled in, not the wire key it mapped to", async () => {
		const args = ChannelReplySchema.parse({
			session_id: "s1",
			title: "T",
			summary: "S.",
			full: "everywhere.\\n- Phase 2",
			fullSpoken: "clean spoken body.",
		});
		const result = await handleChannelReply(args);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('"full"');
		expect(result.content[0].text).not.toContain('"response"');
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("lints fullSpoken like every other prose tier", async () => {
		const args = ChannelReplySchema.parse({
			session_id: "s1",
			title: "T",
			summary: "S.",
			full: "clean body.",
			fullSpoken: "spoken.\\n- with a hazard",
		});
		const result = await handleChannelReply(args);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('"fullSpoken"');
		expect(mockRouterPost).not.toHaveBeenCalled();
	});

	it("treats absent and non-string fields as clean (structured and title-less payloads pass)", async () => {
		const result = await postReply(
			{ session_id: "s1", replyAsJson: { ok: true } },
			{ toolName: "channel_reply_structured", logPrefix: "channel" },
		);
		expect(result.isError).toBeUndefined();
		expect(mockRouterPost).toHaveBeenCalled();
	});

	it("passes a clean prose payload through to the POST", async () => {
		const result = await postReply(
			{ session_id: "s1", title: "T", summary: "S.", response: "line one\nline two" },
			{ toolName: "channel_reply", logPrefix: "channel" },
		);
		expect(result.isError).toBeUndefined();
		expect(mockRouterPost).toHaveBeenCalledWith("/respond", expect.objectContaining({ session_id: "s1" }));
	});
});

describe("registered-handler lint enforcement (notify_human, crosstalk_send, designer_push_card)", () => {
	const bs = "\\";

	beforeEach(() => {
		mockRouterPost.mockReset();
		mockRouterPost.mockResolvedValue({});
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
		mockRouterPost.mockResolvedValue({ delivered: true });
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
