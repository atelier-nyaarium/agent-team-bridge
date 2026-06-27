import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { debugLog } from "../../shared/debug-log.js";
import type { HostOp, TmuxTarget } from "../../shared/host-op.js";
import { createReconnector } from "../../shared/reconnect.js";
import { ensureContainerUpAsync, execInContainer, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
import { spawnReloadPlugins } from "./reloadPlugins.js";
import { ensureSession, peekPane, sendKey, sendText } from "./tmuxCore.js";

////////////////////////////////
//  Interfaces & Types

export type ChannelPushHandler = (msg: Record<string, unknown>) => void;

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();

let ws: WebSocket | null = null;
let gatewayUrl = "ws://localhost:20000";
let projectDirs: string[] = [path.join(HOME, "projects")];
let channelPushHandler: ChannelPushHandler | null = null;
const reconnector = createReconnector(() => connect());

// A send on a socket mid-close throws; the daemon must never die because a reply could not be
// delivered. Swallow it - the caller retries on reconnect.
function safeSend(payload: Record<string, unknown>): void {
	try {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	} catch (err) {
		console.error("[host-daemon] ws send failed:", err instanceof Error ? err.message : err);
	}
}

export function startHostDaemon(dirs?: string[], onChannelPush?: ChannelPushHandler): void {
	if (dirs && dirs.length > 0) {
		projectDirs = dirs;
	}
	if (onChannelPush) {
		channelPushHandler = onChannelPush;
	}
	const envUrl = process.env.BRIDGE_ROUTER_URL;
	if (envUrl) {
		gatewayUrl = envUrl.replace(/^http/, "ws");
	}
	connect();
}

export function stopHostWakeListener(): void {
	if (ws) {
		ws.removeAllListeners();
		ws.close();
		ws = null;
	}
}

function connect(): void {
	ws = new WebSocket(`${gatewayUrl}/bridge`);

	ws.on("open", () => {
		console.error("[host-wake] connected to gateway");
		reconnector.reset();
		// Present the host-daemon token. The gateway's host slot is fail-closed: it refuses
		// the register unless it has HOST_WS_TOKEN set AND this token matches it, so
		// start-gateway.sh and start-host-daemon.sh wire the same value from .env.
		const hostToken = process.env.HOST_WS_TOKEN;
		ws!.send(JSON.stringify({ type: "register", team: "host", ...(hostToken ? { token: hostToken } : {}) }));

		const projects = scanDevcontainerProjects();
		ws!.send(JSON.stringify({ type: "catalog", projects }));
		console.error(`[host-wake] sent catalog with ${projects.length} projects`);
	});

	ws.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "wake") {
			void handleWake(msg as unknown as WakeMessage).catch((e) =>
				console.error("[host-wake] dispatch error:", e),
			);
		}

		if (msg.type === "host_op" && typeof msg.reqId === "string") {
			void handleHostOp(msg.reqId as string, msg.op as HostOp).catch((e) =>
				console.error("[host-op] dispatch error:", e),
			);
		}

		if (msg.type === "channel_push") {
			// #region Hypothesis N: host daemon received channel_push fallback
			debugLog("N", "hostDaemon.ts:onMessage", "channel_push received via host", {
				from: msg.from,
				sessionId: String(msg.session_id ?? "").slice(0, 8),
				hasHandler: !!channelPushHandler,
			});
			// #endregion
			if (channelPushHandler) {
				channelPushHandler(msg);
			}
		}
	});

	ws.on("close", () => {
		console.error("[host-wake] disconnected");
		reconnector.schedule();
	});

	ws.on("error", (err: Error) => {
		console.error(`[host-wake] ws error: ${err.message}`);
	});
}

////////////////////////////////
//  Catalog scanner

function scanDevcontainerProjects(): Array<{ team: string; projectPath: string }> {
	const results: Array<{ team: string; projectPath: string }> = [];
	for (const dir of projectDirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
		let entries: string[];
		try {
			entries = fs.readdirSync(resolved);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(resolved, entry);
			try {
				if (!fs.statSync(full).isDirectory()) continue;
				if (fs.existsSync(path.join(full, ".devcontainer", "devcontainer.json"))) {
					results.push({ team: entry, projectPath: full });
				}
			} catch {
				// skip inaccessible entries
			}
		}
	}
	return results;
}

////////////////////////////////
//  Wake handler

interface WakeMessage {
	type: "wake";
	team: string;
	projectPath?: string;
}

function findProjectPath(team: string): string {
	for (const dir of projectDirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
		const candidate = path.join(resolved, team);
		if (fs.existsSync(path.join(candidate, ".devcontainer", "devcontainer.json"))) {
			return candidate;
		}
	}
	return path.join(projectDirs[0], team);
}

async function handleWake(msg: WakeMessage): Promise<void> {
	const projectPath = msg.projectPath || findProjectPath(msg.team);

	// #region Hypothesis J: confirm wake message arrives at hostDaemon
	debugLog("J", "hostDaemon.ts:handleWake", "wake received", {
		team: msg.team,
		projectPath,
		wsReadyState: ws?.readyState ?? null,
	});
	// #endregion

	try {
		const resolved = resolveProject(projectPath);
		const projectName = path.basename(resolved);
		console.error(`[host-wake] starting ${msg.team} at ${resolved}`);

		// #region Hypothesis K: log before ensureContainerUpAsync
		debugLog("K", "hostDaemon.ts:handleWake", "starting container", {
			team: msg.team,
			resolved,
		});
		// #endregion

		const { pluginsProvisioned } = await ensureContainerUpAsync(resolved);

		// #region Hypothesis K: log after ensureContainerUpAsync
		debugLog("K", "hostDaemon.ts:handleWake", "container up", {
			team: msg.team,
			pluginsProvisioned,
		});
		// #endregion

		console.error(`[host-wake] ${msg.team} container is up, starting Claude`);

		let sessionExists = false;
		try {
			await execInContainer({
				projectPath: resolved,
				command: ["tmux", "has-session", "-t", "claude"],
				timeoutMs: 10000,
			});
			sessionExists = true;
		} catch {
			// has-session exits non-zero if session doesn't exist
		}

		if (!sessionExists) {
			await execInContainer({
				projectPath: resolved,
				command: [
					"tmux",
					"new-session",
					"-d",
					"-s",
					"claude",
					buildLaunchCommand({ kind: "devcontainer", name: projectName, sessionName: "claude" }),
				],
				timeoutMs: 15000,
			});
			console.error(`[host-wake] ${msg.team} Claude session started`);
		} else {
			console.error(`[host-wake] ${msg.team} Claude session already exists`);
		}

		// Poll the pane to auto-accept the dev-channels prompt, tracking whether it ever captured: a
		// launch that exits instantly takes its tmux session down with it, so every capture fails.
		let lastScreen = "";
		let captureOk = false;
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			try {
				lastScreen = await execInContainer({
					projectPath: resolved,
					command: ["tmux", "capture-pane", "-t", "claude", "-p"],
					timeoutMs: 10000,
				});
				captureOk = true;
			} catch {
				// a dead session's pane cannot be captured; keep polling
			}
			// "Claude Code v" appears on the idle prompt, not just the wizard
			if (lastScreen.includes("Claude Code v") && !lastScreen.includes("Choose the text style")) {
				console.error(`[host-wake] ${msg.team} Claude is ready`);
				break;
			}
			if (lastScreen.includes("Loading development channels")) {
				try {
					await execInContainer({
						projectPath: resolved,
						command: ["tmux", "send-keys", "-t", "claude", "", "Enter"],
						timeoutMs: 5000,
					});
				} catch {
					// ignore send-keys errors
				}
			}
		}

		// Dead-launch detection: a launch that exits instantly (a bad ~/.bashrc, claude not on PATH, a
		// wrong cwd) takes its tmux session down with it, so its pane never captures. A freshly
		// launched session that captured zero times across the poll is gone -> report a failed wake so
		// /send fails fast. A reattached or slow-but-alive session captured at least once, so a single
		// transient capture error cannot flip the result.
		const launchAlive = sessionExists || captureOk;

		// #region Hypothesis L: log wake_result send state
		debugLog("L", "hostDaemon.ts:handleWake", "sending wake_result success", {
			team: msg.team,
			wsReadyState: ws?.readyState ?? null,
			wsOpen: ws?.readyState === WebSocket.OPEN,
			screenSnippet: lastScreen.slice(0, 200),
		});
		// #endregion

		// Send wake_result with a screen capture so the caller can assess; success reflects whether
		// the launched session is actually alive (dead-launch detection above).
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({
					type: "wake_result",
					team: msg.team,
					success: launchAlive,
					pluginsProvisioned,
					screen: lastScreen,
				}),
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);

		// #region Hypothesis K: log wake failure with error details
		debugLog("K", "hostDaemon.ts:handleWake", "wake failed", {
			team: msg.team,
			error: message,
			wsReadyState: ws?.readyState ?? null,
			wsOpen: ws?.readyState === WebSocket.OPEN,
		});
		// #endregion

		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "wake_result", team: msg.team, success: false, error: message }));
		}
	}
}

////////////////////////////////
//  Host op handler (console terminal view)

const CLAUDE_FLAGS =
	"--dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium";

// The launch command a create_session op runs in a fresh tmux session. The daemon owns it (the
// console supplies only the target + session name), so an arbitrary host command can never be
// injected. A host session is a loose conversational peer; `exec bash` keeps the pane alive after
// Claude exits. A devcontainer session opens in its workspace project.
function buildLaunchCommand(target: TmuxTarget): string {
	if (target.kind === "host") {
		return `bash -c 'source ~/.bashrc && claude --model default --effort low ${CLAUDE_FLAGS}; exec bash'`;
	}
	return `source ~/.bashrc && cd /workspace/${target.name} && claude --model default --effort high ${CLAUDE_FLAGS}`;
}

// The executor owns single-flight + the peek cadence floor; this module only relays the
// reply onto the host WS, correlated by reqId.
const hostOpRunner = createHostOpRunner({
	peekPane,
	sendText,
	sendKey,
	createSession: async (target) => {
		// a create_session op for an existing session reattaches instead of erroring on a duplicate
		// new-session.
		await ensureSession(target, buildLaunchCommand(target));
	},
	reloadPlugins: async (target) => {
		spawnReloadPlugins(target);
	},
});

async function handleHostOp(reqId: string, op: HostOp): Promise<void> {
	try {
		const result = await hostOpRunner.run(op);
		safeSend({ type: "host_op_reply", reqId, ok: true, result });
	} catch (err) {
		safeSend({ type: "host_op_reply", reqId, ok: false, error: (err as Error).message });
	}
}
