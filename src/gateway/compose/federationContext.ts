// The gateway's one federation reader. Activation publishes the boot, the Domain id, and the
// slice together, so no reader can hold a copy that an enrollment install left behind.

import type { CrossDomainShareTarget } from "../../shared/console-protocol.js";
import type { GatewayBootstrap } from "../boot.js";
import { type ArmingSlice, armingOf, type BootState, type FederationSlice, federationOf } from "../boot.js";
import type { Allowlist } from "../federation/allowlist.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";
import type { RouterTransport } from "../router/transport.js";

export type ShareRecordAction = "cross_domain_share" | "cross_domain_unshare";

export interface FederationContextDeps {
	/** The keyring, live before enrollment and shared with the active slice. */
	contentKeys: ContentKeyStore;
	/** The Domain id read from disk, before any enrollment delivers one. */
	initialDomainId: string | null;
	buildSlice: (boot: GatewayBootstrap) => FederationSlice;
	/** Runs once the slice is published, never before. */
	onActivate: (slice: FederationSlice) => void;
}

export class FederationContext {
	private state: BootState = { phase: "standalone" };
	private activeBoot: GatewayBootstrap | null = null;
	private domain: string | null;

	constructor(private readonly deps: FederationContextDeps) {
		this.domain = deps.initialDomainId;
	}

	bootState(): BootState {
		return this.state;
	}

	slice(): FederationSlice | null {
		return federationOf(this.state);
	}

	arming(): ArmingSlice | null {
		return armingOf(this.state);
	}

	domainId(): string | null {
		return this.domain;
	}

	boot(): GatewayBootstrap | null {
		return this.activeBoot;
	}

	transport(): RouterTransport | null {
		return this.activeBoot?.transport ?? null;
	}

	routerCertFp(): string | undefined {
		return this.activeBoot?.transport.routerCertFp;
	}

	allowlist(): Allowlist | null {
		return this.activeBoot?.allowlist ?? null;
	}

	contentKeys(): ContentKeyStore {
		return this.deps.contentKeys;
	}

	/** The friend Domains this Gateway has linked, each listed once. */
	linkedDomainIds(): string[] {
		const peers = this.slice()?.crossDomainPeers.all() ?? [];
		return [...new Set(peers.map((peer) => peer.friendDomainId))];
	}

	isLinkedDomain(domainId: string): boolean {
		return (
			this.slice()
				?.crossDomainPeers.all()
				.some((peer) => peer.friendDomainId === domainId) ?? false
		);
	}

	arm(arming: ArmingSlice): void {
		this.state = { phase: "arming", arming };
	}

	standalone(): void {
		this.state = { phase: "standalone" };
	}

	/** Builds the slice first, so a failed build leaves the phase untouched. */
	activate(boot: GatewayBootstrap): void {
		if (this.state.phase === "federationActive") return;
		const slice = this.deps.buildSlice(boot);
		this.activeBoot = boot;
		this.domain = boot.domainId;
		this.state = { phase: "federationActive", federation: slice };
		this.deps.onActivate(slice);
	}

	/** Writes the Router's share record. A refusal throws, so no mirror follows it. */
	async postShareRecord(
		action: ShareRecordAction,
		sessionTarget: string,
		target: CrossDomainShareTarget,
	): Promise<void> {
		const slice = this.slice();
		if (!slice) throw new Error("cross-Domain sharing is not available on this Gateway");
		const answer = await slice.routerClient.callInboxTool(action, { sessionTarget, target });
		if (answer.error) throw new Error(answer.error);
		const result = answer.result as { ok?: boolean; outcome?: string; reason?: string; error?: string } | undefined;
		if (result?.ok === false || result?.outcome === "refused") {
			throw new Error(result.reason ?? result.error ?? `the Router refused the ${action} record`);
		}
	}
}
