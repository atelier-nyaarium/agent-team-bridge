// The daemon's own App Server client and turn tracker, wired to turn handles instead of a relay.

import { CODEX_DEFAULT_MODEL } from "../../shared/codex-agent.js";
import type { AppServerSession } from "../devcontainer/codexAppServerSession.js";
import { defaultOpenClient } from "../devcontainer/codexAppServerSession.js";
import type { AgentChild } from "../devcontainer/codexTargets.js";
import { terminalOf } from "../devcontainer/codexTurnOutcome.js";
import { CodexTurnTracker } from "../devcontainer/codexTurnTracker.js";
import type { LocalBackendSession, LocalTerminal, LocalTurnHandle } from "./localAgentSession.js";

////////////////////////////////
//  Class

/**
 * One `codex app-server` child, driven directly.
 *
 * An outcome arrives on the event stream, not from the call that started the turn, so each turn
 * parks a resolver here. The child dying settles them all, or a caller waits its whole budget.
 */
export class CodexLocalSession implements LocalBackendSession {
	/** Keyed by turn, holding its thread, so a terminal cannot resolve a turn from another one. */
	private readonly pending = new Map<string, { threadId: string; resolve: (terminal: LocalTerminal) => void }>();
	private activityListener?: (turnId: string, text: string) => void;
	private closedListener?: () => void;
	/** Events already in the pipe outlive the close that emptied it; none of them speak for it. */
	private closed = false;

	private constructor(private readonly client: AppServerSession) {}

	static async open(child: AgentChild): Promise<CodexLocalSession> {
		// Named before it exists: the hooks serve the session built from the client they open.
		let session: CodexLocalSession | undefined;
		const client = await defaultOpenClient(child, CODEX_DEFAULT_MODEL, {
			onTerminal: (threadId, turnId, terminal) => session?.settle(threadId, turnId, terminal),
			onPoisoned: () => session?.retire(),
		});
		const opened = new CodexLocalSession(client);
		session = opened;
		const tracker = new CodexTurnTracker((item) => {
			if (!opened.closed) opened.activityListener?.(item.turnId, item.text);
		});
		client.onEvent((message) => {
			const outcome = tracker.accept(message);
			if (!outcome) return;
			// Through the owner, which publishes it once and parks the thread behind it.
			void client.settleTurn(outcome.threadId, outcome.turnId, terminalOf(outcome)).catch((error) => {
				console.error(
					`[codex-local] settling ${outcome.turnId}: ${error instanceof Error ? error.message : ""}`,
				);
			});
		});
		child.onExit(() => {
			opened.closed = true;
			opened.settleAll(`codex app-server exited`);
			opened.closedListener?.();
		});
		return opened;
	}

	onActivity(listener: (turnId: string, text: string) => void): void {
		this.activityListener = listener;
	}

	onClosed(listener: () => void): void {
		this.closedListener = listener;
	}

	async openThread(options: { cwd: string; model?: string }): Promise<string> {
		return this.client.startThread({ cwd: options.cwd, model: options.model });
	}

	/** The owner loads a parked or inherited thread; one it just started is already loaded. */
	async startTurn(threadId: string, prompt: string): Promise<LocalTurnHandle> {
		// Built from inside the start, which is where the owner guarantees nothing has published yet.
		// The whole handle, so its id and its promise name one turn whatever the start goes on to return.
		let handle: LocalTurnHandle | undefined;
		const turnId = await this.client.startTurn(threadId, prompt, (id) => {
			handle = { turnId: id, settled: this.park(threadId, id) };
		});
		return handle ?? { turnId, settled: this.park(threadId, turnId) };
	}

	/** A steer keeps the running turn's id, so the caller's existing handle still describes it. */
	async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
		await this.client.steerTurn(threadId, turnId, prompt);
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.client.interruptTurn(threadId, turnId);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.settleAll(`codex app-server closed`);
		this.client.close();
	}

	/** A generation the owner gave up on. The runtime reopens, costing a relaunch. */
	private retire(): void {
		this.close();
		this.closedListener?.();
	}

	private park(threadId: string, turnId: string): Promise<LocalTerminal> {
		return new Promise<LocalTerminal>((resolve) => {
			this.pending.set(turnId, { threadId, resolve });
		});
	}

	private settle(threadId: string, turnId: string, terminal: LocalTerminal): void {
		const parked = this.pending.get(turnId);
		if (parked?.threadId !== threadId) return;
		this.pending.delete(turnId);
		parked.resolve(terminal);
	}

	private settleAll(error: string): void {
		for (const [turnId, parked] of [...this.pending]) {
			this.pending.delete(turnId);
			parked.resolve({ status: "failed", error });
		}
	}
}
