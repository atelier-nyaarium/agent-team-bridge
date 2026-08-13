// The session's own agent backend, used when no daemon announced one.
//
// Same five calls, same validated answers, no wire in between. The result is parsed through the very
// schema the gateway path answers with, so a caller cannot tell which side served it and a shaping
// mistake here fails loudly rather than reaching Claude as a plausible wrong answer.

import fs from "node:fs";
import path from "node:path";
import { type AgentBackendDescriptor, agentEnvPrefix } from "../../shared/agent-backend.js";
import { AGENT_HOST_TARGET_ID, type AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import {
	CODEX_ACTIVITY_MAX_ITEMS,
	CodexAgentResultSchema,
	CodexGatewayRequestSchema,
	CodexListAgentsResultSchema,
	CodexRequestErrorSchema,
} from "../../shared/codex-thinking.js";
import {
	COPILOT_ACTIVITY_MAX_ITEMS,
	CopilotAgentResultSchema,
	CopilotGatewayRequestSchema,
	CopilotListAgentsResultSchema,
	CopilotRequestErrorSchema,
} from "../../shared/copilot-thinking.js";
import { ExecutionTargetManager, realLauncher, targetLogger } from "../devcontainer/codexTargets.js";
import { copilotLauncher } from "../devcontainer/copilotTargets.js";
import { CodexLocalSession } from "./codexLocalSession.js";
import { CopilotLocalSession } from "./copilotLocalSession.js";
import { LocalAgentRuntime, type LocalBackendSpec } from "./localAgentRuntime.js";
import type { LocalBackendSession } from "./localAgentSession.js";

////////////////////////////////
//  Interfaces & Types

export interface LocalAgentBackend {
	/** Takes the very body the tool would have posted, so the two dispatches differ only in transport. */
	handle(body: Record<string, unknown>): Promise<unknown>;
	shutdown(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Where a thread runs. A caller's path is resolved against this process's directory and must name a
 * real one, since the alternative is a child whose writes land somewhere nobody named.
 */
export function resolveLocalCwd(requested: string | undefined, base: string = process.cwd()): string {
	if (!requested) return base;
	const resolved = path.resolve(base, requested);
	try {
		return fs.statSync(resolved).isDirectory() ? resolved : base;
	} catch {
		return base;
	}
}

function unavailable(errorClass: string, backend: AgentBackendDescriptor): Error {
	return new Error(`${backend.displayName} is unavailable (${errorClass})`);
}

/**
 * A session-owned backend for one agent CLI.
 *
 * The target manager is reused rather than reimplemented, so a local child gets the same env scrub,
 * crash backoff and give-up cooldown a daemon-supervised one gets. Only the host target exists here:
 * a devcontainer target is a thing a daemon reaches across a boundary this process does not have.
 */
export function createLocalAgentBackend(backend: AgentBackendDescriptor): LocalAgentBackend {
	const isCodex = backend.id === "codex";
	const targets = new ExecutionTargetManager(
		isCodex ? realLauncher : copilotLauncher,
		undefined,
		targetLogger(`${backend.id}-local`),
		undefined,
		agentEnvPrefix(backend.id),
	);

	const spec: LocalBackendSpec = {
		backendId: backend.id,
		waitBudgetMs: backend.waitBudgetMs,
		defaultCwd: () => process.cwd(),
		followupDelivery: isCodex ? "started" : "followup",
		maxActivities: isCodex ? CODEX_ACTIVITY_MAX_ITEMS : COPILOT_ACTIVITY_MAX_ITEMS,
		...(isCodex
			? {}
			: { busyMessage: "Copilot is still working. Await the turn or stop it before sending another." }),
		openSession: async (): Promise<LocalBackendSession> => {
			const target: AgentResolvedTarget = {
				kind: "host",
				targetId: AGENT_HOST_TARGET_ID,
				cwd: process.cwd(),
			};
			const availability = targets.acquire(target);
			if (availability.state !== "running") throw unavailable(availability.errorClass, backend);
			return isCodex
				? CodexLocalSession.open(availability.lease.child)
				: CopilotLocalSession.open(availability.lease.child);
		},
	};

	const runtime = new LocalAgentRuntime(spec);
	const requestSchema = isCodex ? CodexGatewayRequestSchema : CopilotGatewayRequestSchema;
	const requestErrorSchema = isCodex ? CodexRequestErrorSchema : CopilotRequestErrorSchema;
	const resultSchema = isCodex ? CodexAgentResultSchema : CopilotAgentResultSchema;
	const listSchema = isCodex ? CodexListAgentsResultSchema : CopilotListAgentsResultSchema;

	/** A refused request, in the shape the route answers one with. The result envelope cannot carry
	 * this: it only permits an error when the AGENT is unwell, which a badly timed call does not make it. */
	const refuse = (message: string): unknown =>
		requestErrorSchema.parse({ error: { code: "invalid_input", retryable: false, message } });

	return {
		async handle(body) {
			// Validated with the same schema the gateway route validates against, so a malformed call is
			// refused identically on both paths rather than reaching the runtime as a half-shaped request.
			const parsed = requestSchema.safeParse(body);
			if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? "invalid request");

			const request = parsed.data;
			if (request.kind === "list") return listSchema.parse({ agents: runtime.list() });
			const answer = await runtime.handle({
				kind: request.kind,
				...("agentId" in request ? { agentId: request.agentId } : {}),
				...("prompt" in request ? { prompt: request.prompt } : {}),
				...("model" in request && request.model !== undefined ? { model: request.model } : {}),
				...("cwd" in request && request.cwd !== undefined ? { cwd: resolveLocalCwd(request.cwd) } : {}),
			});
			return "refused" in answer ? refuse(answer.refused) : resultSchema.parse(answer);
		},
		shutdown() {
			runtime.shutdown();
			targets.shutdown();
		},
	};
}
