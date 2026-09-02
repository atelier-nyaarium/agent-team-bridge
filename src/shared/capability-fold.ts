import { type Capability, type CapabilitySnapshot, UNREPORTED_CAPABILITIES } from "./capabilities.js";
import { EnabledPluginSchema } from "./schemas.js";

export interface CapabilityFoldRecord {
	capabilities: Capability[];
	lastSeen: number;
	reportedAt: number;
	clientVersion?: string;
}

/** Retain valid ids when only guidance fails validation. */
export function admit(raw: unknown): Capability[] {
	const parsed = EnabledPluginSchema.safeParse(raw);
	if (parsed.success) return [parsed.data as Capability];

	const id = EnabledPluginSchema.shape.id.safeParse((raw as { id?: unknown } | null)?.id);
	if (!id.success) return [];

	console.warn(`[capabilities] ${id.data} kept without its guidance: ${parsed.error.issues[0]?.message}`);
	return [{ id: id.data }];
}

export function foldCapabilitySnapshot(
	records: CapabilityFoldRecord[],
	now: number,
	ttlMs: number,
): CapabilitySnapshot {
	const live = records.filter((r) => now - r.lastSeen < ttlMs);
	if (live.length === 0) return UNREPORTED_CAPABILITIES;
	const best = new Map<string, { cap: Capability; reportedAt: number }>();
	for (const record of live) {
		for (const cap of record.capabilities) {
			const prior = best.get(cap.id);
			if (!prior || record.reportedAt > prior.reportedAt)
				best.set(cap.id, { cap, reportedAt: record.reportedAt });
		}
	}
	return {
		known: true,
		capabilities: [...best.values()].map((e) => e.cap).sort((a, b) => a.id.localeCompare(b.id)),
		clientVersions: [...new Set(live.flatMap((r) => (r.clientVersion ? [r.clientVersion] : [])))].sort(),
	};
}
