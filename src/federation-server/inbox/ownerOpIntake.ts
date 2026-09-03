import { ZodError } from "zod";
import type { SignedAdmission, SignedRevocation } from "../../shared/admission.js";
import { REGISTER_MAX_SKEW_MS, resolveAdmittedConsole } from "../../shared/admission.js";
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
import type { InboxService } from "./inboxService.js";

export interface OwnerOpIntakeParams {
	inbox: InboxService;
	getDomain: (
		domainId: string,
	) => { ownerSignPub: string; admissions: SignedAdmission[]; revocations: SignedRevocation[] } | null;
	push: (domainId: string, address: string, rows: InboxRow[]) => boolean;
	now?: () => number;
	leases?: Pick<LeaseService, "ready">;
}

/** Verified, admitted, fresh operation. */
export type OwnerOpHandler = (op: OwnerOp, value: Record<string, unknown>) => unknown | Promise<unknown>;
type DurableNonceStore = Pick<InboxService, "ownerOpNonce" | "acceptOwnerOpNonce">;

const BUILT_IN_KINDS = new Set(["deliver", "consumer_register", "inbox_read", "inbox_advance", "op_result"]);
export const OWNER_STATE_MUTATION_KINDS = new Set([
	"board_write",
	"schedule_send",
	"schedule_cancel",
	"cross_domain_share",
	"cross_domain_unshare",
	"cross_domain_unlink",
	"report_read",
	"capabilities_report",
	"deliver",
]);

/** Handler error for a `refused` result. */
export class OwnerOpRefused extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "OwnerOpRefused";
	}
}

export class OwnerOpIntake {
	private readonly nonces = new Map<string, { at: number; result?: unknown }>();
	private readonly handlers = new Map<string, OwnerOpHandler>();
	private readonly now: () => number;
	private gatewayProtocol: ((domainId: string, gatewayId: string) => number | null) | undefined;

	constructor(private readonly params: OwnerOpIntakeParams) {
		this.now = params.now ?? Date.now;
	}

	/** Register one non-built-in handler per operation kind. */
	register(kind: string, handler: OwnerOpHandler): void {
		if (this.handlers.has(kind) || BUILT_IN_KINDS.has(kind))
			throw new Error(`owner op "${kind}" already registered`);
		this.handlers.set(kind, handler);
	}

	setGatewayProtocol(gatewayProtocol: (domainId: string, gatewayId: string) => number | null): void {
		this.gatewayProtocol = gatewayProtocol;
	}

	async handle(raw: unknown): Promise<unknown> {
		const parsed = OwnerOpSchema.safeParse(raw);
		if (!parsed.success) return { malformed: true };
		const op = parsed.data;
		const domain = this.params.getDomain(op.domainId);
		const refused = (reason: string): OpResultEnvelope => ({
			opKey: { conversationId: op.conversationId, opId: op.opId },
			outcome: "refused",
			reason,
		});
		if (
			!domain ||
			!verifyOwnerOp(op) ||
			!resolveAdmittedConsole(domain.admissions, domain.revocations, domain.ownerSignPub, op.signerSignPub)
		)
			return refused("not admitted");
		if (Math.abs(this.now() - op.at) > REGISTER_MAX_SKEW_MS) return refused("stale");
		for (const [nonce, entry] of this.nonces)
			if (this.now() - entry.at > REGISTER_MAX_SKEW_MS) this.nonces.delete(nonce);
		const replay = this.nonces.get(`${op.signerSignPub}/${op.nonce}`);
		if (replay) return replay.result ?? refused("replay");
		const nonceKey = `${op.signerSignPub}/${op.nonce}`;
		const nonceStore = this.params.inbox as InboxService & Partial<DurableNonceStore>;
		const durable = nonceStore.ownerOpNonce?.(op.domainId, op.signerSignPub, op.nonce);
		if (durable) return refused("replay");
		this.nonces.set(nonceKey, { at: op.at });
		try {
			const result = await this.dispatch(op, refused);
			if (result && typeof result === "object" && (result as Record<string, unknown>).reason === "migrating") {
				this.nonces.delete(nonceKey);
				return result;
			}
			if (
				op.op.kind !== "deliver" &&
				nonceStore.acceptOwnerOpNonce &&
				!nonceStore.acceptOwnerOpNonce(op.domainId, op.signerSignPub, op.nonce, op.at)
			)
				return { opKey: { conversationId: op.conversationId, opId: op.opId }, outcome: "durability_uncertain" };
			this.nonces.set(nonceKey, {
				at: op.at,
				...(op.op.kind === "key_request" || op.op.kind === "key_receipt" ? { result } : {}),
			});
			return result;
		} catch (error) {
			if (error instanceof OwnerQuarantined)
				return { opKey: { conversationId: op.conversationId, opId: op.opId }, outcome: "durability_uncertain" };
			// Parse failures and refused errors are operation results, not Router faults.
			if (error instanceof ZodError) return refused("malformed");
			if (error instanceof OwnerOpRefused) return refused(error.reason);
			throw error;
		}
	}

	private dispatch(op: OwnerOp, refused: (reason: string) => OpResultEnvelope): unknown | Promise<unknown> {
		const value = op.op;
		if (readRouterMigrationWindow().fenced && OWNER_STATE_MUTATION_KINDS.has(String(value.kind))) {
			if (!this.params.leases?.ready(op.domainId)) return refused("migrating");
		}
		const handler = this.handlers.get(String(value.kind));
		if (handler) return handler(op, value);
		switch (value.kind) {
			case "deliver":
				return this.deliver(op, value, refused);
			case "consumer_register":
				return this.params.inbox.registerConsumer(
					op.domainId,
					op.signerSignPub,
					Number(value.incarnation ?? 0),
				);
			case "inbox_read":
				return this.params.inbox.readOwner(
					op.domainId,
					op.signerSignPub,
					Number(value.fromSeq ?? 1),
					Math.min(Number(value.limit ?? 100), 500),
					value.cursorEpoch === undefined ? undefined : Number(value.cursorEpoch),
				);
			case "inbox_advance":
				return this.params.inbox.advanceCursor(
					op.domainId,
					op.signerSignPub,
					Number(value.cursor),
					Number(value.cursorEpoch),
				);
			case "op_result":
				return this.params.inbox.opResult(op.domainId, {
					conversationId: String(value.conversationId),
					opId: String(value.opId),
				});
			default:
				return refused("unsupported");
		}
	}

	/** Console writes stay in their Domain and use their opKey. */
	private deliver(op: OwnerOp, value: Record<string, unknown>, refused: (reason: string) => OpResultEnvelope) {
		const address = parseInboxAddress(String(value.address));
		if (!address || address.domainId !== op.domainId) return refused("domain");
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
			return refused("row");
		if (
			address.kind === "session" &&
			row.data.envelope.kind === "console_op" &&
			(this.gatewayProtocol?.(op.domainId, address.gatewayId) ?? 0) < FEDERATION_VALUE_PROTOCOL_VERSION
		) {
			// Remove-by: every registered gateway reports protocol 2.
			return refused("unsupported");
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
