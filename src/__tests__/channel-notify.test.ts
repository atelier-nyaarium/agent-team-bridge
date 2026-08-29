import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it } from "vitest";
import { emitChannelNotification } from "../mcp/channel/channelNotify.js";
import type { ChannelPushPayload } from "../shared/types.js";

/** The harness renders every meta key as a <channel ...> tag attribute; `instructions` is the one
 * that tells the agent what it is expected to do with the message. */
async function metaFor(over: Partial<ChannelPushPayload>): Promise<Record<string, unknown>> {
	let meta: Record<string, unknown> = {};
	const server = {
		notification: async (n: { params: { meta: Record<string, unknown> } }) => {
			meta = n.params.meta;
		},
	} as unknown as Server;
	await emitChannelNotification(server, {
		type: "channel_push",
		from: "task-board",
		body: "something happened",
		session_id: "na-abc",
		...over,
	});
	return meta;
}

describe("what a channel push asks the agent to do", () => {
	it("renders riding awareness with its act label and closing line", async () => {
		let content = "";
		const server = {
			notification: async (n: { params: { content: string } }) => {
				content = n.params.content;
			},
		} as unknown as Server;
		await emitChannelNotification(server, {
			type: "channel_push",
			from: "sender",
			body: "message",
			session_id: "job",
			awareness: { from: "task-board", body: "The owner edited a.", act: "no_act" },
		});
		expect(content).toContain("[AWARENESS from task-board]");
		expect(content).toContain("For awareness only. It needs no action and no reply.");
		const meta = await metaFor({ awareness: { from: "task-board", body: "body", act: "no_act" } });
		expect(meta.awareness_act).toBe("no_act");
		expect(typeof meta.awareness_act).toBe("string");
	});

	it("renders the act_now awareness closing line", async () => {
		let content = "";
		const server = {
			notification: async (n: { params: { content: string } }) => {
				content = n.params.content;
			},
		} as unknown as Server;
		await emitChannelNotification(server, {
			type: "channel_push",
			from: "sender",
			body: "message",
			session_id: "job",
			awareness: { from: "task-board", body: "The owner trashed a.", act: "act_now" },
		});
		expect(content).toContain("Act on this before continuing.");
	});

	it("uses the act_now instruction for a standalone push", async () => {
		const meta = await metaFor({ no_ack: true, act: "act_now" });
		expect(meta.act).toBe("act_now");
		expect(meta.instructions).toContain("Act on this before continuing what you were doing.");
	});

	it("tells an awareness push to stay silent without telling it to disregard the content", async () => {
		// One of these carries a work handoff, so "do not treat this as a task" would arrive attached
		// to the assignment it is describing.
		const meta = await metaFor({ no_ack: true });
		expect(meta.instructions).toBe("Awareness only. Nobody is waiting on a reply, so do not send one.");
	});

	it("marks an awareness push structurally, not only in the instructions prose", async () => {
		expect((await metaFor({ no_ack: true })).no_ack).toBe("true");
		expect((await metaFor({})).no_ack).toBeUndefined();
	});

	it("keeps every meta value a string, since they are rendered as tag attributes", async () => {
		// A boolean here took the whole notification down with no error on either side.
		for (const value of Object.values(await metaFor({ no_ack: true, replyJsonSchema: "{}" }))) {
			expect(typeof value).toBe("string");
		}
	});

	it("keeps asking for a reply on an ordinary push", async () => {
		const meta = await metaFor({});
		expect(meta.instructions).toBe(
			"They are waiting on a reply. Reply with the channel_reply tool using this session_id. Plain text output does not reach the sender.",
		);
	});

	it("renders informing disposition", async () => {
		// Informing messages should not trigger acknowledgements.
		expect((await metaFor({ disposition: "informing" })).instructions).toBe(
			"No reply needed. Do not acknowledge. Reply only if this affects you in a way they would want to know now.",
		);
	});

	it("renders closing disposition", async () => {
		// Closing messages make silence the normal result.
		expect((await metaFor({ disposition: "closing" })).instructions).toBe(
			"Thread closed, no reply expected. Do not acknowledge; silence is correct here. Reply only if this breaks something on your side.",
		);
	});

	it("lets informing disposition override a reply schema", async () => {
		// A schema is meaningful only when the sender is asking.
		expect((await metaFor({ disposition: "informing", replyJsonSchema: "{}" })).instructions).toContain(
			"No reply needed",
		);
	});

	it("treats a disposition it does not know as asking, so a stray wire value cannot silence a question", async () => {
		const stray = "maybe" as unknown as "asking";
		expect((await metaFor({ disposition: stray })).instructions).toContain("They are waiting on a reply.");
		expect((await metaFor({ disposition: stray, replyJsonSchema: "{}" })).instructions).toContain(
			"channel_reply_structured",
		);
	});

	it("passes the disposition to meta as a string, and only when one was sent", async () => {
		expect((await metaFor({ disposition: "informing" })).disposition).toBe("informing");
		expect((await metaFor({})).disposition).toBeUndefined();
	});

	it("lets no_ack override disposition", async () => {
		// Gateway awareness pushes always win over sender conventions.
		expect((await metaFor({ no_ack: true, disposition: "asking" })).instructions).toBe(
			"Awareness only. Nobody is waiting on a reply, so do not send one.",
		);
	});

	it("routes a structured push to the structured tool", async () => {
		const meta = await metaFor({ replyJsonSchema: '{"type":"object"}' });
		expect(meta.instructions).toContain("channel_reply_structured");
		expect(meta.reply_schema).toBe('{"type":"object"}');
	});

	it("branches on exactly true, so a stray wire value cannot silence a real question", async () => {
		const meta = await metaFor({ no_ack: "yes" as unknown as boolean });
		expect(meta.instructions).toContain("channel_reply");
	});
});
