// The daemon's own App Server client and turn tracker, wired to turn handles instead of a relay.

import { CODEX_DEFAULT_MODEL } from "../../shared/codex-thinking.js";
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
	private readonly pending = new Map<string, (terminal: LocalTerminal) => void>();
	/** Threads this session has already run a turn on, which is exactly the set that needs resuming. */
	private readonly used = new Set<string>();
	private activityListener?: (turnId: string, text: string) => void;
	private closedListener?: () => void;

	private constructor(private readonly client: AppServerSession) {}

	static async open(child: AgentChild): Promise<CodexLocalSession> {
		const client = await defaultOpenClient(child, CODEX_DEFAULT_MODEL);
		const session = new CodexLocalSession(client);
		const tracker = new CodexTurnTracker((item) => session.activityListener?.(item.turnId, item.text));
		client.onEvent((message) => {
			const outcome = tracker.accept(message);
			if (outcome) session.settle(outcome.turnId, terminalOf(outcome));
		});
		child.onExit(() => {
			session.settleAll("codex app-server exited");
			session.closedListener?.();
		});
		return session;
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

	async startTurn(threadId: string, prompt: string): Promise<LocalTurnHandle> {
		// App Server may unload an idle thread, and starting a turn on an unloaded one fails.
		if (this.used.has(threadId)) await this.client.resumeThread(threadId);
		const turnId = await this.client.startTurn(threadId, prompt);
		this.used.add(threadId);
		return { turnId, settled: this.park(turnId) };
	}

	/** A steer keeps the running turn's id, so the caller's existing handle still describes it. */
	async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
		await this.client.steerTurn(threadId, turnId, prompt);
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.client.interruptTurn(threadId, turnId);
	}

	close(): void {
		this.settleAll("codex app-server closed");
		this.client.close();
	}

	private park(turnId: string): Promise<LocalTerminal> {
		return new Promise<LocalTerminal>((resolve) => {
			this.pending.set(turnId, resolve);
		});
	}

	private settle(turnId: string, terminal: LocalTerminal): void {
		const resolve = this.pending.get(turnId);
		if (!resolve) return;
		this.pending.delete(turnId);
		resolve(terminal);
	}

	private settleAll(error: string): void {
		for (const [turnId, resolve] of [...this.pending]) {
			this.pending.delete(turnId);
			resolve({ status: "failed", error });
		}
	}
}
