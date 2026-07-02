import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Address, isComposite, parseSessionName, SpawnPoint } from "../../shared/session-id.js";
import { bridgeProjectName, routerGet } from "./helpers.js";

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

const DESCRIPTION = `List the agent sessions reachable on the bridge (yours excluded). Each is an addressable session - a devcontainer session as project.session, or a loose / cross-gateway peer. Spawn-point projects and the human's console/host are hidden. You may also target a project.session that is NOT listed: crosstalk_send creates it on first send. Asleep sessions show when they were last seen.`;

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
				const teams = (await routerGet("/discover")) as Array<{
					team: string;
					gatewayId?: string;
					domainId?: string;
					status: string;
					queue_depth: number;
					kind: string;
					lastActive?: number;
					sessionLabel?: string;
				}>;
				// Hide what an agent cannot address as a crosstalk peer: consoles (the human's
				// device), the reserved "host" slot (the human's control point), and bare
				// devcontainer spawn-points (you address a session, not a project - a MISS creates it).
				const others = teams.filter(
					(t) =>
						t.team !== bridgeProjectName() &&
						t.kind !== "console" &&
						t.kind !== "host" &&
						t.kind !== "devcontainer",
				);

				if (others.length === 0) {
					return { content: [{ type: "text" as const, text: `No other sessions found.` }] };
				}

				const lines = others.map((t) => {
					const address = t.gatewayId && t.domainId ? displayTarget(t.domainId, t.gatewayId, t.team) : t.team;
					// Lead with the human label when the gateway supplies one, so a crosstalk agent sees
					// the owner's name for the session beside its addressable form.
					const name = t.sessionLabel ? `${t.sessionLabel} (${address})` : address;
					if (t.status === "available") {
						const seen = t.lastActive ? `, last seen ${relativeAge(t.lastActive)}` : "";
						return `- ${name}: asleep${seen}`;
					}
					if (t.status === "verifying") return `- ${name}: connecting`;
					const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "online";
					return `- ${name}: ${status}`;
				});

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
