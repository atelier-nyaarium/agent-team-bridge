// Codex delegation: the owner-scoped catalog of persisted agents, the public list projection of one
// agent's history, restoring a catalog from durable storage (with the migration a pre-fence record
// needs), and building the projection from a private CodexPersistedAgent.

import { z } from "zod";
import { restoreAgentCatalog } from "./agent-record.js";
import { CodexActivitiesSchema } from "./codexAgentActivities.js";
import { CodexAgentIdSchema, CodexErrorTextSchema, OpaqueIdSchema } from "./codexAgentIdentity.js";
import type { CodexPersistedAgent } from "./codexAgentRecord.js";
import { CodexListExchangeSchema, CodexPersistedAgentSchema, codexAgentHistoryIssues } from "./codexAgentRecord.js";
import { CodexReconciliationFenceSchema } from "./codexAgentRelay.js";
import type { CodexListAvailabilityError } from "./codexAgentState.js";
import { CodexAgentStateSchema, CodexListAvailabilityErrorSchema } from "./codexAgentState.js";

export const CodexAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(CodexPersistedAgentSchema),
	})
	.strict()
	.superRefine((value, ctx) => {
		const agentIds = new Set<string>();
		const operationIds = new Set<string>();
		for (const [index, agent] of value.agents.entries()) {
			if (agentIds.has(agent.agentId)) {
				ctx.addIssue({
					code: "custom",
					message: "agent IDs must be unique within an owner catalog",
					path: ["agents", index, "agentId"],
				});
			}
			agentIds.add(agent.agentId);
			for (const operation of agent.operations) {
				if (operationIds.has(operation.operationId)) {
					ctx.addIssue({
						code: "custom",
						message: "operation IDs must be unique within an owner catalog",
						path: ["agents", index, "operations"],
					});
				}
				operationIds.add(operation.operationId);
			}
		}
	});

export const CodexListTurnSchema = z.discriminatedUnion("state", [
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("inProgress"),
			activities: CodexActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("completed"),
			activities: CodexActivitiesSchema,
			finalResponse: z.string(),
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("failed"),
			activities: CodexActivitiesSchema,
			error: CodexErrorTextSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("interrupted"),
			activities: CodexActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
]);

export const CodexListAgentSchema = z
	.object({
		agentId: CodexAgentIdSchema,
		agentState: CodexAgentStateSchema,
		activeTurnId: OpaqueIdSchema.optional(),
		exchanges: z.array(CodexListExchangeSchema),
		turns: z.array(CodexListTurnSchema),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const message of codexAgentHistoryIssues(value)) ctx.addIssue({ code: "custom", message });
	});

export const CodexListAgentsResultSchema = z
	.object({
		agents: z.array(CodexListAgentSchema),
		observation: z.literal("unavailable").optional(),
		error: CodexListAvailabilityErrorSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (new Set(value.agents.map((agent) => agent.agentId)).size !== value.agents.length) {
			ctx.addIssue({ code: "custom", message: "listed agent IDs must be unique" });
		}
		if ((value.observation === "unavailable") !== (value.error !== undefined)) {
			ctx.addIssue({ code: "custom", message: "unavailable list observation requires an error" });
		}
	});

export type CodexAgentCatalog = z.infer<typeof CodexAgentCatalogSchema>;
export type CodexListAgent = z.infer<typeof CodexListAgentSchema>;
export type CodexListAgentsResult = z.infer<typeof CodexListAgentsResultSchema>;

function migrateCodexAgentRecoveryIntent(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const agent = raw as Record<string, unknown>;
	if (!Array.isArray(agent.operations)) return raw;
	const threadId = typeof agent.threadId === "string" ? agent.threadId : undefined;
	const agentFence = CodexReconciliationFenceSchema.safeParse(agent.fence);
	let hasUnverifiedAcceptance = false;
	const operations = agent.operations.map((candidate) => {
		if (!candidate || typeof candidate !== "object") return candidate;
		const operation = candidate as Record<string, unknown>;
		let migrated = operation;
		if (operation.preDispatch === undefined) {
			switch (operation.kind) {
				case "start":
					migrated = { ...operation, preDispatch: { agentState: "creating" } };
					break;
				case "message": {
					const turnId = typeof operation.expectedTurnId === "string" ? operation.expectedTurnId : undefined;
					migrated = {
						...operation,
						preDispatch: { agentState: turnId ? "working" : "idle", threadId, turnId },
					};
					break;
				}
				case "stop": {
					const turnId = typeof operation.turnId === "string" ? operation.turnId : undefined;
					migrated = {
						...operation,
						preDispatch: { agentState: turnId ? "working" : "idle", threadId, turnId },
					};
					break;
				}
			}
		}
		if (
			migrated.kind !== "start" &&
			migrated.preDispatch &&
			typeof migrated.preDispatch === "object" &&
			!("fence" in migrated.preDispatch) &&
			agentFence.success
		) {
			migrated = {
				...migrated,
				preDispatch: { ...(migrated.preDispatch as Record<string, unknown>), fence: agentFence.data },
			};
		}
		if (
			(migrated.kind === "start" || migrated.kind === "message") &&
			migrated.state === "accepted" &&
			migrated.acceptanceFence === undefined &&
			migrated.acceptanceUnverified === undefined
		) {
			hasUnverifiedAcceptance = true;
			migrated = { ...migrated, acceptanceUnverified: true };
		}
		if (migrated.acceptanceUnverified === true) hasUnverifiedAcceptance = true;
		return migrated;
	});
	return {
		...agent,
		agentState: hasUnverifiedAcceptance ? "recovering" : agent.agentState,
		operations,
	};
}

/** Restore a session-owned catalog without sacrificing its owner to one damaged agent entry. */
export function restoreCodexAgentCatalog(raw: unknown): CodexAgentCatalog | undefined {
	const restored = restoreAgentCatalog(raw, (candidate) => {
		const result = CodexPersistedAgentSchema.safeParse(migrateCodexAgentRecoveryIntent(candidate));
		return result.success ? result.data : undefined;
	});
	if (!restored) return undefined;
	const catalog = CodexAgentCatalogSchema.safeParse(restored);
	return catalog.success ? catalog.data : undefined;
}

/** Builds the complete caller-visible history by explicitly copying only public fields. */
export function projectCodexListAgent(agent: CodexPersistedAgent): CodexListAgent {
	const stored = CodexPersistedAgentSchema.parse(agent);
	const exchanges = stored.exchanges.map((exchange) => ({
		kind: exchange.kind,
		prompt: exchange.prompt,
		status: exchange.status,
		delivery: exchange.delivery,
		turnId: exchange.turnId,
		createdAt: exchange.createdAt,
		acceptedAt: exchange.acceptedAt,
	}));
	const turns = stored.turns.map((turn) => {
		const base = {
			id: turn.id,
			state: turn.state,
			activities: turn.activities.map((activity) =>
				activity.kind === "commentary"
					? { kind: activity.kind, text: activity.text }
					: { kind: activity.kind, omitted: activity.omitted },
			),
			updatedAt: turn.updatedAt,
		};
		switch (turn.state) {
			case "completed":
				return { ...base, state: turn.state, finalResponse: turn.finalResponse };
			case "failed":
				return { ...base, state: turn.state, error: turn.error };
			case "inProgress":
			case "interrupted":
				return { ...base, state: turn.state };
			default:
				throw new Error("unsupported Codex turn state");
		}
	});
	return CodexListAgentSchema.parse({
		agentId: stored.agentId,
		agentState: stored.agentState,
		activeTurnId: stored.activeTurnId,
		exchanges,
		turns,
		createdAt: stored.createdAt,
		updatedAt: stored.updatedAt,
	});
}

export function projectCodexListResult(
	agents: readonly CodexPersistedAgent[],
	error?: CodexListAvailabilityError,
): CodexListAgentsResult {
	return CodexListAgentsResultSchema.parse({
		agents: agents.map(projectCodexListAgent),
		observation: error ? "unavailable" : undefined,
		error,
	});
}
