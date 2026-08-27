import { describe, expect, it } from "vitest";
import { toCopilotListSource } from "../mcp/local/localAgentHost.js";
import { LocalAgentRuntime, type LocalBackendSpec } from "../mcp/local/localAgentRuntime.js";
import type { LocalBackendSession, LocalTerminal } from "../mcp/local/localAgentSession.js";
import type { AgentBackendId } from "../shared/agent-backend.js";
import { CodexListAgentsResultSchema } from "../shared/codexAgentCatalog.js";
import { CODEX_ACTIVITY_MAX_ITEMS } from "../shared/codexAgentIdentity.js";
import { CodexAgentResultSchema } from "../shared/codexAgentState.js";
import {
	CopilotAgentResultSchema,
	CopilotListAgentsResultSchema,
	projectCopilotListResult,
} from "../shared/copilot-agent.js";

/**
 * What the session's own backend PUBLISHES, for each backend it serves.
 *
 * `LocalAgentRuntime` is one producer feeding two published shapes, and the seam between them is a
 * `.parse(unknown)` the compiler cannot see through. Codex's published row happens to BE the
 * runtime's row, so passing the record straight through worked there and hid that Copilot's row -
 * `operations` rather than `exchanges`, bare turns, no timestamps, all strict - never matched at
 * all. `copilotListAgents` therefore threw on every non-empty list, which is worse than a broken
 * read: `copilotStartAgent` times out client-side while the agent really does spawn, so list is the
 * only way back to its id and the agent runs unsteerable and unstoppable.
 *
 * CI stayed green because the runtime's own suite parses every list against the CODEX schema, and
 * because the host that does the publishing had no test at all. So these assert both backends over
 * the same producer, and each one pins WHY its projection exists by also asserting the raw record is
 * rejected - without that, deleting the projection would leave a passing suite.
 */

////////////////////////////////
//  Fakes

interface FakeTurn {
	id: string;
	resolve: (terminal: LocalTerminal) => void;
}

class FakeSession implements LocalBackendSession {
	readonly turns: FakeTurn[] = [];
	private activity?: (turnId: string, text: string) => void;

	async openThread(): Promise<string> {
		return "thread-1";
	}

	async startTurn(_threadId: string, _prompt: string) {
		const turnId = `turn-${this.turns.length + 1}`;
		let resolve!: (terminal: LocalTerminal) => void;
		const settled = new Promise<LocalTerminal>((inner) => {
			resolve = inner;
		});
		this.turns.push({ id: turnId, resolve });
		return { turnId, settled };
	}

	async interruptTurn(): Promise<void> {}

	onActivity(listener: (turnId: string, text: string) => void): void {
		this.activity = listener;
	}

	onClosed(): void {}

	close(): void {}

	emitActivity(turnId: string, text: string): void {
		this.activity?.(turnId, text);
	}

	resolveTurn(turnId: string, terminal: LocalTerminal): void {
		const turn = this.turns.find((candidate) => candidate.id === turnId);
		if (!turn) throw new Error(`unknown fake turn: ${turnId}`);
		turn.resolve(terminal);
	}
}

function makeRuntime(backendId: AgentBackendId) {
	const session = new FakeSession();
	let timestamp = 1_000;
	const spec: LocalBackendSpec = {
		backendId,
		openSession: async () => session,
		defaultCwd: () => "/workspace/project",
		waitBudgetMs: 50,
		followupDelivery: backendId === "copilot" ? "followup" : "started",
		maxActivities: CODEX_ACTIVITY_MAX_ITEMS,
		threadsResumable: backendId === "codex",
		replaysOperations: false,
	};
	return { runtime: new LocalAgentRuntime(spec, () => timestamp++), session };
}

async function settleTurns(session: FakeSession, count: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (session.turns.length >= count) return;
		await Promise.resolve();
	}
	throw new Error(`expected ${count} fake turns, got ${session.turns.length}`);
}

/** The two published list shapes, each reached the way its backend's host reaches it. */
const PUBLISHERS = {
	codex: (runtime: LocalAgentRuntime) => CodexListAgentsResultSchema.parse({ agents: runtime.list() }),
	copilot: (runtime: LocalAgentRuntime) => projectCopilotListResult(runtime.list().map(toCopilotListSource)),
} as const;

////////////////////////////////
//  Tests

describe("the local backend publishes a list its own schema accepts", () => {
	for (const backendId of ["codex", "copilot"] as const) {
		it(`${backendId}: a populated history parses`, async () => {
			const { runtime, session } = makeRuntime(backendId);
			await runtime.handle({ kind: "start", prompt: "first job" });
			await settleTurns(session, 1);
			session.emitActivity("turn-1", "thinking about it");
			session.resolveTurn("turn-1", { status: "completed", finalResponse: "done" });
			await runtime.handle({ kind: "await", agentId: runtime.list()[0].agentId });

			const listed = PUBLISHERS[backendId](runtime);
			expect(listed.agents).toHaveLength(1);
			expect(listed.agents[0].turns).toHaveLength(1);
		});

		it(`${backendId}: a failed turn parses, including its error text`, async () => {
			const { runtime, session } = makeRuntime(backendId);
			await runtime.handle({ kind: "start", prompt: "doomed job" });
			await settleTurns(session, 1);
			// What a child actually writes: multiple lines with a stack trace under it. Both backends
			// bound `error.message` AND refuse text that is not already normalized, so passing this
			// through made an ordinary failure unreportable - the answer threw on its own way out.
			session.resolveTurn("turn-1", {
				status: "failed",
				error: "spawn failed\n  at Object.<anonymous> (/x.js:1:1)\n\ncode: ENOENT",
			});
			const answer = await runtime.handle({ kind: "await", agentId: runtime.list()[0].agentId });

			const schema = backendId === "codex" ? CodexAgentResultSchema : CopilotAgentResultSchema;
			const parsed = schema.parse(answer);
			expect(parsed.error?.message).toBe("spawn failed at Object.<anonymous> (/x.js:1:1) code: ENOENT");
			expect(() => PUBLISHERS[backendId](runtime)).not.toThrow();
		});

		it(`${backendId}: an empty list parses, so a passing empty case proves nothing`, () => {
			const { runtime } = makeRuntime(backendId);
			expect(PUBLISHERS[backendId](runtime).agents).toEqual([]);
		});
	}

	it("rejects the raw runtime record for Copilot, which is why the projection exists", async () => {
		// The other half of the guard. Every assertion above would still pass if the projection were
		// deleted and the record handed over raw, because the RUNTIME would be unchanged - this is the
		// one that fails in that case, and it is the exact defect from issue #271.
		const { runtime, session } = makeRuntime("copilot");
		await runtime.handle({ kind: "start", prompt: "a job" });
		await settleTurns(session, 1);

		const raw = CopilotListAgentsResultSchema.safeParse({ agents: runtime.list() });
		expect(raw.success).toBe(false);
		const paths = raw.success ? [] : raw.error.issues.map((issue) => issue.path.join("."));
		expect(paths).toContain("agents.0.operations");
		expect(paths).toContain("agents.0");

		// And the projected form of that very record is accepted.
		expect(projectCopilotListResult(runtime.list().map(toCopilotListSource)).agents).toHaveLength(1);
	});

	it("carries the prompt and operation kinds across the rename", async () => {
		// `exchanges` becomes `operations`; a projection that dropped the contents rather than the
		// wrapper would still parse, since every field inside is optional or a bare string.
		const { runtime, session } = makeRuntime("copilot");
		await runtime.handle({ kind: "start", prompt: "the first prompt" });
		await settleTurns(session, 1);
		session.resolveTurn("turn-1", { status: "completed", finalResponse: "ok" });
		const agentId = runtime.list()[0].agentId;
		await runtime.handle({ kind: "await", agentId });
		await runtime.handle({ kind: "message", agentId, prompt: "the second prompt" });

		const [agent] = projectCopilotListResult(runtime.list().map(toCopilotListSource)).agents;
		expect(agent.operations.map((operation) => operation.kind)).toEqual(["start", "message"]);
		expect(agent.operations.map((operation) => operation.prompt)).toEqual([
			"the first prompt",
			"the second prompt",
		]);
		expect(agent.agentId).toBe(agentId);
	});
});
