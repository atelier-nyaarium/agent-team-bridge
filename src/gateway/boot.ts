// The gateway's boot lifecycle as ONE value: Standalone (no mesh), Arming (enrollment window
// open), FederationActive (Router connection up). The phase is a value a reader receives, never a
// null check each site re-derives.

import type { Allowlist } from "./federation/allowlist.js";
import type { ContentKeyStore } from "./federation/contentKeyStore.js";
import type { CrossDomainHandshakeCoordinator } from "./federation/crossDomainHandshake.js";
import type { CrossDomainPeers } from "./federation/crossDomainPeers.js";
import type { CrossDomainPresenceSource } from "./federation/crossDomainPresence.js";
import type { CrossDomainShareState } from "./federation/crossDomainShareState.js";
import type { AdmitGatewayPayload } from "./federation/enrollQr.js";
import type { Sealer } from "./federation/sealer.js";
import type { createBlobUploader } from "./router/blobUploader.js";
import type { createBoardClient } from "./router/boardClient.js";
import type { RouterClient } from "./router/routerClient.js";

type BoardClient = ReturnType<typeof createBoardClient>;
type BlobUploader = ReturnType<typeof createBlobUploader>;

////////////////////////////////
//  Interfaces & Types

/** This Gateway's Domain lifecycle metadata, learned from the Router's register reply. */
export interface DomainMeta {
	domainStatus?: string;
	displayName?: string | null;
	isAdminDomain?: boolean;
}

/** The Router frame handlers, built against the federation-aware routes after the rebuild.
 * A frame arriving before they land on the slice is dropped (the console re-polls). */
export interface RouterHandlers {
	gatewayRelay: (frame: unknown) => void;
	valueOp: (frame: unknown) => void;
	crossDomainHandshake: (frame: unknown) => void;
	presenceSource: CrossDomainPresenceSource;
	/** Drops pending presence pushes and their retries. */
	stop: () => void;
}

/** Everything FederationActive owns. Only domainMeta (the Router's first register reply) and
 * handlers (built against the rebuilt routes) populate after construction. */
export interface FederationSlice {
	allowlist: Allowlist;
	crossDomainPeers: CrossDomainPeers;
	shareState: CrossDomainShareState;
	coordinator: CrossDomainHandshakeCoordinator;
	sealer: Sealer;
	routerClient: RouterClient;
	contentKeyStore: ContentKeyStore;
	boardClient: BoardClient;
	blobUploader: BlobUploader;
	replayPersist: () => void;
	domainMeta: DomainMeta | null;
	handlers: RouterHandlers | null;
}

/** The open enrollment window. Leaving the arming phase is what closes it: both fields die with
 * the state, so install and payload cannot outlive each other. */
export interface ArmingSlice {
	/** Opens the sealed bootstrap bundle and installs credentials; returns this gateway's id. */
	install: (frame: unknown) => string;
	admitPayload: AdmitGatewayPayload;
}

export type BootState =
	| { phase: "standalone" }
	| { phase: "arming"; arming: ArmingSlice }
	| { phase: "federationActive"; federation: FederationSlice };

export type BootPhaseDecision = "activate" | "arm" | "standalone";

////////////////////////////////
//  Functions & Helpers

/** The whole boot-time decision. Arming requires NO installed transport, since re-arming over one
 * would fork the gateway's identity; a transport with no Domain id boots standalone (re-enroll only). */
export function decideBootPhase(input: {
	hasTransport: boolean;
	hasDomainId: boolean;
	hasEnrollNonce: boolean;
}): BootPhaseDecision {
	if (input.hasTransport && input.hasDomainId) return "activate";
	if (input.hasEnrollNonce && !input.hasTransport) return "arm";
	return "standalone";
}

export function federationOf(state: BootState): FederationSlice | null {
	return state.phase === "federationActive" ? state.federation : null;
}

export function armingOf(state: BootState): ArmingSlice | null {
	return state.phase === "arming" ? state.arming : null;
}
