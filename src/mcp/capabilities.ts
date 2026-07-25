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

/**
 * What a session assumes when the gateway cannot say. Fail OPEN: an agent with a TOOL the owner
 * cannot render loses nothing, while an agent missing a tool the owner does have is a silent
 * capability outage with no error anywhere. Only an affirmative answer ever removes a tool.
 *
 * That argument holds for a tool and not for anything else, which is why `references` is NOT here.
 * References registers no tool: it is a side effect on the reply path, so assuming it means every
 * message the owner receives carries snapshot attachments nothing on their device can open, and the
 * failure is silent in the direction that costs them something. Assumed-off costs a plain link.
 *
 * A second reason, found by asking what the tool description says in each state: a fail-open entry is
 * a bare id with no instructions, because the guidance belongs to the plugin's own manifest. So a
 * cold fallback would switch ref snapshotting on while telling the agent nothing about the format,
 * leaving a reply path that scans and can hard-fail without ever having taught what it scans for.
 */
const FAIL_OPEN_IDS: CapabilityId[] = ["designer"];

const FAIL_OPEN: Capability[] = FAIL_OPEN_IDS.map((id) => ({ id }));

/** The fail-open subset, exported so a fixture can hold it against the shipped plugin manifests. */
export const FAIL_OPEN_CAPABILITY_IDS: readonly CapabilityId[] = FAIL_OPEN_IDS;

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
 * What to assume when no answer arrived. The cache may only ADD to the core set, never shrink below
 * it, so the "only an affirmative answer removes a tool" rule survives a cache that recorded the
 * owner turning something off and then went stale. What the cache is genuinely for is carrying the
 * plugins and instruction text the core set does not know about.
 */
function fallback(): Capability[] {
	const cached = readCache() ?? [];
	const byId = new Map(FAIL_OPEN.map((c) => [c.id, c]));
	for (const capability of cached) byId.set(capability.id, capability);
	return [...byId.values()];
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
