import { z } from "zod";
import type {
	CrossDomainHandshakeReplyParams,
	CrossDomainHandshakeRevealReplyParams,
} from "../../shared/router-protocol.js";
import {
	type XDomainCommitReplyWire,
	type XDomainCommitWire,
	XDomainCommitWireSchema,
	type XDomainRevealReplyWire,
	type XDomainRevealWire,
	XDomainRevealWireSchema,
} from "./crossDomainHandshakeWire.js";

////////////////////////////////
//  Router wiring (requester seam + receiver pump)
//
//  Bridges the coordinator to the Router client. The requester leg drives each round trip
//  as a tool call; the receiver leg validates an inbound relayed frame, runs it through
//  the coordinator, and replies as the matching reply tool call. Mirrors the gateway-relay
//  wiring in gatewayRelay.ts (one parse, one error surface).

////////////////////////////////
//  Schemas

/** The inbound round-1 commit frame the Router routed to this Gateway. The outer envelope is
 * validated here; the inner `payload` is parsed with XDomainCommitWireSchema before dispatch. */
const InboundCommitFrameSchema = z.object({
	type: z.literal("cross_domain_handshake"),
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	payload: z.unknown(),
});

/** The inbound round-2 reveal frame. */
const InboundRevealFrameSchema = z.object({
	type: z.literal("cross_domain_handshake_reveal"),
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	payload: z.unknown(),
});

////////////////////////////////
//  Interfaces & Types

export interface CrossDomainHandshakePumpDeps {
	/** Runs an inbound round-1 commit through the coordinator's receiver leg. */
	handleIncomingCommit: (req: XDomainCommitWire) => XDomainCommitReplyWire;
	/** Runs an inbound round-2 reveal through the coordinator's receiver leg. */
	handleIncomingReveal: (req: XDomainRevealWire) => XDomainRevealReplyWire;
	/** Sends a cross_domain_handshake_reply tool call back to the Router (round 1,
	 * correlated by handshakeId). */
	sendCommitReply: (reply: CrossDomainHandshakeReplyParams) => Promise<{ error?: string }>;
	/** Sends a cross_domain_handshake_reveal_reply tool call back to the Router (round 2). */
	sendRevealReply: (reply: CrossDomainHandshakeRevealReplyParams) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

/** Validates an inbound cross_domain_handshake / cross_domain_handshake_reveal frame, runs it
 * through the receiver coordinator, and ships the reply back to the Router. A malformed frame
 * with no handshakeId is dropped (nothing to correlate); any other failure replies with an error
 * so the requester's held call settles fast. */
export function createCrossDomainHandshakePump({
	handleIncomingCommit,
	handleIncomingReveal,
	sendCommitReply,
	sendRevealReply,
}: CrossDomainHandshakePumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const type = (raw as { type?: unknown } | null)?.type;
			if (type === "cross_domain_handshake_reveal") {
				await dispatchReveal(raw);
			} else {
				await dispatchCommit(raw);
			}
		})().catch((err: Error) => {
			console.error(`[cross-domain-handshake] pump error: ${err.message}`);
		});
	};

	async function dispatchCommit(raw: unknown): Promise<void> {
		const parsed = InboundCommitFrameSchema.safeParse(raw);
		if (!parsed.success) {
			const handshakeId = (raw as { handshakeId?: unknown } | null)?.handshakeId;
			if (typeof handshakeId === "string" && handshakeId.length > 0) {
				await sendCommitReply({
					handshakeId,
					ok: false,
					error: `invalid cross_domain_handshake: ${parsed.error.issues[0]?.message ?? "malformed"}`,
				});
			} else {
				console.error(`[cross-domain-handshake] dropping malformed commit frame with no handshakeId`);
			}
			return;
		}
		const frame = parsed.data;
		const req = XDomainCommitWireSchema.safeParse(frame.payload);
		if (!req.success) {
			await sendCommitReply({
				handshakeId: frame.handshakeId,
				ok: false,
				error: `invalid handshake payload: ${req.error.issues[0]?.message ?? "malformed"}`,
			});
			return;
		}
		try {
			const result = handleIncomingCommit(req.data);
			await sendCommitReply({ handshakeId: frame.handshakeId, ok: true, result });
		} catch (err) {
			await sendCommitReply({ handshakeId: frame.handshakeId, ok: false, error: (err as Error).message });
		}
	}

	async function dispatchReveal(raw: unknown): Promise<void> {
		const parsed = InboundRevealFrameSchema.safeParse(raw);
		if (!parsed.success) {
			const handshakeId = (raw as { handshakeId?: unknown } | null)?.handshakeId;
			if (typeof handshakeId === "string" && handshakeId.length > 0) {
				await sendRevealReply({
					handshakeId,
					ok: false,
					error: `invalid cross_domain_handshake_reveal: ${parsed.error.issues[0]?.message ?? "malformed"}`,
				});
			} else {
				console.error(`[cross-domain-handshake] dropping malformed reveal frame with no handshakeId`);
			}
			return;
		}
		const frame = parsed.data;
		const req = XDomainRevealWireSchema.safeParse(frame.payload);
		if (!req.success) {
			await sendRevealReply({
				handshakeId: frame.handshakeId,
				ok: false,
				error: `invalid reveal payload: ${req.error.issues[0]?.message ?? "malformed"}`,
			});
			return;
		}
		try {
			const result = handleIncomingReveal(req.data);
			await sendRevealReply({ handshakeId: frame.handshakeId, ok: true, result });
		} catch (err) {
			await sendRevealReply({ handshakeId: frame.handshakeId, ok: false, error: (err as Error).message });
		}
	}
}
