import { describe, expect, it } from "vitest";
import type { CodexAgentService } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import type { CodexDaemonEvent, CodexDaemonReceipt } from "../shared/codex-agent.js";
import {
	AGENT_ID,
	currentAgent,
	eventBase,
	RESOLVED_TARGET,
	settleRelay,
	setup,
	TARGET_ID,
	working,
} from "./helpers/codex-relay.js";

describe("Codex relay keying", () => {
	it("keeps two agents whose names concatenate identically apart", async () => {
		const context = working(setup());
		// "recipe-app.work" + "codex_aa..." vs "recipe-app.workcodex_aa..." + "" is the collision a bare
		// join allows. A separator that cannot appear inside either field is what rules it out.
		const shifted = `${context.ownerKey}x`;
		context.relay.handleHostMessage({
			...eventBase(shifted, 1),
			kind: "terminal",
			state: "completed",
			finalResponse: "not mine",
		} as unknown as CodexDaemonEvent);
		await settleRelay();

		// The real agent is untouched: the event named an owner that does not exist.
		expect(currentAgent(context).agentState).toBe("working");
		expect(currentAgent(context).turns[0]?.state).toBe("inProgress");
	});
});

describe("Codex relay acknowledgement", () => {
	function frame(context: ReturnType<typeof setup>, eventId: number, extra: Record<string, unknown>) {
		return { ...eventBase(context.ownerKey, eventId), ...extra } as unknown as CodexDaemonEvent;
	}

	const settle = settleRelay;

	it("acknowledges through an applied event", async () => {
		const context = working(setup());
		context.relay.handleHostMessage(frame(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		await Promise.resolve();

		expect(context.sent).toContainEqual({
			type: "codex_ack",
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 1,
			throughEventId: 1,
		});
	});

	it("withholds acknowledgement at and above an event it could not decide", async () => {
		const context = working(setup());
		context.relay.handleHostMessage(
			frame(context, 1, { turnId: "turn-unknown", kind: "activity", itemId: "item-1", text: "reading" }),
		);
		context.relay.handleHostMessage(frame(context, 2, { kind: "activity", itemId: "item-2", text: "more" }));
		await Promise.resolve();
		await Promise.resolve();

		const acks = context.sent.filter((message) => message.type === "codex_ack");
		expect(acks).toEqual([]);
		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(1);
	});

	it("asks for reconciliation once per agent no matter how many events stall", async () => {
		const context = working(setup());
		for (const eventId of [1, 2, 3]) {
			context.relay.handleHostMessage(
				frame(context, eventId, {
					turnId: "turn-unknown",
					kind: "activity",
					itemId: `item-${eventId}`,
					text: "x",
				}),
			);
		}
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const commands = context.sent.filter((message) => message.type === "codex_command");
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({ kind: "reconcile", agentId: AGENT_ID, threadId: "thread-1" });
	});

	it("releases the acknowledgement it withheld once reconciliation decides the held events", async () => {
		const context = working(setup());
		context.relay.handleHostMessage(
			frame(context, 1, { turnId: "turn-unknown", kind: "activity", itemId: "item-1", text: "reading" }),
		);
		context.relay.handleHostMessage(frame(context, 2, { kind: "activity", itemId: "item-2", text: "more" }));
		await settle();
		// Event 2 applied, but the ack floor stays below the undecided event 1 rather than skipping it.
		for (const ack of context.sent.filter((message) => message.type === "codex_ack")) {
			expect(ack.throughEventId as number).toBeLessThan(1);
		}

		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "reconciled",
			requestId: "123e4567-e89b-42d3-a456-4266141740aa",
			ownerKey: context.ownerKey,
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 1,
			eventId: 3,
			agentId: AGENT_ID,
			resolvedTarget: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
			turnState: "inProgress",
		});
		await settle();

		// The held event is decided (its turn does not exist, so it is refused), which is what lets the
		// stream advance past it instead of stalling for the life of the generation.
		const acks = context.sent.filter((message) => message.type === "codex_ack");
		expect(acks.at(-1)).toMatchObject({ throughEventId: 3 });
	});

	it("asks about a held frame on reconnect even after its agent has gone idle", async () => {
		const context = working(setup());
		context.attached = false;
		// Held, but the ask never left the socket.
		context.relay.handleHostMessage(
			frame(context, 1, { turnId: "turn-unknown", kind: "activity", itemId: "item-1", text: "reading" }),
		);
		await settle();

		context.attached = true;
		// The agent's real turn ends normally, so the record is idle and no longer "needs" reconciling.
		context.relay.handleHostMessage(
			frame(context, 2, { kind: "terminal", state: "completed", finalResponse: "done" }),
		);
		await settle();
		expect(currentAgent(context).agentState).toBe("idle");
		context.sent.length = 0;

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});
		await settle();

		// Without this, the hold caps the acknowledgement for every agent on this target forever.
		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile", agentId: AGENT_ID },
		]);
	});

	it("never acknowledges a frame it could not turn into a record", async () => {
		const context = working(setup());
		// A reducer that cannot build a valid record reports `failed`. That is a fact about the gateway,
		// not about the frame, so acknowledging it would make the daemon delete the only copy of this
		// turn's outcome. Stubbed because the natural triggers are schema edges, and the invariant under
		// test belongs to the relay rather than to any one of them.
		const stub = {
			...context.service,
			applyEvent: () => ({ disposition: "failed" as const, reason: "stubbed reducer failure" }),
		} as unknown as CodexAgentService;
		const sent: Record<string, unknown>[] = [];
		const relay = new CodexRelay({
			service: stub,
			sessionStore: context.sessionStore,
			sendToHost: (message) => {
				sent.push(message);
				return true;
			},
		});

		relay.handleHostMessage({
			...eventBase(context.ownerKey, 1),
			kind: "terminal",
			state: "completed",
			finalResponse: "the only copy",
		});
		await settleRelay();

		expect(sent.filter((message) => message.type === "codex_ack")).toEqual([]);
	});

	it("re-sends an acknowledgement whose first attempt never left the socket", async () => {
		const context = working(setup());
		context.attached = false;
		context.relay.handleHostMessage(frame(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		await settle();
		expect(context.sent).toEqual([]);

		// The daemon reconnects and replays what it still holds. A watermark advanced on the failed send
		// would suppress this as already-acknowledged, and a quiet stream would never recover.
		context.attached = true;
		context.relay.handleHostMessage(frame(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		await settle();

		expect(context.sent.filter((message) => message.type === "codex_ack")).toMatchObject([{ throughEventId: 1 }]);
	});

	it("reconciles every record its owner still believes is working when the daemon reconnects", () => {
		const context = working(setup());
		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-2",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});

		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile", agentId: AGENT_ID, threadId: "thread-1", turnId: "turn-1" },
		]);
	});

	it("does not reconcile an idle record", () => {
		const context = working(setup());
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "done" },
			20,
		);
		context.sent.length = 0;

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-2",
			targets: [],
		});

		expect(context.sent).toEqual([]);
	});

	it("refuses a receipt that fails validation before it reaches the reducer", async () => {
		const context = working(setup());
		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "accepted",
			requestId: "not-a-uuid",
			ownerKey: context.ownerKey,
			agentId: AGENT_ID,
		} as unknown as CodexDaemonReceipt);
		await Promise.resolve();

		expect(context.sent).toEqual([]);
		expect(currentAgent(context).agentState).toBe("working");
	});
});
