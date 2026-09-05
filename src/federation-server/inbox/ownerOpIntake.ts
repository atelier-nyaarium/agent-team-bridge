import { ZodError } from "zod";
import type { SignedAdmission, SignedRevocation } from "../../shared/admission.js";
import { REGISTER_MAX_SKEW_MS, resolveAdmittedConsole } from "../../shared/admission.js";
import type { Clock } from "../../shared/ambient.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import { FEDERATION_VALUE_PROTOCOL_VERSION } from "../../shared/router-protocol.js";
import {
	formatInboxAddress,
	type InboxRow,
	InboxRowInputSchema,
	type OpResultEnvelope,
	type OwnerOp,
	OwnerOpSchema,
	parseInboxAddress,
	verifyOwnerOp,
} from "../../shared/schemasInbox.js";
import { type LeaseService, readRouterMigrationWindow } from "../migration/leaseService.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import {
	type OwnerOpCatalogEntry,
	type OwnerOpHandler,
	type OwnerOpKind,
	OwnerOpRegistry,
	type OwnerOpValue,
	ownerOpEntry,
} from "../ownerOpRegistry.js";
import type { InboxService } from "./inboxService.js";

export interface OwnerOpIntakeParams {
	inbox: InboxService;
	getDomain: (
		domainId: string,
	) => { ownerSignPub: string; admissions: SignedAdmission[]; revocations: SignedRevocation[] } | null;
	push: (domainId: string, address: string, rows: InboxRow[]) => boolean;
	ambient: Clock;
	leases?: Pick<LeaseService, "ready">;
	/** Answers kept for re-posts; the oldest goes when full. */
	maxCachedAnswers?: number;
}

type DurableNonceStore = Pick<InboxService, "ownerOpNonce" | "acceptOwnerOpNonce">;

const isMigrating = (result: unknown): boolean =>
	!!result && typeof result === "object" && (result as { reason?: unknown }).reason === "migrating";

/** An answer the console can keep; anything else it is expected to re-post. */
const isSettled = (result: unknown): boolean =>
	!isMigrating(result) &&
	!(!!result && typeof result === "object" && (result as { outcome?: unknown }).outcome === "durability_uncertain");

/** Handler error for a `refused` result. */
export class OwnerOpRefused extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "OwnerOpRefused";
	}
}

export class OwnerOpIntake {
	private readonly nonces = new Map<string, { at: number; answer: Promise<unknown> }>();
	private readonly registry = new OwnerOpRegistry();
	private readonly now: () => number;
	private readonly maxCachedAnswers: number;
	private gatewayProtocol: ((domainId: string, gatewayId: string) => number | null) | undefined;

	constructor(private readonly params: OwnerOpIntakeParams) {
		this.now = () => params.ambient.now();
		this.maxCachedAnswers = params.maxCachedAnswers ?? 5000;
		this.registerInboxOps();
	}

	/** Register one handler per catalogued kind. */
	register<Kind extends OwnerOpKind>(kind: Kind, handler: OwnerOpHandler<Kind>): void {
		this.registry.register(kind, handler);
	}

	/** The inbox's own kinds land through the same registry as every service. */
	private registerInboxOps(): void {
		this.register("deliver", (op, value) => this.deliver(op, value));
		this.register("consumer_register", (op, value) =>
			this.params.inbox.registerConsumer(op.domainId, op.signerSignPub, value.incarnation ?? 0),
		);
		this.register("inbox_read", (op, value) =>
			this.params.inbox.readOwner(
				op.domainId,
				op.signerSignPub,
				value.fromSeq ?? 1,
				Math.min(value.limit ?? 100, 500),
				value.cursorEpoch,
			),
		);
		this.register("inbox_advance", (op, value) =>
			this.params.inbox.advanceCursor(op.domainId, op.signerSignPub, value.cursor, value.cursorEpoch),
		);
		this.register("op_result", (op, value) =>
			this.params.inbox.opResult(op.domainId, { conversationId: value.conversationId, opId: value.opId }),
		);
	}

	setGatewayProtocol(gatewayProtocol: (domainId: string, gatewayId: string) => number | null): void {
		this.gatewayProtocol = gatewayProtocol;
	}

	async handle(raw: unknown): Promise<unknown> {
		const parsed = OwnerOpSchema.safeParse(raw);
		if (!parsed.success) return { malformed: true };
		const op = parsed.data;
		const domain = this.params.getDomain(op.domainId);
		// A refusal is the console's only symptom, and it never carries a body.
		const refused = (reason: string): OpResultEnvelope => {
			console.log(`[owner-op] refused ${String(op.op.kind)} dev=${op.device}: ${reason}`);
			return { opKey: { conversationId: op.conversationId, opId: op.opId }, outcome: "refused", reason };
		};
		if (
			!domain ||
			!verifyOwnerOp(op) ||
			!resolveAdmittedConsole(domain.admissions, domain.revocations, domain.ownerSignPub, op.signerSignPub)
		)
			return refused("not admitted");
		if (Math.abs(this.now() - op.at) > REGISTER_MAX_SKEW_MS) return refused("stale");
		for (const [nonce, entry] of this.nonces)
			if (this.now() - entry.at > REGISTER_MAX_SKEW_MS) this.nonces.delete(nonce);
		const nonceKey = `${op.domainId}/${op.signerSignPub}/${op.nonce}`;
		// One signed op gets one answer. The console re-posts the same op on reach failover, so a
		// second copy, in flight or settled, reads the first answer instead of running or being refused.
		const replay = this.nonces.get(nonceKey);
		if (replay) return replay.answer;
		const nonceStore = this.params.inbox as InboxService & Partial<DurableNonceStore>;
		if (nonceStore.ownerOpNonce?.(op.domainId, op.signerSignPub, op.nonce)) return refused("replay");
		// Only a settled answer stays cached. An outcome the console should retry is forgotten once it
		// lands, so the re-post runs the op again instead of reading the failure back.
		const answer = this.settle(op, nonceStore, refused).then(
			(result) => {
				if (!isSettled(result)) this.nonces.delete(nonceKey);
				return result;
			},
			(error) => {
				this.nonces.delete(nonceKey);
				throw error;
			},
		);
		this.nonces.set(nonceKey, { at: op.at, answer });
		if (this.nonces.size > this.maxCachedAnswers) {
			const oldest = this.nonces.keys().next().value;
			if (oldest !== undefined) this.nonces.delete(oldest);
		}
		return answer;
	}

	private async settle(
		op: OwnerOp,
		nonceStore: Partial<DurableNonceStore>,
		refused: (reason: string) => OpResultEnvelope,
	): Promise<unknown> {
		const uncertain = () => ({
			opKey: { conversationId: op.conversationId, opId: op.opId },
			outcome: "durability_uncertain" as const,
		});
		const entry = ownerOpEntry(String(op.op.kind));
		try {
			const result = await this.dispatch(op, entry, refused);
			if (isMigrating(result)) return result;
			if (
				entry?.mutation !== "delivery" &&
				nonceStore.acceptOwnerOpNonce &&
				!nonceStore.acceptOwnerOpNonce(op.domainId, op.signerSignPub, op.nonce, op.at)
			)
				return uncertain();
			return result;
		} catch (error) {
			if (error instanceof OwnerQuarantined) return uncertain();
			// Parse failures and refused errors are operation results, not Router faults.
			if (error instanceof ZodError) return refused("malformed");
			if (error instanceof OwnerOpRefused) return refused(error.reason);
			throw error;
		}
	}

	private dispatch(
		op: OwnerOp,
		entry: OwnerOpCatalogEntry | null,
		refused: (reason: string) => OpResultEnvelope,
	): unknown | Promise<unknown> {
		if (readRouterMigrationWindow().fenced && entry && entry.mutation !== "read") {
			if (!this.params.leases?.ready(op.domainId)) return refused("migrating");
		}
		const handler = entry && this.registry.handler(entry.kind);
		if (!entry || !handler) return refused("unsupported");
		return handler(op, entry.value.parse(op.op) as Record<string, unknown>);
	}

	/** Console writes stay in their Domain and use their opKey. */
	private deliver(op: OwnerOp, value: OwnerOpValue<"deliver">) {
		const address = parseInboxAddress(value.address);
		if (!address || address.domainId !== op.domainId) throw new OwnerOpRefused("domain");
		const row = InboxRowInputSchema.safeParse(value.row);
		if (
			!row.success ||
			row.data.envelope.epoch === "clear" ||
			row.data.envelope.opKey.conversationId !== op.conversationId ||
			row.data.envelope.opKey.opId !== op.opId ||
			row.data.envelope.origin.kind !== "console" ||
			row.data.envelope.origin.domainId !== op.domainId ||
			row.data.envelope.origin.device !== op.device
		)
			throw new OwnerOpRefused("row");
		if (
			address.kind === "session" &&
			row.data.envelope.kind === "console_op" &&
			(this.gatewayProtocol?.(op.domainId, address.gatewayId) ?? 0) < FEDERATION_VALUE_PROTOCOL_VERSION
		) {
			// Remove-by: every registered gateway reports protocol 2.
			throw new OwnerOpRefused("unsupported");
		}
		const result = this.params.inbox.appendRow({
			address,
			row: row.data,
			producerSignPub: op.signerSignPub,
			opKey: { conversationId: op.conversationId, opId: op.opId, hash: sha256Hex(canonicalJson(op.op)) },
			nonce: { signerSignPub: op.signerSignPub, nonce: op.nonce, at: op.at },
		});
		if (result.row && !this.params.push(op.domainId, formatInboxAddress(address), [result.row]))
			this.params.inbox.markWaking(op.domainId, result.opKey);
		return result;
	}
}
