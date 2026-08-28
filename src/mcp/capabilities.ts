import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
	type Capability,
	type CapabilityBundle,
	CODEX_AGENT_CAPABILITY_ID,
	COPILOT_AGENT_CAPABILITY_ID,
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
 * LEGACY, remove after 2026-11-01: the pre-split answer, from a gateway or a cache file.
 *
 * The plugin usually leads the gateway, so a session regularly starts against one several releases
 * behind. Rejecting its answer costs that session every gated tool for its whole life.
 *
 * `clientVersions` is optional because the old cache carried two fields and the old wire three.
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

// An unreachable gateway must cost a beat, not the session's whole startup.
const FETCH_TIMEOUT_MS = 1500;

/** `CapabilityId` derives from this, so a gate on an unreported id is a compile error. */
export const GATED_CAPABILITY_IDS = [
	"designer",
	"references",
	"taskboard",
	CODEX_AGENT_CAPABILITY_ID,
	COPILOT_AGENT_CAPABILITY_ID,
] as const;

export type CapabilityId = (typeof GATED_CAPABILITY_IDS)[number];

export const REFERENCE_GUIDANCE = `

## Artifact refs

Only \`full\` scans markdown links. Use a root-relative path with optional scope and name segments.
Bare is project-relative, \`/x\` is filesystem-root, and \`~/x\` is home. \`[n]\` selects a repeated
name in document order. \`arguments\` names a parameter list and \`arguments:name\` names one parameter.

Use \`#text\` without a chain for symbol-less files, regions inside scopes, or outside paths. A chain
outside the root is refused, and the refusal names the \`#text\` form to write instead. One hash-verified declaration is required for \`exact\`; missing or
ambiguous names refuse with a paste fix. Only lexicon ABSENCE degrades, with a notice and \`fuzzy\` or
\`unresolved\` quality plus a reason.

Examples: [render](ref://src/App.tsx:App:render), [second](ref://src/util.js:deepHandler[2]),
[compute](ref://src/Svc.cs:Acme.Services:Service:Compute), [step](ref://src/engine.cpp:Physics::World::step),
[qty](ref://src/cart.ts:Shop:Cart:add:arguments:qty), [notes](ref://NOTES.md#Checkout),
[region](<ref://src/cart.ts:Shop:Cart:add#this.items.push(item);>),
[outside](ref:///etc/nginx/nginx.conf#server), [home](ref://~/.bashrc#export%20PATH).
`.trim();

function cacheFile(): string {
	return path.join(os.homedir(), ".config", "switchboard", "capabilities-cache.json");
}

// The last answer that DID arrive, and nothing else. Every gated id is one the owner opts into, so
// an assumed set would be guessing.
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
		// Costs the next cold start its last-known answer, nothing more.
	}
}

/**
 * Carried forward PER SOURCE: one that spoke is taken as-is including an affirmative empty, one that
 * stayed silent keeps what it last said. Deciding that across a MERGED list conflates silence with
 * an affirmative empty, dropping or resurrecting a withdrawn capability.
 *
 * Writing it back is safe for the same reason: every section is fresh or a byte-identical carry.
 *
 * Not `routerGet`: that retries past any deadline, cannot see a status, and reads a URL the bridge
 * has not set yet.
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

/** `null` means no answer arrived, which is not the same as an incomplete one. */
export async function readCapabilities(routerUrl: string): Promise<CapabilityBundle | null> {
	try {
		const res = await fetch(`${routerUrl}/capabilities`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return null;
		const bundle = toBundle(await res.json());
		// Its own log line, so version skew does not read as an unreachable gateway.
		if (!bundle) console.error("[capabilities] gateway answered in an unrecognized shape");
		return bundle;
	} catch {
		return null;
	}
}

/** Narrowed to gated ids, so a renamed plugin is a compile error rather than a missing tool. */
export function hasCapability(capabilities: Capability[], id: CapabilityId): boolean {
	return capabilities.some((c) => c.id === id);
}

// Names only: every surface this appends to is length-capped, and guidance pushes the tail past it
// with no error on either side. The instruction is unconditional, since a precondition is something
// an agent can decide does not apply yet.
export function capabilityInstructions(capabilities: Capability[]): string {
	if (capabilities.length === 0) return "";
	const names = capabilities.map((c) => `\`${c.id}\``).join(", ");
	const refs = capabilities.some((c) => c.id === "references") ? `\n\n${REFERENCE_GUIDANCE}` : "";
	return `
	
## Capabilities

Enabled: ${names}.

Call \`switchboard_capabilities\` after receiving a channel message or compacting.${refs}`;
}
