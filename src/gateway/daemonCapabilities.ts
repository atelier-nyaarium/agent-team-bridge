import type { Capability } from "../shared/capabilities.js";
import type { DurableStore } from "../shared/durable-store.js";
import { EnabledPluginSchema } from "../shared/schemas.js";
import type { CapabilitySnapshot } from "./console/capabilityStore.js";

////////////////////////////////
//  Functions & Helpers

/** No source has spoken. Distinct from an affirmative empty declaration. */
export const EMPTY_CAPABILITIES: CapabilitySnapshot = { known: false, capabilities: [], clientVersions: [] };

////////////////////////////////
//  Class

// No TTL, unlike the console store: a stale answer costs a session an advertised tool it cannot
// currently reach, which the runtime checks catch, while expiring it costs every session the tool.
export class DaemonCapabilityStore {
	private declaration: Capability[] | null = null;

	constructor(private readonly durable: DurableStore) {
		this.restore();
	}

	/** Replace the whole declaration. An empty array is an affirmative "nothing enabled". */
	declare(capabilities: Capability[]): void {
		this.declaration = capabilities;
		this.durable.save({ capabilities });
	}

	snapshot(): CapabilitySnapshot {
		return {
			known: this.declaration !== null,
			capabilities: this.declaration ?? [],
			clientVersions: [],
		};
	}

	// An unreadable file reverts to never-announced rather than being salvaged entry by entry. The
	// daemon re-declares on every connect, so the gap closes on its own within a reconnect.
	private restore(): void {
		const raw = this.durable.load() as { capabilities?: unknown } | null;
		if (!raw || !Array.isArray(raw.capabilities)) return;
		const parsed = raw.capabilities.map((c) => EnabledPluginSchema.safeParse(c));
		if (parsed.some((p) => !p.success)) return;
		this.declaration = parsed.map((p) => p.data as Capability);
	}
}

////////////////////////////////
//  Functions & Helpers

/**
 * `known` means COMPLETE, not "somebody spoke". Each source owns a disjoint id space, so a source
 * that has said nothing leaves the answer silent about ids only it can report. An OR here would let
 * the daemon's affirmative "nothing enabled" stand as an authoritative answer about console plugins,
 * and a consumer that trusts it drops every console capability with no error anywhere.
 *
 * Ids being disjoint by ownership is also why first-wins on a collision only settles a misconfiguration.
 */
export function unionCapabilitySnapshots(...snapshots: CapabilitySnapshot[]): CapabilitySnapshot {
	const byId = new Map<string, Capability>();
	for (const snapshot of snapshots) {
		for (const capability of snapshot.capabilities) {
			if (!byId.has(capability.id)) byId.set(capability.id, capability);
		}
	}
	return {
		known: snapshots.length > 0 && snapshots.every((s) => s.known),
		capabilities: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
		clientVersions: [...new Set(snapshots.flatMap((s) => s.clientVersions))].sort(),
	};
}
