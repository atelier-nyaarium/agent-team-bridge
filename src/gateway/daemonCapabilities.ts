import type { Capability, CapabilitySnapshot } from "../shared/capabilities.js";
import type { DurableStore } from "../shared/durable-store.js";
import { EnabledPluginSchema } from "../shared/schemas.js";

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
