import type { GatewayFrameHandler } from "../gatewayBridge.js";
import type { OwnerOpMutation } from "../ownerOpRegistry.js";

export const BUILT_IN_FRAMES = new Set([
	"gateway_register",
	"inbox_append",
	"inbox_ack",
	"session_upsert",
	"session_forget",
	"blob_fetch",
	"blob_fetch_reply",
	"blob_begin",
	"blob_chunk",
	"gateway_relay",
	"gateway_relay_reply",
	"cross_domain_handshake",
	"cross_domain_handshake_reply",
	"cross_domain_handshake_reveal",
	"cross_domain_handshake_reveal_reply",
	"list_gateways",
]);

/** Registered service frames, keyed by name. */
export class FrameDispatchTable {
	private readonly entries = new Map<string, { mutation: OwnerOpMutation; handler: GatewayFrameHandler }>();

	/** Handlers receive connection identity; the class is what the migration fence reads. */
	register(name: string, mutation: OwnerOpMutation, handler: GatewayFrameHandler): void {
		if (this.entries.has(name) || BUILT_IN_FRAMES.has(name))
			throw new Error(`gateway frame "${name}" already registered`);
		this.entries.set(name, { mutation, handler });
	}

	get(name: string): GatewayFrameHandler | undefined {
		return this.entries.get(name)?.handler;
	}

	mutation(name: string): OwnerOpMutation | undefined {
		return this.entries.get(name)?.mutation;
	}
}
