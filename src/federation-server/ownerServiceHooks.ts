import type { GatewayFrameHandler, GatewayRegistration } from "./gatewayBridge.js";
import type { OwnerOpHandler, OwnerOpKind } from "./ownerOpRegistry.js";

export interface OwnerServiceHooks {
	ownerOp<Kind extends OwnerOpKind>(kind: Kind, handler: OwnerOpHandler<Kind>): void;
	gatewayFrame(name: string, handler: GatewayFrameHandler): void;
	onGatewayRegistered(listener: (reg: GatewayRegistration) => void): void;
	onGatewayDropped(listener: (reg: GatewayRegistration) => void): void;
	onSessionForgotten(listener: (reg: GatewayRegistration, sessionId: string) => void): void;
	/** False when the gateway is disconnected; frames include its incarnation. */
	pushFrameTo(domainId: string, gatewayId: string, frame: Record<string, unknown>): boolean;
	gatewayIncarnation(domainId: string, gatewayId: string): number | null;
	connectedGateways(domainId: string): string[];
}

export type { GatewayFrameHandler, GatewayRegistration, OwnerOpHandler };
