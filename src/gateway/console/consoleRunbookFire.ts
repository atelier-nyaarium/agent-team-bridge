import type { ConsoleOp } from "../../shared/console-protocol.js";
import { renderRunbook } from "../../shared/runbook-grammar.js";
import { type Runbook, runbookRefusal } from "../../shared/schemasRunbook.js";
import { composeSessionName } from "../../shared/session-id.js";
import type { WakeResult } from "../wake.js";
import type { ConsoleTargets } from "./consoleTargets.js";

export interface RunbookFireResult {
	fired: boolean;
	sessionId?: string;
	reason?: string;
}

/** Who is firing, so the message reaches the session as the owner's own. */
export interface RunbookFireContext {
	conversationId: string;
	opId: string;
	device: string;
	ownerId: string;
}

export interface RunbookFireDeps {
	targets: ConsoleTargets;
	getRunbook?: (runbookId: string) => Runbook | null;
	createSession: (
		op: Extract<ConsoleOp, { kind: "create_session" }>,
		conversationId: string,
		opId: string,
	) => Promise<{ id: string; status?: "pending" }>;
	awaitRegister?: (team: string) => Promise<WakeResult>;
	deliver: (to: string, body: string, ctx: RunbookFireContext) => Promise<{ ok: boolean; error?: string }>;
}

export function createRunbookFireHandler({
	targets,
	getRunbook,
	createSession,
	awaitRegister,
	deliver,
}: RunbookFireDeps) {
	/** Launch and send share no ordering, so registration comes before the body goes out. */
	async function intoNewSession(
		into: Extract<ConsoleOp, { kind: "runbook_fire" }>["into"] & { kind: "new" },
		runbook: Runbook,
		ctx: RunbookFireContext,
	): Promise<{ team: string; sessionId: string } | RunbookFireResult> {
		const created = await createSession(
			{
				kind: "create_session",
				target: into.target,
				displayLabel: into.displayLabel ?? runbook.name,
				workdir: into.workdir,
			},
			ctx.conversationId,
			ctx.opId,
		);
		const tmux = targets.tmuxTarget(into.target, created.id);
		const team = composeSessionName(tmux.name, tmux.sessionName);
		if (!awaitRegister) {
			return {
				fired: false,
				sessionId: created.id,
				reason: "this Gateway cannot wait for a new session; fire into one already running",
			};
		}
		const registered = await awaitRegister(team);
		if (!registered.ok) {
			// The session is left running: it may be seconds from ready, and firing again reaches it.
			return {
				fired: false,
				sessionId: created.id,
				reason: `"${created.id}" started but is not listening yet; fire at it again in a moment`,
			};
		}
		return { team, sessionId: created.id };
	}

	async function fire(
		op: Extract<ConsoleOp, { kind: "runbook_fire" }>,
		ctx: RunbookFireContext,
	): Promise<RunbookFireResult> {
		if (!getRunbook) throw new Error("runbooks are not available on this Gateway");
		const runbook = getRunbook(op.runbookId);
		if (!runbook) return { fired: false, reason: `no runbook "${op.runbookId}" on this Gateway` };
		// A stored record is checked again here, so a rule it no longer passes reaches the owner.
		const refusal = runbookRefusal(runbook);
		if (refusal) return { fired: false, reason: refusal };

		const rendered = renderRunbook(runbook.body, runbook.parameters, op.values);
		if (!rendered.ok) return { fired: false, reason: rendered.reason };

		let team: string;
		let sessionId: string | undefined;
		if (op.into.kind === "new") {
			const opened = await intoNewSession(op.into, runbook, ctx);
			if ("fired" in opened) return opened;
			({ team, sessionId } = opened);
		} else {
			team = op.into.target;
		}

		const sent = await deliver(team, rendered.text, ctx);
		if (!sent.ok) return { fired: false, sessionId, reason: sent.error ?? "the runbook could not be delivered" };
		return { fired: true, sessionId: sessionId ?? team };
	}

	return { fire };
}
