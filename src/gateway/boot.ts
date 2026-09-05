import fs from "node:fs";
import path from "node:path";
import type { Ambient } from "../shared/ambient.js";
import type { Identity } from "../shared/crypto.js";
import { DOMAIN_ID_FILE, sanitizeDomainId } from "../shared/domain-id.js";
import { refuseFixtureIdentity } from "../shared/fixture-identity.js";
import type { RouterReach } from "../shared/router-reach.js";
import { Allowlist } from "./federation/allowlist.js";
import { ContentKeyStore } from "./federation/contentKeyStore.js";
import type { CrossDomainHandshakeCoordinator } from "./federation/crossDomainHandshake.js";
import type { CrossDomainPeers } from "./federation/crossDomainPeers.js";
import type { CrossDomainPresenceSource } from "./federation/crossDomainPresenceSource.js";
import type { CrossDomainShareState } from "./federation/crossDomainShareState.js";
import type { AdmitGatewayPayload } from "./federation/enrollQr.js";
import { loadOrCreateIdentity } from "./federation/identity.js";
import type { Sealer } from "./federation/sealer.js";
import type { createBlobUploader } from "./router/blobUploader.js";
import type { createBoardClient } from "./router/boardClient.js";
import type { RouterClient } from "./router/routerClient.js";
import { loadRouterReach, loadRouterTransport, type RouterTransport } from "./router/transport.js";
import type { VaultClient } from "./router/vaultClient.js";

type BoardClient = ReturnType<typeof createBoardClient>;
type BlobUploader = ReturnType<typeof createBlobUploader>;

export interface DomainMeta {
	domainStatus?: string;
	displayName?: string | null;
	isAdminDomain?: boolean;
}

export interface RouterFrameHandlers {
	gatewayRelay: (frame: unknown) => void;
	valueOp: (frame: unknown) => void;
	crossDomainHandshake: (frame: unknown) => void;
}

export interface RouterPresenceHandlers {
	presenceSource: CrossDomainPresenceSource;
	stopPresencePushes: () => void;
}

export interface RouterHandlers {
	frames: RouterFrameHandlers;
	presence: RouterPresenceHandlers;
}

export interface FederationSlice {
	allowlist: Allowlist;
	crossDomainPeers: CrossDomainPeers;
	shareState: CrossDomainShareState;
	coordinator: CrossDomainHandshakeCoordinator;
	sealer: Sealer;
	routerClient: RouterClient;
	contentKeyStore: ContentKeyStore;
	boardClient: BoardClient;
	vaultClient: VaultClient;
	blobUploader: BlobUploader;
	replayPersist: () => void;
	domainMeta: DomainMeta | null;
	handlers: RouterHandlers | null;
}

export interface ArmingSlice {
	/** Enrollment state owns install and payload together. */
	install: (frame: unknown) => string;
	admitPayload: AdmitGatewayPayload;
}

export type BootState =
	| { phase: "standalone" }
	| { phase: "arming"; arming: ArmingSlice }
	| { phase: "federationActive"; federation: FederationSlice };

export type BootPhaseDecision = "activate" | "arm" | "standalone";

export class GatewayBootstrap {
	private constructor(
		readonly identity: Identity,
		readonly domainId: string,
		readonly transport: RouterTransport,
		readonly allowlist: Allowlist,
		readonly contentKeys: ContentKeyStore,
		readonly reach: RouterReach,
	) {}

	static resolve(
		paths: { federationDir: string },
		env: { enrollNonce: string | null; allowFixtureIdentity: boolean; domainIdEnv?: string },
		io: { ambient: Ambient; identity?: () => Identity; contentKeys?: ContentKeyStore },
	): GatewayBoot {
		const allowlist = new Allowlist(paths.federationDir, io.ambient);
		const transport = loadRouterTransport(paths.federationDir);
		const domainId = resolveDomainId(paths.federationDir, allowlist, env.domainIdEnv);
		const decision = decideBootPhase({
			hasTransport: transport !== null,
			hasDomainId: domainId !== null,
			hasEnrollNonce: env.enrollNonce !== null,
		});
		if (decision === "arm") return { kind: "arming", nonce: env.enrollNonce as string };
		if (decision === "standalone") {
			const missing: Array<"transport" | "domainId"> = [];
			if (!transport) missing.push("transport");
			if (!domainId) missing.push("domainId");
			return { kind: "standalone", missing };
		}
		const identity = io.identity?.() ?? loadOrCreateIdentity(paths.federationDir, io.ambient.newId);
		if (!env.allowFixtureIdentity) refuseFixtureIdentity(identity.sign.pub, "gateway");
		const contentKeys =
			io.contentKeys ?? new ContentKeyStore(paths.federationDir, () => identity.box.priv, io.ambient);
		return {
			kind: "active",
			boot: new GatewayBootstrap(
				identity,
				domainId as string,
				transport as RouterTransport,
				allowlist,
				contentKeys,
				loadRouterReach(paths.federationDir),
			),
		};
	}
}

export type GatewayBoot =
	| { kind: "active"; boot: GatewayBootstrap }
	| { kind: "arming"; nonce: string }
	| { kind: "standalone"; missing: Array<"transport" | "domainId"> };

function readDomainIdFile(federationDir: string): string | null {
	try {
		return fs.readFileSync(path.join(federationDir, DOMAIN_ID_FILE), "utf8").trim() || null;
	} catch {
		return null;
	}
}

function resolveDomainId(federationDir: string, allowlist: Allowlist, domainIdEnv?: string): string | null {
	const raw = allowlist.domainId ?? readDomainIdFile(federationDir) ?? domainIdEnv ?? null;
	return raw ? sanitizeDomainId(raw) : null;
}

export function decideBootPhase(input: {
	hasTransport: boolean;
	hasDomainId: boolean;
	hasEnrollNonce: boolean;
}): BootPhaseDecision {
	// Arming requires no transport to prevent identity forks.
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
