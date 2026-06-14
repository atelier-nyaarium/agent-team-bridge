import { describe, expect, it, vi } from "vitest";
import { createPhoneHandler } from "../arbiter/phone/phoneHandler.js";
import { createPhoneRelayPump } from "../arbiter/phone/relayPump.js";
import type { ConversationRegistry, TeamRegistry } from "../arbiter/websocket.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import type { PhoneRelayReply } from "../shared/phone-protocol.js";

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createPhoneRelayPump", () => {
	it("a valid frame flows through the real handler and the reply is sent", async () => {
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore: new DeviceMailboxStore(),
			localHostId: "test-host",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});
		const replies: PhoneRelayReply[] = [];
		const pump = createPhoneRelayPump({
			handleFrame: handler.handleFrame,
			sendReply: async (reply) => {
				replies.push(reply);
				return {};
			},
		});

		pump({
			type: "phone_relay",
			v: 1,
			device: "pixel",
			conversationId: "conv-1",
			opId: "op-1",
			op: { kind: "register" },
		});
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({ opId: "op-1", ok: true, result: { device: "pixel", cursor: 0 } });
		expect(registry.get("pixel")).toBeDefined();
	});

	it("an invalid frame with a usable opId gets an ok:false reply", async () => {
		const handleFrame = vi.fn();
		const replies: PhoneRelayReply[] = [];
		const pump = createPhoneRelayPump({
			handleFrame,
			sendReply: async (reply) => {
				replies.push(reply);
				return {};
			},
		});

		pump({ type: "phone_relay", opId: "op-bad", op: { kind: "nonsense" } });
		await flush();

		expect(handleFrame).not.toHaveBeenCalled();
		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({ opId: "op-bad", ok: false });
		expect(replies[0].error).toContain("Invalid relay frame");
	});

	it("an invalid frame without an opId is dropped without reply or throw", async () => {
		const handleFrame = vi.fn();
		const sendReply = vi.fn(async () => ({}));
		const pump = createPhoneRelayPump({ handleFrame, sendReply });

		pump("garbage");
		pump(null);
		pump({ type: "phone_relay" });
		await flush();

		expect(handleFrame).not.toHaveBeenCalled();
		expect(sendReply).not.toHaveBeenCalled();
	});

	it("a sendReply failure is contained (no unhandled rejection)", async () => {
		const pump = createPhoneRelayPump({
			handleFrame: async () => ({ type: "phone_relay_reply", v: 1, opId: "op-1", ok: true }),
			sendReply: async () => {
				throw new Error("evie gone");
			},
		});

		pump({
			type: "phone_relay",
			v: 1,
			device: "pixel",
			conversationId: "conv-1",
			opId: "op-1",
			op: { kind: "register" },
		});
		await flush();
		// Reaching here without vitest reporting an unhandled rejection is the assertion.
	});
});
