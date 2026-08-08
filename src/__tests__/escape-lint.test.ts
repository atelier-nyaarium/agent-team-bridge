import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerPost } from "../mcp/bridge/helpers.js";
import { literalEscapeHazard, literalEscapeReject, postReply } from "../mcp/bridge/replyTool.js";
import { handleChannelReply } from "../mcp/channel/channelReply.js";
import { ChannelReplySchema } from "../shared/schemas.js";

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: vi.fn(),
	bridgeProjectName: () => "test-team",
	bridgeConversationId: () => "conv-1",
	postPluginAction: vi.fn(async () => ({ delivered: true })),
	confirmHandshakeRole: vi.fn(),
}));

const mockRouterPost = vi.mocked(routerPost);

// No attachments anywhere in this file, so no blob plane: a plain router mock suffices.
// Resets call history, so a test that asserts "did not post" still reads clean.
function resetRouterPost(reply: unknown = {}): void {
	mockRouterPost.mockReset();
	mockRouterPost.mockImplementation(async () => reply);
}

beforeEach(() => {
	resetRouterPost();
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
		resetRouterPost();
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
