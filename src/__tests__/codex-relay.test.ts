import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import { CodexRoute } from "../gateway/codexRoute.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import type {
	CodexDaemonCommand,
	CodexDaemonEvent,
	CodexDaemonHello,
	CodexDaemonReceipt,
	CodexEventAck,
} from "../shared/codex-agent.js";
import {
	CodexAgentResultSchema,
	CodexDaemonCommandSchema,
	CodexDaemonEventSchema,
	CodexDaemonHelloSchema,
	CodexDaemonReceiptSchema,
	CodexEventAckSchema,
	codexAgentIdForOperation,
} from "../shared/codex-agent.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const targetId = "container:recipe-app";
const resolvedTarget = { kind: "devcontainer" as const, targetId, cwd: "/workspace/recipe-app" };
const operations = {
	start: "123e4567-e89b-42d3-a456-426614174000",
	stop: "123e4567-e89b-42d3-a456-426614174009",
	message: "123e4567-e89b-42d3-a456-42661417400a",
};
const dirs: string[] = [];

function setup(options: { attached?: boolean; project?: string; waitBudgetMs?: number } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-"));
	dirs.push(dir);
	let catalogWriter: CodexCatalogWriter | undefined;
	let store!: SessionStore;
	store = new SessionStore({
		ambient: processAmbient(),
		codexCatalogPersistence: {
			persistChecked: () =>
				fs.writeFileSync(path.join(dir, "session-resume.json"), JSON.stringify(store.snapshot())),
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore: store,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({
		auth,
		sessionStore: store,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter,
	});
	let attached = options.attached ?? true;
	const outbound: (CodexDaemonCommand | CodexEventAck)[] = [];
	const relay = new CodexRelay({
		service,
		sessionStore: store,
		ambient: processAmbient(),
		sendToHost: (message) => {
			if (!attached) return false;
			outbound.push(
				message.type === "codex_ack"
					? CodexEventAckSchema.parse(message)
					: CodexDaemonCommandSchema.parse(message),
			);
			return true;
		},
	});
	const owner = store.mint({ spawn: options.project ?? "recipe-app", sessionLabel: "Work" });
	const token = store.ensureBindToken(owner);
	store.activateBinding(owner);
	store.confirm(store.teamOf(owner));
	const route = new CodexRoute({
		service,
		relay,
		ambient: processAmbient(),
		waitBudgetMs: options.waitBudgetMs ?? 100,
	});
	const request = (tokenValue = token) =>
		new Request("http://gateway/codex", { method: "POST", headers: { "x-session-token": tokenValue } });
	const feed = (value: CodexDaemonReceipt | CodexDaemonEvent | CodexDaemonHello) => relay.handleHostMessage(value);
	const agent = (agentId = codexAgentIdForOperation(operations.start)) =>
		store.listCodexAgents(owner).find((candidate) => candidate.agentId === agentId);
	const commands = () => outbound.filter((frame): frame is CodexDaemonCommand => frame.type === "codex_command");
	return {
		service,
		relay,
		route,
		store,
		owner,
		token,
		outbound,
		commands,
		request,
		feed,
		agent,
		setAttached: (value: boolean) => (attached = value),
	};
}

function accepted(context: ReturnType<typeof setup>, operationId = operations.start, eventId = 0) {
	const command = context
		.commands()
		.find((candidate) => candidate.kind === "start" && candidate.operationId === operationId);
	if (!command) throw new Error("start command unavailable");
	context.feed(
		CodexDaemonReceiptSchema.parse({
			type: "codex_receipt",
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: context.store.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId,
			generation: 1,
			eventId,
			agentId: command.agentId,
			operationId,
			resolvedTarget,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		}),
	);
}

async function startWorking(context: ReturnType<typeof setup>) {
	const pending = context.route.handle(context.request(), {
		kind: "start",
		operationId: operations.start,
		prompt: "Audit the parser",
	});
	await Promise.resolve();
	accepted(context);
	await pending;
}

async function settle() {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function event(context: ReturnType<typeof setup>, eventId: number, extra: Record<string, unknown>) {
	return CodexDaemonEventSchema.parse({
		type: "codex_event",
		ownerKey: context.store.teamOf(context.owner),
		daemonInstanceId: "daemon-1",
		targetId,
		generation: 1,
		eventId,
		agentId: codexAgentIdForOperation(operations.start),
		threadId: "thread-1",
		turnId: "turn-1",
		...extra,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Codex relay behavior", () => {
	it("starts, records activity, and returns the terminal result", async () => {
		const context = setup();
		const pending = context.route.handle(context.request(), {
			kind: "start",
			operationId: operations.start,
			prompt: "Audit the parser",
		});
		await Promise.resolve();
		accepted(context);
		context.feed(event(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		context.feed(event(context, 2, { kind: "terminal", state: "completed", finalResponse: "done" }));
		const body = CodexAgentResultSchema.parse(await (await pending).json());

		expect(body).toMatchObject({ agentState: "idle", observation: "terminal", finalResponse: "done" });
		expect(context.agent()?.turns[0]).toMatchObject({ state: "completed", activities: [{ itemId: "item-1" }] });
		expect(context.commands().find((frame) => frame.kind === "start")).toMatchObject({
			ownerKey: context.store.teamOf(context.owner),
			agentId: body.agentId,
			kind: "start",
		});
	});

	it("maps a rejected start to an unavailable result and preserves the refusal", async () => {
		const context = setup();
		const pending = context.route.handle(context.request(), {
			kind: "start",
			operationId: operations.start,
			prompt: "Audit",
		});
		await Promise.resolve();
		const command = context.commands().find((frame) => frame.kind === "start")!;
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "rejected",
				requestId: command.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-1",
				eventId: 0,
				agentId: command.agentId,
				operationId: operations.start,
				error: "target unavailable",
			}),
		);
		await settle();
		const body = CodexAgentResultSchema.parse(await (await pending).json());
		expect(body).toMatchObject({
			agentState: "unavailable",
			observation: "indeterminate",
			error: { retryable: true },
		});
		expect(context.agent()).toMatchObject({ agentState: "unavailable" });
	});

	it.each([
		["interrupt receipt then terminal", ["receipt", "terminal"]],
		["terminal then interrupt receipt", ["terminal", "receipt"]],
	])("completes an interrupt race: %s", async (_name, order) => {
		const context = setup();
		await startWorking(context);
		const stop = context.route.handle(context.request(), {
			kind: "stop",
			operationId: operations.stop,
			agentId: codexAgentIdForOperation(operations.start),
		});
		await Promise.resolve();
		const interrupt = context.commands().find((frame) => frame.kind === "interrupt")!;
		for (const step of order) {
			if (step === "receipt") {
				context.feed(
					CodexDaemonReceiptSchema.parse({
						type: "codex_receipt",
						kind: "interruptResult",
						requestId: interrupt.requestId,
						ownerKey: context.store.teamOf(context.owner),
						daemonInstanceId: "daemon-1",
						targetId,
						generation: 1,
						eventId: 1,
						agentId: interrupt.agentId,
						operationId: operations.stop,
						threadId: "thread-1",
						turnId: "turn-1",
						ok: true,
					}),
				);
			} else context.feed(event(context, 2, { kind: "terminal", state: "completed", finalResponse: "finished" }));
			await settle();
		}
		await stop;
		expect(context.agent()).toMatchObject({ agentState: "idle", pendingInterrupt: undefined });
		expect(context.agent()?.turns[0]?.state).toBe("completed");
	});

	it("refuses a second message while the first delivery is unresolved", async () => {
		const context = setup();
		await startWorking(context);
		const first = context.route.handle(context.request(), {
			kind: "message",
			operationId: operations.message,
			agentId: codexAgentIdForOperation(operations.start),
			prompt: "Continue",
		});
		await Promise.resolve();
		const second = await context.route.handle(context.request(), {
			kind: "message",
			operationId: "223e4567-e89b-42d3-a456-426614174000",
			agentId: codexAgentIdForOperation(operations.start),
			prompt: "Again",
		});
		expect(second.status).toBe(400);
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "accepted",
				requestId: context.commands().find((frame) => frame.kind === "message")!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-1",
				targetId,
				generation: 1,
				eventId: 3,
				agentId: codexAgentIdForOperation(operations.start),
				operationId: operations.message,
				resolvedTarget,
				threadId: "thread-1",
				turnId: "turn-2",
				delivery: "steered",
			}),
		);
		await first;
	});

	it("re-fences held frames after a new hello generation and ignores stale frames", async () => {
		const context = setup();
		await startWorking(context);
		context.feed(event(context, 1, { kind: "activity", turnId: "unknown-turn", itemId: "held", text: "held" }));
		await settle();
		context.feed(
			CodexDaemonHelloSchema.parse({
				type: "codex_hello",
				daemonInstanceId: "daemon-2",
				targets: [{ targetId, generation: 2 }],
			}),
		);
		await settle();
		const reconcile = context.commands().find((frame) => frame.kind === "reconcile");
		expect(reconcile).toMatchObject({ agentId: codexAgentIdForOperation(operations.start), threadId: "thread-1" });
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "reconciled",
				requestId: reconcile!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-2",
				targetId,
				generation: 2,
				eventId: 0,
				agentId: reconcile!.agentId,
				resolvedTarget,
				threadId: "thread-1",
				turnId: "turn-1",
				turnState: "inProgress",
			}),
		);
		context.feed(event(context, 0, { kind: "activity", itemId: "stale", text: "stale" }));
		context.feed(
			CodexDaemonEventSchema.parse({
				...event(context, 1, { kind: "activity", itemId: "fresh", text: "fresh" }),
				daemonInstanceId: "daemon-2",
				generation: 2,
			}),
		);
		await settle();
		expect(
			context.agent()?.turns[0]?.activities.flatMap((item) => (item.kind === "commentary" ? [item.itemId] : [])),
		).toEqual(["fresh"]);
	});

	it("maps disconnect and timeout answers, isolates owners, and replays an operation answer", async () => {
		const disconnected = setup({ attached: false, waitBudgetMs: 1_000 });
		const disconnectedBody = CodexAgentResultSchema.parse(
			await (
				await disconnected.route.handle(disconnected.request(), {
					kind: "start",
					operationId: operations.start,
					prompt: "Audit",
				})
			).json(),
		);
		expect(disconnectedBody).toMatchObject({ agentState: "creating", observation: "waitTimedOut" });

		const context = setup({ waitBudgetMs: 10 });
		const first = { kind: "start", operationId: operations.start, prompt: "Audit" } as const;
		const firstBody = await (await context.route.handle(context.request(), first)).json();
		const replayBody = await (await context.route.handle(context.request(), first)).json();
		expect(replayBody).toEqual(firstBody);
		const other = context.store.mint({ spawn: "recipe-app", sessionLabel: "Other" });
		const otherToken = context.store.ensureBindToken(other);
		context.store.activateBinding(other);
		context.store.confirm(context.store.teamOf(other));
		const foreign = await (await context.route.handle(context.request(otherToken), { kind: "list" })).json();
		expect(foreign.agents).toEqual([]);
	});
});
