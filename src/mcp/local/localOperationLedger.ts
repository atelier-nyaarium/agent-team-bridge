import type { AgentBackendId } from "../../shared/agent-backend.js";
import { agentIdForOperation, agentOperationFingerprintOf } from "../../shared/agent-record.js";
import type { LocalRefusal, LocalRequest } from "./localAgentRuntime.js";

////////////////////////////////
//  Class

/**
 * Every operation identity this process has already acted on, against the input it named.
 *
 * Process-local and gone with the MCP, which is exactly why local mode REFUSES a reuse rather than
 * replaying one: it holds no durable ledger and its agents die with it, so it cannot answer for an
 * operation the way a gateway can. Refusing is the honest half of honouring the field.
 *
 * It is also what stops the obvious version of this change from being a bug. Deriving an agent id
 * from a caller-supplied operation id without this makes a reused id overwrite the first agent in
 * `agents`: its thread stays open, its activity stops being recorded, no later call can address
 * it, and the idle reaper walks only this map so an orphaned ACTIVE turn becomes invisible to the
 * one guard meant to protect it.
 */
export class LocalOperationLedger {
	private readonly operations = new Map<string, string>();

	constructor(private readonly backendId: AgentBackendId) {}

	/**
	 * Take the caller's operation identity, or refuse a reuse of one.
	 *
	 * Both refusals carry the gateway's own wording for the same conditions, so a caller reading an
	 * answer cannot tell which backend served it apart from the one thing that genuinely differs: the
	 * gateway REPLAYS a matching reuse and this cannot, having no ledger that survives the process.
	 * That difference is declared on `LocalBackendSpec.replaysOperations`.
	 */
	claim(request: LocalRequest): LocalRefusal | undefined {
		if (request.kind === "await" || request.kind === "list") return undefined;
		const operationId = request.operationId;
		if (!operationId) return undefined;
		// The input this identity named, so a reuse with different input is separable from a plain
		// retry. Same encoding the gateway fingerprints with, so the two cannot drift apart on what
		// "different input" means.
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

	/** Give an identity back, for an operation that never reached the child. Paired with the claim in
	 * `handle`, which is the only place either happens. */
	release(request: LocalRequest): void {
		if (request.operationId) this.operations.delete(request.operationId);
	}
}
