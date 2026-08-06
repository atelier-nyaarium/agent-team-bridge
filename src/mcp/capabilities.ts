import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CODEX_THINKING_CAPABILITY_ID } from "../shared/capabilities.js";
import { EnabledPluginSchema } from "../shared/schemas.js";

////////////////////////////////
//  Schemas

const CapabilitySnapshotSchema = z.object({
	known: z.boolean(),
	capabilities: z.array(EnabledPluginSchema),
});

////////////////////////////////
//  Interfaces & Types

export type Capability = z.infer<typeof EnabledPluginSchema>;
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;

////////////////////////////////
//  Functions & Helpers

// The gateway is on the same machine or the same docker network, so a healthy answer is immediate.
// This bound exists so an unreachable one costs a beat rather than the session's whole startup.
const FETCH_TIMEOUT_MS = 1500;

/** The ids a gate may name. `CapabilityId` derives from it, so a gate against an id nothing reports
 * is a compile error rather than a surface that silently never appears. */
export const GATED_CAPABILITY_IDS = ["designer", "references", CODEX_THINKING_CAPABILITY_ID] as const;

export type CapabilityId = (typeof GATED_CAPABILITY_IDS)[number];

function cacheFile(): string {
	return path.join(os.homedir(), ".config", "switchboard", "capabilities-cache.json");
}

function readCache(): Capability[] | null {
	try {
		const parsed = CapabilitySnapshotSchema.safeParse(JSON.parse(fs.readFileSync(cacheFile(), "utf8")));
		return parsed.success && parsed.data.known ? parsed.data.capabilities : null;
	} catch {
		return null;
	}
}

function writeCache(snapshot: unknown): void {
	try {
		const file = cacheFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(snapshot));
	} catch {
		// A cache that cannot be written costs the next cold start its last-known answer, nothing more.
	}
}

// What to assume when no answer arrived: the last answer that DID arrive, and nothing else. Every
// gated id is one the owner opts into, so a hardcoded assumed set would be guessing, and a cold
// start that has never reached the gateway has no evidence to guess from at all.
function fallback(): Capability[] {
	return readCache() ?? [];
}

/**
 * What this session should assume it can reach, from the gateway if it can answer.
 *
 * An INCOMPLETE answer is merged over the cache rather than trusted or discarded. One source going
 * quiet says nothing about the ids another source owns, so taking a partial answer whole would drop
 * every capability the silent source reports, while discarding it would drop the ids it did report.
 *
 * Deliberately not `routerGet`: that retries past any deadline, cannot see a status code, and reads
 * a module-level URL that is only set once the bridge initializes, all three wrong for a call that
 * must answer before the server is built.
 */
export async function fetchCapabilities(routerUrl: string): Promise<Capability[]> {
	const snapshot = await readCapabilities(routerUrl);
	if (!snapshot) return fallback();

	if (snapshot.known) {
		writeCache({ known: true, capabilities: snapshot.capabilities });
		return snapshot.capabilities;
	}

	// The merge is NOT written back. Persisting it would restate a partial answer as a verified one,
	// and on an install where a source is never known that compounds every start: a capability its own
	// source has since withdrawn keeps being read back out of the cache with no way to settle.
	const byId = new Map(snapshot.capabilities.map((c) => [c.id, c]));
	for (const cached of fallback()) if (!byId.has(cached.id)) byId.set(cached.id, cached);
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** One bounded read, with no cache write and no fallback. `null` means no answer arrived at all,
 * which is distinct from the answer that arrived being incomplete. */
export async function readCapabilities(routerUrl: string): Promise<CapabilitySnapshot | null> {
	try {
		const res = await fetch(`${routerUrl}/capabilities`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return null;
		const parsed = CapabilitySnapshotSchema.safeParse(await res.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Whether a capability is available to this session. Narrowed to the ids this build actually gates
 * on, so a renamed plugin is a compile error rather than tools silently going missing. */
export function hasCapability(capabilities: Capability[], id: CapabilityId): boolean {
	return capabilities.some((c) => c.id === id);
}

// Names only: every surface this appends to is length-capped by the harness, and guidance is long
// enough to push the tail of the block past it and be cut with no error on either side.
// The instruction is unconditional because a precondition ("before using it") is something an agent
// can decide does not apply yet, and the block holds nothing else for it to fall back on.
export function capabilityInstructions(capabilities: Capability[]): string {
	if (capabilities.length === 0) return "";
	const names = capabilities.map((c) => c.id).join(", ");
	return [
		`\n\nSwitchboard capabilities enabled: ${names}.`,
		"Call switchboard_capabilities once to understand their features.",
		"If your context has just been compacted, call it again.",
	].join(" ");
}
