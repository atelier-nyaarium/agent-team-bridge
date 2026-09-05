import type { GatewayFrameHandler } from "../gatewayBridge.js";

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

/** Gateway frames the migration fence holds, mirroring their owner-op twins. */
export const MIGRATION_FENCED_GATEWAY_FRAMES = new Set(["board_op", "cross_domain_share", "cross_domain_unshare"]);

/** Registered service frames, keyed by name. */
export class FrameDispatchTable {
	private readonly handlers = new Map<string, GatewayFrameHandler>();

	/** Handlers receive connection identity. */
	register(name: string, handler: GatewayFrameHandler): void {
		if (this.handlers.has(name) || BUILT_IN_FRAMES.has(name))
			throw new Error(`gateway frame "${name}" already registered`);
		this.handlers.set(name, handler);
	}

	get(name: string): GatewayFrameHandler | undefined {
		return this.handlers.get(name);
	}
}
