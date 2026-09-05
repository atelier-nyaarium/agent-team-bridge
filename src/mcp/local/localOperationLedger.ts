import type { AgentBackendId } from "../../shared/agent-backend.js";
import { agentIdForOperation, agentOperationFingerprintOf } from "../../shared/agent-record.js";
import type { LocalRefusal, LocalRequest } from "./localAgentRuntime.js";

export class LocalOperationLedger {
	private readonly operations = new Map<string, string>();

	constructor(private readonly backendId: AgentBackendId) {}

	claim(request: LocalRequest): LocalRefusal | undefined {
		// Local mode refuses reuse because its ledger is process-local.
		if (request.kind === "await" || request.kind === "list") return undefined;
		const operationId = request.operationId;
		if (!operationId) return undefined;
		// Fingerprint the named input so changed reuse is rejected.
		const fingerprint = agentOperationFingerprintOf({
			kind: request.kind,
			agentId: request.agentId ?? agentIdForOperation(this.backendId, operationId),
			prompt: request.prompt,
			...(request.kind === "start" && request.model !== undefined ? { model: request.model } : {}),
		});
		const held = this.operations.get(operationId);
		if (held === undefined) {
			this.operations.set(operationId, fingerprint);
			return undefined;
		}
		if (held !== fingerprint) return { refused: `operation ID was reused with different input` };
		return {
			refused: `operation ID was already used; this session runs its agents itself and keeps no record to replay from`,
		};
	}

	release(request: LocalRequest): void {
		if (request.operationId) this.operations.delete(request.operationId);
	}
}
