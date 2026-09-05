import type { Ambient } from "../../shared/ambient.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import type { SealedEnvelope } from "../../shared/crypto.js";
import type { FederatedOp } from "../../shared/federation-protocol.js";
import { signRowEnvelope } from "../../shared/schemasInbox.js";
import { parseSessionName } from "../../shared/session-id.js";
import type { GatewayConfig } from "../../shared/types.js";
import { OP_OUTCOME_ACCEPTED } from "../../shared/wire-vocabulary.js";
import { sealTargetFor } from "../federation/sealTarget.js";

export interface RelayDeps {
	config: GatewayConfig;
	localDomain: string;
	producerSignPriv?: string;
	routerClient?: import("../router/routerClient.js").RouterClient | null;
	// E2E seal/open for cross-Gateway frames; absent when federation crypto is off.
	sealer?: import("../federation/sealer.js").Sealer | null;
	blobUploader?: ReturnType<typeof import("../router/blobUploader.js").createBlobUploader>;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain.
	crossDomainPeers?: import("../federation/crossDomainPeers.js").CrossDomainPeers | null;
	// Whether a gateway id is a LOCAL (single-owner allowlist) peer.
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	ambient: Pick<Ambient, "newId" | "setTimer">;
}

export type Relay = ReturnType<typeof createRelay>;

export function createRelay(deps: RelayDeps) {
	const {
		config,
		localDomain,
		producerSignPriv,
		routerClient,
		sealer,
		blobUploader,
		crossDomainPeers,
		resolvesLocalGateway,
		ambient,
	} = deps;
	const { localGatewayId, localDomainId } = config;

	/** The resolved target Domain id for a cross-Gateway send, or null for a local /
	 * same-Domain (bare-string) target. Recorded on the origin anchor so the reply gate can
	 * require a response_push's verified Domain to match the Domain the send was routed to. A
	 * resolution error (an ambiguous gateway id) surfaces on the relay path first, so this
	 * just falls back to null. */
	function targetDomainId(targetGateway: string, targetDomain?: string): string | null {
		try {
			const target = sealTargetFor({ resolvesLocalGateway, crossDomainPeers }, targetGateway, targetDomain);
			return typeof target === "string" ? null : target.domainId;
		} catch {
			return null;
		}
	}

	/** Forward a federated op to another Gateway through the Router and unwrap the
	 * reply. The Router holds the call until the destination Gateway answers (or times
	 * out), so a resolved result means the destination handled the op. */
	async function relayToGateway(
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
		producerOpId?: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		if (!routerClient?.isConnected())
			return { ok: false, error: `Router unavailable; cannot reach Gateway "${dstGateway}"` };
		if (!sealer) return { ok: false, error: `federation crypto is not configured` };
		// Resolve to a SealTarget once: a local peer is the bare string; a cross-Domain target pairs domain and gateway ids.
		let target: import("../federation/sealer.js").SealTarget;
		let sealed: SealedEnvelope;
		try {
			target = sealTargetFor({ resolvesLocalGateway, crossDomainPeers }, dstGateway, dstDomain);
			sealed = sealer.seal(target, op);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		// The cache is sealed to THIS Domain's key, so it serves this Domain's own devices and nobody.
		if (blobUploader && (op.kind === "send" || op.kind === "response_push")) {
			const blobIds = [...new Set(op.files?.flatMap((file) => (file.blobId ? [file.blobId] : [])) ?? [])];
			try {
				await blobUploader.uploadAll(blobIds, "cache");
			} catch (error) {
				console.warn(
					`[blob-cache] failed to warm ${blobIds.join(",")}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (typeof target !== "string" && (op.kind === "send" || op.kind === "response_push") && producerSignPriv) {
			// Not advertised to the peer: it holds none of this Domain's content keys, so naming them.
			const contentRefs: string[] = [];
			// The gateway is the producer: it signs the envelope and seals the body to the peer.
			const envelope = {
				origin: { kind: "gateway" as const, domainId: localDomain, gatewayId: localGatewayId },
				// Hashed: the natural ids carry dots the opKey grammar refuses.
				opKey: {
					conversationId: sha256Hex(op.kind === "send" ? op.returnRoute.srcConversationId : op.session_id),
					// The caller's id when it sent one: the ledger dedupes on this, so a per-attempt mint.
					opId: producerOpId ?? ambient.newId(),
				},
				epoch: "peer" as const,
				kind: op.kind === "send" ? ("message" as const) : ("reply" as const),
				contentRefs,
			};
			const targetParts = parseSessionName(op.kind === "send" ? op.to : op.session_id);
			const address = `session:${target.domainId}/${target.gatewayId}/${targetParts.project}.${targetParts.session}`;
			const result = await routerClient.callInboxTool("inbox_append", {
				address,
				row: { envelope, producerSig: signRowEnvelope(envelope, producerSignPriv), body: sealed },
				// Identifies the operation by the clear op; the ledger's hash covers the sealed bytes.
				opKey: { ...envelope.opKey, hash: sha256Hex(canonicalJson({ address, op })) },
			});
			if (result.error) return { ok: false, error: result.error };
			const accepted = result.result as { outcome?: string; ok?: boolean; error?: string } | undefined;
			if (accepted?.ok === false) return { ok: false, error: accepted.error ?? "refused" };
			if (accepted?.outcome && accepted.outcome !== OP_OUTCOME_ACCEPTED)
				return { ok: false, error: accepted.outcome };
			return { ok: true, result: accepted };
		}
		// The Domain the target actually resolved to, authoritative over the caller's hint.
		const resolvedDstDomain = typeof target === "string" ? undefined : target.domainId;
		const relayId = ambient.newId();
		const call = await routerClient.callTool("gateway_relay", {
			relayId,
			srcGateway: localGatewayId,
			dstGateway,
			srcDomain: localDomainId,
			payload: { sealed },
		});
		if (call.error) return { ok: false, error: call.error };
		const reply = call.result as { ok?: boolean; result?: unknown; error?: string } | undefined;
		if (!reply || reply.ok === false) return { ok: false, error: reply?.error ?? "cross-Gateway relay failed" };
		// The reply is sealed by the destination Gateway back to us; open it here.
		try {
			return { ok: true, result: sealer.open(dstGateway, reply.result as SealedEnvelope, resolvedDstDomain) };
		} catch (err) {
			return { ok: false, error: `bad sealed reply from "${dstGateway}": ${(err as Error).message}` };
		}
	}

	/** Relay a cross-Gateway op in the background, retrying on transient failure (the Router
	 * reconnecting, the origin Gateway restarting) with exponential backoff. The reply
	 * it carries is already durable in the local anchor (poll-recoverable), so a
	 * dropped first attempt does not strand the origin's request. Resolves once the
	 * relay finally succeeds OR exhausts its attempts - a caller that only wants
	 * fire-and-forget behavior (the pre-existing convention) can still `void` it. */
	function relayWithRetry(
		dstGateway: string,
		op: FederatedOp,
		label: string,
		dstDomain?: string,
		producerOpId?: string,
	): Promise<{ ok: boolean; error?: string }> {
		const maxAttempts = 5;
		// One id for the whole sequence, so the retries are one ledger operation.
		const opId = producerOpId ?? ambient.newId();
		let attempt = 0;
		return new Promise((resolveOutcome) => {
			const tryOnce = async (): Promise<void> => {
				// A relay throw (Router disconnect mid-call, call timeout) is just another transient.
				let error: string | undefined;
				try {
					const r = await relayToGateway(dstGateway, op, dstDomain, opId);
					if (r.ok) {
						resolveOutcome({ ok: true });
						return;
					}
					error = r.error;
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
				attempt += 1;
				if (attempt >= maxAttempts) {
					console.error(`[relay] ${label} to ${dstGateway} failed after ${maxAttempts} attempts: ${error}`);
					resolveOutcome({ ok: false, error });
					return;
				}
				ambient.setTimer(() => void tryOnce(), Math.min(2000 * 2 ** (attempt - 1), 30_000));
			};
			void tryOnce();
		});
	}

	return { targetDomainId, relayToGateway, relayWithRetry };
}
