import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiscoverCoverage } from "../../shared/console-protocol.js";
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

/** Built via the value objects, never a hand-concat, so a bare team does not become an accidental
 * spawn-point. Falls back to the raw team: this is display, not a trust boundary. */
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

/** A team's spawn-point, whether or not a session exists under it. Display, not a trust boundary. */
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
	if (s < 60) return `just now`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Buckets by (domainId, gatewayId, project), so a spawn-point row and its session rows share one
 * header. Trusts the wire's `kind` rather than splitting on dots, since a project name may hold
 * one. Skips an entry with no usable `team`: a federated peer's shape is not locally guaranteed. */
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

/** One caveat line when the answer is partial; empty when complete or unclaimed (older gateway). */
export function coverageCaveat(coverage: DiscoverCoverage | undefined): string {
	if (!coverage) return "";
	if (!coverage.rosterKnown) {
		return `\n\nCaveat: the peer roster could not be read (Router unreachable or this Gateway is not registered), so machines beyond this Gateway may be missing.`;
	}
	const missing = [...(coverage.unreachable ?? []), ...(coverage.unreachablePeers ?? [])];
	if (missing.length === 0) return "";
	return `\n\nCaveat: asked ${coverage.asked} peer gateway(s), ${coverage.answered} answered. Unreachable: ${missing.join(", ")} - their sessions are missing above.`;
}

/** One header per bucket, its active sessions nested below. Exported for tests. */
export function formatDiscoverLines(entries: DiscoverEntry[]): string[] {
	return groupDiscoverEntries(entries).flatMap(({ domainId, gatewayId, project, sessions }) => [
		`- ${displayHeader(domainId, gatewayId, project)}`,
		...sessions.map((t) => `  - ${formatSessionLine(t)}`),
	]);
}

function formatSessionLine(t: DiscoverEntry): string {
	const address = t.gatewayId && t.domainId ? displayTarget(t.domainId, t.gatewayId, t.team) : t.team;
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
			title: `Crosstalk Discover`,
			description: DESCRIPTION,
			inputSchema: {},
		},
		async () => {
			try {
				// An older gateway ignores the query and answers the bare array (no coverage claim).
				const raw = await routerGet("/discover?coverage=1");
				const teams = (
					Array.isArray(raw) ? raw : ((raw as { teams?: DiscoverEntry[] }).teams ?? [])
				) as DiscoverEntry[];
				const coverage = Array.isArray(raw) ? undefined : (raw as { coverage?: DiscoverCoverage }).coverage;
				const localGatewayId = Array.isArray(raw)
					? undefined
					: (raw as { localGatewayId?: string }).localGatewayId;
				// A row is THIS session only when it is on this session's own Gateway: filtering by bare
				// name alone hid a same-named session on every other machine. An older gateway names no
				// gateway, so the bare-name filter stands there. "host" is filtered BY NAME either way: a
				// catalog entry could share the literal team name.
				const isSelf = (t: DiscoverEntry) =>
					t.team === bridgeProjectName() &&
					(!localGatewayId || !t.gatewayId || t.gatewayId === localGatewayId);
				const others = teams.filter((t) => t && !isSelf(t) && t.team !== "host" && t.kind !== "console");

				// Post-grouping: grouping can drop an entry, so a nonzero count renders no line.
				const lines = formatDiscoverLines(others);
				const caveat = coverageCaveat(coverage);
				if (lines.length === 0) {
					return { content: [{ type: "text" as const, text: `No other sessions found.${caveat}` }] };
				}

				return {
					content: [{ type: "text" as const, text: `Sessions on the bridge:\n${lines.join("\n")}${caveat}` }],
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
