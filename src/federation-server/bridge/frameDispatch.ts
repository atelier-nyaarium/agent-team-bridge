import type { GatewayRegistration } from "../gatewayBridge.js";
import type { ConnectionId } from "../gatewayTransport.js";
import type { OwnerOpMutation } from "../ownerOpRegistry.js";

/** A gated frame runs after the bridge has verified the incarnation, so it is handed the identity. */
export type GatedFrameHandler = (
	reg: GatewayRegistration,
	params: Record<string, unknown>,
	connId: ConnectionId,
) => unknown | Promise<unknown>;

/** An open frame claims no incarnation, so it resolves whatever it needs from the connection. */
export type OpenFrameHandler = (connId: ConnectionId, params: Record<string, unknown>) => unknown | Promise<unknown>;

interface FrameCommon {
	readonly name: string;
	/** `read` passes the migration fence; every other class waits behind it. */
	readonly mutation: OwnerOpMutation;
}

export interface GatedFrameDescriptor extends FrameCommon {
	readonly gated: true;
	readonly handler: GatedFrameHandler;
}

/** An open frame names no owner the fence could hold it for, so it may only ever be a `read`. */
export interface OpenFrameDescriptor extends FrameCommon {
	readonly gated: false;
	readonly mutation: "read";
	readonly handler: OpenFrameHandler;
}

export type GatewayFrameDescriptor = GatedFrameDescriptor | OpenFrameDescriptor;

/** Every frame the bridge dispatches, built-in or service. Dispatch, gating, and the fence read this alone. */
export class GatewayFrameCatalog {
	private readonly entries = new Map<string, GatewayFrameDescriptor>();

	register(descriptor: GatewayFrameDescriptor): void {
		if (this.entries.has(descriptor.name)) throw new Error(`gateway frame "${descriptor.name}" already registered`);
		this.entries.set(descriptor.name, descriptor);
	}

	get(name: string): GatewayFrameDescriptor | undefined {
		return this.entries.get(name);
	}

	names(): string[] {
		return [...this.entries.keys()];
	}
}
