import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	LOCAL_DOMAIN_SENTINEL,
	parseSessionName,
	parseTarget,
	SpawnPoint,
} from "../../shared/session-id.js";
import type { GatewayConfig } from "../../shared/types.js";

export interface AddressingDeps {
	config: GatewayConfig;
}

export type Addressing = ReturnType<typeof createAddressing>;

export function createAddressing({ config }: AddressingDeps) {
	const { localGatewayId, localDomainId } = config;
	// The local Domain segment for every address we mint. Null (arming mode, pre-enrollment).
	const localDomain = localDomainId ?? LOCAL_DOMAIN_SENTINEL;

	/** Build the canonical Address of a LOCAL session from its registry team field (`spawn` or
	 * `spawn.session`). The session segment defaults to DEFAULT_SESSION for a bare spawn name. This
	 * is the ONE producer of a local session's canonical, so the share key, the relay gate, and the
	 * job's store-key address all agree byte-for-byte. */
	function localAddress(name: string): Address {
		const { project, session } = parseSessionName(name);
		return Address.local(localDomain, localGatewayId, project, session);
	}

	/** A console is registry-keyed by a free-form human Device Name (not a slug), so its canonical
	 * sender address uses the owner id (a slug, the shared inbox key) as the spawn segment, never the
	 * device name. The device name stays a display label. */
	function consoleSelfAddress(ownerId: string): Address {
		return Address.local(localDomain, localGatewayId, ownerId, DEFAULT_SESSION);
	}

	/** Null instead of throwing for a non-addressable registry key (a console's device name), so a
	 * registry iteration silently skips the operator's own device. */
	function tryLocalAddress(name: string): Address | null {
		try {
			return localAddress(name);
		} catch {
			return null;
		}
	}

	/** Resolve a wire target to a local registry name + its canonical Address. A target whose
	 * (domain, gateway) is ours resolves locally (the local-collapse rule); a different gateway or
	 * Domain returns null (the cross-Gateway branch's job). A spawn-point (arity 1/3) is not an
	 * addressable session and returns null too (the send handler fails it fast with a clear error).
	 * `name` is the registry team field (`spawn.session`); `address` is the channel session target. */
	function resolveLocalTarget(to: string): { name: string; address: Address } | null {
		const t = parseTarget(to, localDomain, localGatewayId);
		if (t instanceof SpawnPoint) return null;
		if (t.domain !== localDomain || t.gateway !== localGatewayId) return null;
		return { name: composeSessionName(t.spawn, t.session), address: t };
	}

	return { localDomain, localAddress, consoleSelfAddress, tryLocalAddress, resolveLocalTarget };
}
