import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
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

////////////////////////////////
//  Functions & Helpers

// The gateway is on the same machine or the same docker network, so a healthy answer is immediate.
// This bound exists so an unreachable one costs a beat rather than the session's whole startup.
const FETCH_TIMEOUT_MS = 1500;

/** Every capability this build gates something on. The type derives from it, so a gate against an
 * id nothing reports is a compile error rather than a surface that silently never appears. */
export const GATED_CAPABILITY_IDS = ["designer", "references"] as const;

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

/**
 * What to assume when no answer arrived: the last answer that DID arrive, and nothing else.
 *
 * There is no hardcoded set of assumed capabilities, deliberately. Every gated id is a console
 * plugin the owner opts into, so there is no principled basis for the code to assume one and not
 * another, and any such list is a rule with an exception list that drifts (this one did, and shipped
 * a plugin as assumed while the comment above it argued the opposite).
 *
 * The cache is the honest version of the same intent. It answers the case that motivated a fail-open
 * set in the first place, a gateway blip stripping a session's tools, and it answers it with the
 * evidence of what the owner actually had rather than a guess. Its guidance text rides along too, so
 * a recovered answer is complete rather than a bare id.
 *
 * Which leaves exactly one uncovered state: a cold start that has never once reached the gateway. An
 * empty answer is the correct one there. Nothing has ever said this owner can render anything, and
 * inventing a surface at that moment is guessing with the least evidence available anywhere.
 */
function fallback(): Capability[] {
	return readCache() ?? [];
}

/**
 * What the owner's consoles can render, as this session should assume it.
 *
 * Deliberately not `routerGet`: that retries past any deadline, cannot see a status code, and reads
 * a module-level URL that is only set once the bridge initializes - all three wrong for a call that
 * must answer before the server is built. One attempt, bounded, then the fallback above.
 */
export async function fetchCapabilities(routerUrl: string): Promise<Capability[]> {
	try {
		const res = await fetch(`${routerUrl}/capabilities`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return fallback();
		const parsed = CapabilitySnapshotSchema.safeParse(await res.json());
		if (!parsed.success) return fallback();
		// A gateway that has never heard from a device has no opinion, which is not the same as
		// asserting the owner has nothing enabled.
		if (!parsed.data.known) return fallback();
		writeCache(parsed.data);
		return parsed.data.capabilities;
	} catch {
		return fallback();
	}
}

/** Whether a capability is available to this session. Narrowed to the ids this build actually gates
 * on, so a renamed plugin is a compile error rather than tools silently going missing. */
export function hasCapability(capabilities: Capability[], id: CapabilityId): boolean {
	return capabilities.some((c) => c.id === id);
}

/** The guidance a plugin's own manifest wants an agent to carry, ready to append to the server's
 * instructions. Empty when nothing enabled has anything to say. */
export function capabilityInstructions(capabilities: Capability[]): string {
	const lines = capabilities.flatMap((c) => (c.instructions ? [`- ${c.instructions}`] : []));
	return lines.length === 0 ? "" : `\n\nThe owner's console has these enabled:\n${lines.join("\n")}`;
}
