import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { debugLog } from "../../shared/debug-log.js";
import { type HostOp, isTmuxName, type TmuxTarget } from "../../shared/host-op.js";
import { createReconnector } from "../../shared/reconnect.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
import { spawnReloadPlugins } from "./reloadPlugins.js";
import { ensureSession, isAgentReady, killSession, peekPane, sendKey, sendText } from "./tmuxCore.js";

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
	// The composite `project.session` to wake; the daemon parses it into the project (container/dir)
	// and the tmux session name.
	team: string;
	projectPath?: string;
	// The Claude harness id to `--resume`, if the gateway has one mapped for this session.
	resumeSessionId?: string;
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
	// The composite carries (project, session); a bare name defaults the session to "claude". Both
	// segments are interpolated into tmux/shell commands, so reject a non-slug before launching.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		console.error(`[host-wake] refusing wake of "${msg.team}": invalid project/session name`);
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({ type: "wake_result", team: msg.team, success: false, error: "invalid session name" }),
			);
		}
		return;
	}
	const projectPath = msg.projectPath || findProjectPath(project);

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

		// Reattach if the session is already alive, else launch it (with --resume baked into the
		// command when an id is mapped). The container is up, so the tmux ops go through tmuxCore's
		// docker exec (the proven terminal-op path).
		const target: TmuxTarget = { kind: "devcontainer", name: projectName, sessionName: session };
		const { created } = await ensureSession(
			target,
			buildLaunchCommand(target, { resumeSessionId: msg.resumeSessionId }),
		);
		console.error(`[host-wake] ${msg.team} session ${created ? "started" : "already running"}`);

		// For a fresh launch, poll the pane to auto-accept the dev-channels prompt and track whether it
		// ever captured: a launch that exits instantly takes its tmux session down with it, so zero
		// captures means a dead launch -> report a failed wake so /send fails fast. A slow-but-alive
		// session captures at least once.
		let lastScreen = "";
		let launchAlive = !created;
		if (created) {
			let captureOk = false;
			for (let i = 0; i < 10; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				try {
					lastScreen = (await peekPane(target)).ansi;
					captureOk = true;
				} catch {
					// a dead session's pane cannot be captured; keep polling
				}
				if (isAgentReady(lastScreen)) {
					console.error(`[host-wake] ${msg.team} Claude is ready`);
					break;
				}
				if (lastScreen.includes("Loading development channels")) {
					try {
						await sendKey(target, "Enter");
					} catch {
						// ignore send-keys errors
					}
				}
			}
			launchAlive = captureOk;
		} else {
			try {
				lastScreen = (await peekPane(target)).ansi;
			} catch {
				// reattach is alive regardless; the screen is best-effort
			}
		}

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

// The launch command for a session's tmux. The daemon owns it (callers supply only the target +
// optional resume id), so an arbitrary host command can never be injected. The session registers
// under its COMPOSITE name (`project.session`) by overriding PROJECT_NAME AFTER sourcing ~/.bashrc;
// the override must run in the same shell as claude (a prefix on `source` would not survive), so the
// whole chain is one `bash -c`. A host session keeps its pane alive with `exec bash` after Claude
// exits; a devcontainer session opens in its workspace project. The target's name/sessionName are
// slug-validated by callers; the resume id is uuid-shaped, so single-quote interpolation is safe.
export function buildLaunchCommand(target: TmuxTarget, opts: { resumeSessionId?: string } = {}): string {
	const composite = composeSessionName(target.name, target.sessionName);
	const resume =
		opts.resumeSessionId && /^[0-9a-fA-F-]{8,}$/.test(opts.resumeSessionId)
			? ` --resume ${opts.resumeSessionId}`
			: "";
	const effort = target.kind === "host" ? "low" : "high";
	const claude = `claude --model default --effort ${effort} ${CLAUDE_FLAGS}${resume}`;
	if (target.kind === "host") {
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${claude}; exec bash'`;
	}
	return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; cd /workspace/${target.name}; exec ${claude}'`;
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
	killSession,
});

async function handleHostOp(reqId: string, op: HostOp): Promise<void> {
	try {
		const result = await hostOpRunner.run(op);
		safeSend({ type: "host_op_reply", reqId, ok: true, result });
	} catch (err) {
		safeSend({ type: "host_op_reply", reqId, ok: false, error: (err as Error).message });
	}
}
