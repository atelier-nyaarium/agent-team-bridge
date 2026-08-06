import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
	type Capability,
	type CapabilityBundle,
	CODEX_THINKING_CAPABILITY_ID,
	UNREPORTED_CAPABILITIES,
	unionCapabilities,
} from "../shared/capabilities.js";
import { CapabilityBundleSchema, EnabledPluginSchema } from "../shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

export type { Capability };

////////////////////////////////
//  Functions & Helpers

const NOTHING_REPORTED: CapabilityBundle = { console: UNREPORTED_CAPABILITIES, daemon: UNREPORTED_CAPABILITIES };

/**
 * LEGACY, remove after 2026-11-01. An answer from before the sources were kept apart, from a gateway
 * or a cache file.
 *
 * The plugin and the gateway update on their own triggers and the plugin usually leads, so a session
 * regularly starts against a gateway several releases behind. Rejecting its answer costs that session
 * every gated tool, silently and for its whole life.
 *
 * `clientVersions` is optional because the old cache file carried only two fields while the old wire
 * response carried three. Lifting the list into `console` loses nothing, since a merged endpoint had
 * already folded both sources into it, and leaving `daemon` unreported avoids claiming an answer no
 * source gave.
 */
const LegacyCapabilitiesSchema = z.object({
	known: z.boolean(),
	capabilities: z.array(EnabledPluginSchema),
	clientVersions: z.array(z.string()).optional().default([]),
});

function toBundle(raw: unknown): CapabilityBundle | null {
	const bundle = CapabilityBundleSchema.safeParse(raw);
	if (bundle.success) return bundle.data;
	const legacy = LegacyCapabilitiesSchema.safeParse(raw);
	return legacy.success ? { console: legacy.data, daemon: UNREPORTED_CAPABILITIES } : null;
}

// The gateway is on the same machine or the same docker network, so a healthy answer is immediate.
// This bound exists so an unreachable one costs a beat rather than the session's whole startup.
const FETCH_TIMEOUT_MS = 1500;

/** The ids a gate may name. `CapabilityId` derives from it, so a gate against an id nothing reports
 * is a compile error rather than a surface that silently never appears. */
export const GATED_CAPABILITY_IDS = ["designer", "references", "taskboard", CODEX_THINKING_CAPABILITY_ID] as const;

export type CapabilityId = (typeof GATED_CAPABILITY_IDS)[number];

function cacheFile(): string {
	return path.join(os.homedir(), ".config", "switchboard", "capabilities-cache.json");
}

// What to assume when no answer arrived: the last one that DID arrive, and nothing else. Every gated
// id is one the owner opts into, so a hardcoded assumed set would be guessing, and a cold start that
// has never reached the gateway has no evidence to guess from at all.
function readCache(): CapabilityBundle {
	try {
		return toBundle(JSON.parse(fs.readFileSync(cacheFile(), "utf8"))) ?? NOTHING_REPORTED;
	} catch {
		return NOTHING_REPORTED;
	}
}

function writeCache(bundle: CapabilityBundle): void {
	try {
		const file = cacheFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(bundle));
	} catch {
		// A cache that cannot be written costs the next cold start its last-known answer, nothing more.
	}
}

/**
 * What this session should assume it can reach, from the gateway if it can answer.
 *
 * Carried forward PER SOURCE. A source that spoke this round is taken as-is for the ids it owns,
 * including an affirmative empty, and one that stayed silent keeps whatever it last said. Deciding
 * that across a merged list is what repeatedly dropped or resurrected a capability.
 *
 * Writing the result back is safe for the same reason: every section in it is either a fresh answer
 * or a byte-identical carry-forward of one, so nothing inferred is ever stored as reported.
 *
 * Deliberately not `routerGet`: that retries past any deadline, cannot see a status code, and reads
 * a module-level URL that is only set once the bridge initializes, all three wrong for a call that
 * must answer before the server is built.
 */
export async function fetchCapabilities(routerUrl: string): Promise<Capability[]> {
	const cached = readCache();
	const fresh = await readCapabilities(routerUrl);
	if (!fresh) return unionCapabilities(cached).capabilities;

	const carried: CapabilityBundle = {
		console: fresh.console.known ? fresh.console : cached.console,
		daemon: fresh.daemon.known ? fresh.daemon : cached.daemon,
	};
	writeCache(carried);
	return unionCapabilities(carried).capabilities;
}

/** One bounded read, with no cache write and no fallback. `null` means no answer arrived at all,
 * which is distinct from the answer that arrived being incomplete. */
export async function readCapabilities(routerUrl: string): Promise<CapabilityBundle | null> {
	try {
		const res = await fetch(`${routerUrl}/capabilities`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return null;
		const bundle = toBundle(await res.json());
		// Distinguishable from an unreachable gateway in the log, so version skew does not read as a
		// dead one while a session quietly starts with nothing.
		if (!bundle) console.error("[capabilities] gateway answered in an unrecognized shape");
		return bundle;
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
