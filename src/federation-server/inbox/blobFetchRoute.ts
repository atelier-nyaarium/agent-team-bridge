import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { BlobFetchParams, BlobFetchReplyParams } from "../../shared/router-protocol.js";
import { ciphertextRangeForPlaintext } from "../../shared/sealed-blob.js";
import type { RouterBlobCache } from "../blobs/routerBlobCache.js";
import { GATEWAY_RELAY_TIMEOUT_MS } from "../relayTimeouts.js";

export type BlobFetchAnswer =
	| { outcome: "fetched"; bytes: string; eof: boolean; sealed: false }
	| { outcome: "fetched"; bytes: string; eof: boolean; sealed: true; epoch: number; offset: number; size: number }
	| { outcome: "absent" | "unreachable" | "timeout" };

export class BlobFetchRoute {
	private readonly pending = new Map<
		string,
		{ resolve: (answer: BlobFetchAnswer) => void; timer: TimerHandle; connId: string }
	>();

	constructor(
		private readonly cache: RouterBlobCache,
		private readonly ambient: Pick<Ambient, "setTimer" | "clearTimer">,
		private readonly resolveOrigin: (
			domainId: string,
			gatewayId: string,
		) => { connId: string; incarnation?: number; send: (frame: Record<string, unknown>) => void } | null,
		private readonly timeoutMs = GATEWAY_RELAY_TIMEOUT_MS,
	) {}

	failConnection(connId: string): void {
		for (const [opId, pending] of this.pending) {
			if (pending.connId !== connId) continue;
			this.ambient.clearTimer(pending.timer);
			this.pending.delete(opId);
			pending.resolve({ outcome: "unreachable" });
		}
	}

	fetch(domainId: string, params: BlobFetchParams): Promise<BlobFetchAnswer> {
		const range = params.range ?? { offset: 0, length: 1_048_576 };
		const stat = this.cache.stat(domainId, params.blobId);
		if (stat.kind === "complete") {
			const covering = ciphertextRangeForPlaintext(range.offset, range.length, stat.size);
			const value = this.cache.read(
				domainId,
				params.blobId,
				covering.ciphertextOffset,
				covering.ciphertextLength,
			);
			if (Buffer.isBuffer(value))
				return Promise.resolve({
					outcome: "fetched",
					bytes: value.toString("base64"),
					eof: range.offset + range.length >= stat.size,
					sealed: true,
					epoch: stat.epoch,
					offset: covering.plaintextOffset,
					size: stat.size,
				});
		}
		const origin = params.origin ?? (stat.kind === "miss" ? stat.origin : undefined);
		if (!origin) return Promise.resolve({ outcome: "absent" });
		const target = this.resolveOrigin(origin.domainId, origin.gatewayId);
		if (!target) return Promise.resolve({ outcome: "unreachable" });
		return new Promise((resolve) => {
			const timer = this.ambient.setTimer(() => {
				this.pending.delete(params.opId);
				resolve({ outcome: "timeout" });
			}, this.timeoutMs);
			this.pending.set(params.opId, { resolve, timer, connId: target.connId });
			try {
				target.send({
					type: "blob_fetch",
					opId: params.opId,
					blobId: params.blobId,
					range: params.range,
					incarnation: target.incarnation ?? params.incarnation,
				});
			} catch {
				this.ambient.clearTimer(timer);
				this.pending.delete(params.opId);
				resolve({ outcome: "unreachable" });
			}
		});
	}

	settle(connId: string, reply: BlobFetchReplyParams): boolean {
		const pending = this.pending.get(reply.opId);
		if (!pending || pending.connId !== connId) return false;
		this.ambient.clearTimer(pending.timer);
		this.pending.delete(reply.opId);
		if (reply.outcome === "absent") pending.resolve({ outcome: "absent" });
		else pending.resolve({ outcome: "fetched", bytes: reply.bytes ?? "", eof: reply.eof ?? true, sealed: false });
		return true;
	}

	stop(): void {
		for (const pending of this.pending.values()) {
			this.ambient.clearTimer(pending.timer);
			pending.resolve({ outcome: "timeout" });
		}
		this.pending.clear();
	}
}
