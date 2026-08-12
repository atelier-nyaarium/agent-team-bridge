import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Address, isComposite, parseSessionName, SpawnPoint } from "../../shared/session-id.js";
import { bridgeProjectName, routerGet } from "./helpers.js";

////////////////////////////////
//  Interfaces & Types

export interface DiscoverEntry {
	team: string;
	gatewayId?: string;
	domainId?: string;
	status: string;
	queue_depth: number;
	kind: string;
	lastActive?: number;
	sessionLabel?: string;
}

export interface DiscoverGroup {
	domainId?: string;
	gatewayId?: string;
	project: string;
	sessions: DiscoverEntry[];
}

////////////////////////////////
//  Functions & Helpers

/** The agent-facing canonical address of a discovered peer, built via the value objects (never a
 * hand-concat, so a bare team field becomes the right form, not an accidental 3-segment spawn-point).
 * Falls back to the raw team on a malformed segment, since this is display, not a trust boundary. */
function displayTarget(domainId: string, gatewayId: string, team: string): string {
	try {
		const { project, session } = parseSessionName(team);
		return isComposite(team)
			? Address.of(domainId, gatewayId, project, session).canonical
			: SpawnPoint.of(domainId, gatewayId, project).canonical;
	} catch {
		return team;
	}
}

/** The addressable form of a discover group's header - a team's spawn-point - regardless of
 * whether any session exists under it yet. Falls back to the bare project name when the
 * (domainId, gatewayId) pair isn't resolvable, since this is display, not a trust boundary. */
function displayHeader(domainId: string | undefined, gatewayId: string | undefined, project: string): string {
	if (!domainId || !gatewayId) return project;
	try {
		return SpawnPoint.of(domainId, gatewayId, project).canonical;
	} catch {
		return project;
	}
}

/** A coarse "5m ago" / "2h ago" recency label for an asleep session's last-seen timestamp. */
export function relativeAge(lastActiveMs: number, nowMs: number = Date.now()): string {
	const s = Math.max(0, Math.floor((nowMs - lastActiveMs) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Buckets entries by (domainId, gatewayId, project) so a team's bare spawn-point row and its
 * composite session rows collapse under one header instead of printing twice - `teams()` emits
 * both for a catalog project with active sessions. Trusts the wire's own `kind` to tell a bare
 * catalog project from a composite session rather than re-splitting `team` on its dots: a
 * catalog project name may itself contain a dot (`isCatalogProject` elsewhere in this codebase
 * makes the same call by membership, never by the mechanical dot test), so treating `team` as
 * the whole project name for a `"devcontainer"` entry is the only form that can't mis-split one.
 * Skips an entry with no usable `team` instead of throwing, since a federated peer's shape isn't
 * locally guaranteed. Pure given the filtered entry list, exported for tests. */
export function groupDiscoverEntries(entries: DiscoverEntry[]): DiscoverGroup[] {
	const groups = new Map<string, DiscoverGroup>();
	for (const t of entries) {
		if (!t || typeof t.team !== "string" || !t.team) continue;
		const project = t.kind === "devcontainer" ? t.team : parseSessionName(t.team).project;
		const key = `${t.domainId ?? ""} ${t.gatewayId ?? ""} ${project}`;
		let group = groups.get(key);
		if (!group) {
			group = { domainId: t.domainId, gatewayId: t.gatewayId, project, sessions: [] };
			groups.set(key, group);
		}
		if (t.kind !== "devcontainer") group.sessions.push(t);
	}
	return [...groups.values()];
}

/** Renders the filtered entry list as grouped/header output lines - one header per (domainId,
 * gatewayId, project) bucket, its active sessions nested below. Pure given the filtered entry
 * list, exported for tests. */
export function formatDiscoverLines(entries: DiscoverEntry[]): string[] {
	return groupDiscoverEntries(entries).flatMap(({ domainId, gatewayId, project, sessions }) => [
		`- ${displayHeader(domainId, gatewayId, project)}`,
		...sessions.map((t) => `  - ${formatSessionLine(t)}`),
	]);
}

function formatSessionLine(t: DiscoverEntry): string {
	const address = t.gatewayId && t.domainId ? displayTarget(t.domainId, t.gatewayId, t.team) : t.team;
	// Lead with the human label when the gateway supplies one, so a crosstalk agent sees
	// the owner's name for the session beside its addressable form.
	const name = t.sessionLabel ? `${t.sessionLabel} (${address})` : address;
	if (t.status === "available") {
		const seen = t.lastActive ? `, last seen ${relativeAge(t.lastActive)}` : "";
		return `${name}: asleep${seen}`;
	}
	if (t.status === "verifying") return `${name}: connecting`;
	const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "online";
	return `${name}: ${status}`;
}

const DESCRIPTION = `
# Crosstalk Discover

List reachable agent teams, excluding this session.

Each team has a spawn-point address. A spawn point without a session is not a valid target. Use \`crosstalk_send\` with \`displayLabel\` to create a session under it.

Active sessions appear under each team at their full addresses. Asleep sessions show their last-seen time.
`.trim();

export function registerBridgeDiscover(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_discover",
		{
			title: "Crosstalk Discover",
			description: DESCRIPTION,
			inputSchema: {},
		},
		async () => {
			try {
				// /discover fans out across the mesh: local teams plus every online
				// peer Gateway's teams (evie stays content-blind). A federated peer carries its
				// own (domainId, gatewayId), shown as the full domain.gateway.spawn.session
				// address so it is addressable.
				const teams = (await routerGet("/discover")) as DiscoverEntry[];
				// Hide what an agent cannot address as a crosstalk peer: consoles (the human's
				// device) and the reserved "host" daemon by name (kind alone can't isolate it - a
				// stray catalog entry could share the literal team name "host").
				const others = teams.filter(
					(t) => t && t.team !== bridgeProjectName() && t.team !== "host" && t.kind !== "console",
				);

				// Checked post-grouping, not on the raw filtered count: groupDiscoverEntries can drop an
				// entry with no usable team (a malformed federated peer), so a nonzero others.length does
				// not guarantee any line actually renders.
				const lines = formatDiscoverLines(others);
				if (lines.length === 0) {
					return { content: [{ type: "text" as const, text: `No other sessions found.` }] };
				}

				return {
					content: [{ type: "text" as const, text: `Sessions on the bridge:\n${lines.join("\n")}` }],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reach router: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
