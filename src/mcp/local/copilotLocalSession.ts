// The daemon's own ACP client. The prompt call IS the turn, so no terminal needs correlating; the
// events carry the answer itself, as chunks, which is why a running turn is tracked at all.

import crypto from "node:crypto";
import { COPILOT_DEFAULT_MODEL } from "../../shared/copilot-agent.js";
import type { AgentChild } from "../devcontainer/codexTargets.js";
import type { CopilotAcpClient } from "../devcontainer/copilotAcp.js";
import { defaultOpenCopilotClient } from "../devcontainer/copilotAcp.js";
import type { LocalBackendSession, LocalTerminal, LocalTurnHandle } from "./localAgentSession.js";

////////////////////////////////
//  Interfaces & Types

interface ActiveTurn {
	turnId: string;
	response: string;
	cancelled: boolean;
}

////////////////////////////////
//  Class

/**
 * One `copilot --acp` child, driven directly.
 *
 * No `steerTurn`: ACP exposes none, and its absence is what makes the runtime refuse a follow-up
 * rather than open a second turn on the same session.
 */
export class CopilotLocalSession implements LocalBackendSession {
	private readonly active = new Map<string, ActiveTurn>();
	private activityListener?: (turnId: string, text: string) => void;
	private closedListener?: () => void;

	private constructor(private readonly client: CopilotAcpClient) {}

	static async open(child: AgentChild): Promise<CopilotLocalSession> {
		const client = await defaultOpenCopilotClient(child);
		const session = new CopilotLocalSession(client);
		client.onEvent((event) => session.onEvent(event));
		// The transport settles running turns; this stops the RUNTIME handing it later calls.
		child.onExit(() => {
			session.active.clear();
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
		const info = await this.client.newSession(options.cwd, options.model ?? COPILOT_DEFAULT_MODEL);
		return info.sessionId;
	}

	async startTurn(sessionId: string, prompt: string): Promise<LocalTurnHandle> {
		// Minted here: ACP names no turn, and the runtime needs an id before the outcome exists.
		const turnId = crypto.randomUUID();
		const turn: ActiveTurn = { turnId, response: "", cancelled: false };
		this.active.set(sessionId, turn);

		const settled = this.client
			.prompt(sessionId, prompt)
			.then((result): LocalTerminal => {
				this.retire(sessionId, turn);
				const interrupted = turn.cancelled || result.stopReason === "cancelled";
				return interrupted ? { status: "interrupted" } : { status: "completed", finalResponse: turn.response };
			})
			.catch((error): LocalTerminal => {
				this.retire(sessionId, turn);
				const text = error instanceof Error ? error.message : String(error);
				return { status: "failed", error: text.trim() || `copilot turn failed` };
			});

		return { turnId, settled };
	}

	async interruptTurn(sessionId: string, turnId: string): Promise<void> {
		const turn = this.active.get(sessionId);
		if (!turn || turn.turnId !== turnId) return;
		// Marked before the notify, so the resolution reads it as interrupted either way.
		turn.cancelled = true;
		this.client.cancel(sessionId);
	}

	close(): void {
		this.active.clear();
		this.client.close();
	}

	/** A late resolution from a replaced turn must not clear its successor. */
	private retire(sessionId: string, turn: ActiveTurn): void {
		if (this.active.get(sessionId) === turn) this.active.delete(sessionId);
	}

	private onEvent(event: { method: string; params?: unknown }): void {
		if (event.method !== "session/update" || typeof event.params !== "object" || event.params === null) return;
		const params = event.params as { sessionId?: unknown; update?: unknown };
		if (typeof params.sessionId !== "string" || typeof params.update !== "object" || params.update === null) return;
		const turn = this.active.get(params.sessionId);
		if (!turn) return;
		const update = params.update as {
			sessionUpdate?: unknown;
			content?: unknown;
			title?: unknown;
			status?: unknown;
		};

		if (update.sessionUpdate === "agent_message_chunk" && typeof update.content === "object" && update.content) {
			const content = update.content as { type?: unknown; text?: unknown };
			if (content.type === "text" && typeof content.text === "string") {
				// The chunks ARE the answer, so they accumulate as well as narrate.
				turn.response += content.text;
				this.activityListener?.(turn.turnId, content.text);
			}
			return;
		}
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			const label =
				typeof update.title === "string"
					? update.title
					: typeof update.status === "string"
						? update.status
						: `Copilot used a tool`;
			this.activityListener?.(turn.turnId, label);
		}
	}
}
