import crypto from "node:crypto";
import path from "node:path";
import WebSocket from "ws";
import { agentEnvPrefix, agentFrameType, CODEX_BACKEND, COPILOT_BACKEND } from "../../shared/agent-backend.js";
import type { LimitNotice } from "../../shared/agent-screen.js";
import { daemonCapabilityDeclaration } from "../../shared/capabilities.js";
import { CodexEventAckSchema } from "../../shared/codex-agent.js";
import { CopilotEventAckSchema } from "../../shared/copilot-agent.js";
import {
	classifyPeekError,
	type HostOp,
	isReservedHostSession,
	isTmuxName,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { isHostSpawn, WINDOWS_SPAWN } from "../../shared/host-spawn.js";
import { createReconnector } from "../../shared/reconnect.js";
import { parseSessionName } from "../../shared/session-id.js";
import { CodexDaemonService } from "./codexDaemonService.js";
import { ExecutionTargetManager, targetLogger } from "./codexTargets.js";
import { CopilotDaemonService } from "./copilotDaemonService.js";
import { copilotLauncher } from "./copilotTargets.js";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
import {
	buildLaunchCommand,
	FIRST_LAUNCH_GREETING,
	findProjectPath,
	listHostDirs,
	resolveHostWorkdir,
	resolveWatchTarget,
	scanDevcontainerProjects,
	setProjectDirs,
	shouldGreetLaunch,
} from "./hostResolve.js";
import { PresenceScheduler, type WatchEntry } from "./presenceScheduler.js";
import { spawnReloadPlugins } from "./reloadPlugins.js";
import {
	awaitReady,
	ensureSession,
	isAgentReady,
	isAgentWorking,
	killSession,
	paneAgentState,
	peekPane,
	peekWithFallback,
	sendKey,
	sendText,
} from "./tmuxCore.js";
import {
	detectedHostSpawns,
	listWindowsDirs,
	probeWindowsSpawn,
	resolveWindowsWorkdir,
	type WindowsSpawnAvailability,
} from "./windowsSpawn.js";

////////////////////////////////
//  Interfaces & Types

export type ChannelPushHandler = (msg: Record<string, unknown>) => void;

////////////////////////////////
//  Functions & Helpers

let ws: WebSocket | null = null;
let gatewayUrl = "ws://localhost:20000";
let channelPushHandler: ChannelPushHandler | null = null;
const reconnector = createReconnector(() => connect());

/** Probed once per process. PowerShell startup is ~0.36s, which is fine at register and not fine on
 * every wake, and a machine does not gain or lose a Windows side while the daemon runs. A restart is
 * the invalidation, which is also what installing the CLI would prompt. */
let windowsSpawn: WindowsSpawnAvailability | null = null;
function windowsAvailability(): WindowsSpawnAvailability {
	if (!windowsSpawn) {
		windowsSpawn = probeWindowsSpawn();
		const detail = windowsSpawn.available ? `home ${windowsSpawn.userProfile}` : windowsSpawn.reason;
		console.error(`[host-daemon] windows spawn point: ${windowsSpawn.available ? "available" : "no"} (${detail})`);
	}
	return windowsSpawn;
}

/** The ONE place a host spawn point's working directory is resolved, so the wake path and the
 * console's create_session cannot answer differently for the same hint. Returns an error rather than
 * a fallback for a spawn point that cannot use the host's own paths: silently substituting a
 * directory is how a session ends up working somewhere nobody asked for. */
function resolveSpawnWorkdir(spawn: string, hint: string | undefined): { workdir: string } | { error: string } {
	if (spawn !== WINDOWS_SPAWN) return { workdir: resolveHostWorkdir(hint) };
	const probe = windowsAvailability();
	if (!probe.available || !probe.userProfile) {
		return { error: `this machine cannot run a windows session (${probe.reason ?? "unavailable"})` };
	}
	return resolveWindowsWorkdir(hint, probe.userProfile);
}
// Per process, not per socket.
const daemonInstanceId = crypto.randomUUID();
const codexTargets = new ExecutionTargetManager();
const codexDaemon = new CodexDaemonService({
	targets: codexTargets,
	daemonInstanceId,
	send: safeSend,
	resolveHostCwd: (hint) => resolveHostWorkdir(hint),
});
const copilotTargets = new ExecutionTargetManager(
	copilotLauncher,
	undefined,
	targetLogger("copilot-target"),
	undefined,
	agentEnvPrefix("copilot"),
);
const copilotDaemon = new CopilotDaemonService({
	targets: copilotTargets,
	daemonInstanceId,
	send: safeSend,
	resolveHostCwd: (hint) => resolveHostWorkdir(hint),
});
const AGENT_DAEMON_BINDINGS = [
	{ descriptor: CODEX_BACKEND, targets: codexTargets, service: codexDaemon, parseAck: CodexEventAckSchema },
	{ descriptor: COPILOT_BACKEND, targets: copilotTargets, service: copilotDaemon, parseAck: CopilotEventAckSchema },
] as const;
// A second wake kills a starting session.
const inflightWakes = new Map<string, Promise<void>>();

// A send mid-close throws.
function safeSend(payload: Record<string, unknown>): void {
	try {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	} catch (err) {
		console.error("[host-daemon] ws send failed:", err instanceof Error ? err.message : err);
	}
}

/** Reap every supervised App Server. */
export function stopSupervisedChildren(): void {
	for (const { service, targets } of AGENT_DAEMON_BINDINGS) {
		service.shutdown();
		targets.shutdown();
	}
}

/** Stops the reconnect timer as well as the children, so shutdown leaves nothing scheduled. */
export function stopHostDaemon(): void {
	reconnector.cancel();
	stopSupervisedChildren();
}

export function startHostDaemon(dirs?: string[], onChannelPush?: ChannelPushHandler): void {
	if (dirs && dirs.length > 0) {
		setProjectDirs(dirs);
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

function connect(): void {
	ws = new WebSocket(`${gatewayUrl}/bridge`);

	ws.on("open", () => {
		console.error("[host-wake] connected to gateway");
		reconnector.reset();
		// The host slot is fail-closed.
		const hostToken = process.env.HOST_WS_TOKEN;
		ws!.send(
			JSON.stringify({
				type: "register",
				team: "host",
				...(hostToken ? { token: hostToken } : {}),
				daemonCapabilities: daemonCapabilityDeclaration(process.env),
				daemonInstanceId,
			}),
		);

		// Replay what the gateway never committed.
		for (const { service } of AGENT_DAEMON_BINDINGS) {
			safeSend(service.hello());
			service.replay();
		}

		const projects = scanDevcontainerProjects();
		// `hostSpawns` names the DETECTED spawn points only; `host` is on every machine and is not
		// announced. An older gateway ignores the field, which is the whole point of announcing before
		// anything consumes it: daemon first, gateway next, console last, each safe on its own.
		const hostSpawns = detectedHostSpawns(windowsAvailability());
		ws!.send(JSON.stringify({ type: "catalog", projects, hostSpawns }));
		console.error(
			`[host-wake] sent catalog with ${projects.length} projects` +
				(hostSpawns.length ? ` and host spawn points: ${hostSpawns.join(", ")}` : ""),
		);

		// observe() fires on transitions, so a stale confirmation re-confirms forever.
		presenceScheduler.clearAll();
	});

	ws.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "wake") {
			const wakeMsg = msg as unknown as WakeMessage;
			if (!inflightWakes.has(wakeMsg.team)) {
				const run = handleWake(wakeMsg)
					.catch((e) => console.error("[host-wake] dispatch error:", e))
					.finally(() => inflightWakes.delete(wakeMsg.team));
				inflightWakes.set(wakeMsg.team, run);
			}
		}

		if (msg.type === "host_op" && typeof msg.reqId === "string") {
			void handleHostOp(msg.reqId as string, msg.op as HostOp).catch((e) =>
				console.error("[host-op] dispatch error:", e),
			);
		}

		for (const { descriptor, service, parseAck } of AGENT_DAEMON_BINDINGS) {
			if (msg.type === agentFrameType(descriptor.id, "command")) service.handleCommand(msg);
			if (msg.type === agentFrameType(descriptor.id, "ack")) {
				const ack = parseAck.safeParse(msg);
				if (ack.success) service.acknowledge(ack.data);
			}
		}

		if (msg.type === "presence_watch" && Array.isArray(msg.watch)) {
			const entries: WatchEntry[] = [];
			for (const raw of msg.watch) {
				if (typeof raw?.team !== "string" || typeof raw?.cadenceMs !== "number") continue;
				const target = resolveWatchTarget(raw.team);
				if (target) entries.push({ team: raw.team, target, cadenceMs: raw.cadenceMs });
			}
			void presenceScheduler.setWatches(entries);
		}

		if (msg.type === "channel_push") {
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
//  Wake handler

interface WakeMessage {
	type: "wake";
	team: string;
	projectPath?: string;
	resumeSessionId?: string;
	// Host only: ~/projects/<hint>.
	workdirHint?: string;
	// Proves which record.
	sessionToken?: string;
}

// Never blocks the reply.
function greetFreshLaunch(
	target: TmuxTarget,
	opts: { created: boolean; resumeSessionId?: string; ready: boolean },
): void {
	if (!shouldGreetLaunch(opts)) return;
	console.error(`[host-wake] greeting freshly created session ${target.sessionName}`);
	void sendText(target, FIRST_LAUNCH_GREETING).catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to greet ${target.sessionName}: ${message}`);
	});
}

// The bun this daemon runs on, so a launched session finds the plugin's `bun` whatever the tmux
// server's PATH inherited.
const LAUNCH_PATH_PREFIX = path.dirname(process.execPath);

async function handleWake(msg: WakeMessage): Promise<void> {
	// Both segments reach tmux and shell commands.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		console.error(`[host-wake] refusing wake of "${msg.team}": invalid project/session name`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: "invalid session name" });
		return;
	}
	// The daemon shares this tmux server. Registry-wide rather than the bare literal, so every host
	// spawn point reaches this branch and none falls through to the devcontainer path below, which
	// would look for a container named after a shell.
	if (isHostSpawn(project)) {
		if (isReservedHostSession(session)) {
			console.error(`[host-wake] refusing wake of "${msg.team}": "${session}" is a reserved host session`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: "reserved host session" });
			return;
		}
		// Defence in depth behind the gateway's own rule: a host launch the gateway cannot name a
		// record for carries no token, and nothing on this machine should start a shell for it.
		if (!msg.sessionToken) {
			console.error(`[host-wake] refusing wake of "${msg.team}": no session token`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: "no session token" });
			return;
		}
		const target: TmuxTarget = { kind: "host", name: project, sessionName: session };
		// A spawn point whose shell does not share this filesystem needs its own resolution, and one
		// that REFUSES rather than falling back: a Windows session handed a Linux path lands on a UNC
		// cwd, which works well enough to look fine and then strands every subprocess it starts.
		const resolved = resolveSpawnWorkdir(project, msg.workdirHint);
		if ("error" in resolved) {
			console.error(`[host-wake] refusing wake of "${msg.team}": ${resolved.error}`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: resolved.error });
			return;
		}
		const launch = buildLaunchCommand(target, {
			resumeSessionId: msg.resumeSessionId,
			workdir: resolved.workdir,
			sessionToken: msg.sessionToken,
			pathPrefix: LAUNCH_PATH_PREFIX,
		});
		console.error(`[host-wake] starting host session ${msg.team}`);
		try {
			const { created } = await ensureSession(target, launch);
			let res = created ? await awaitReady(target) : undefined;
			// `exec bash` outlives claude, so a reattach can land on a dead shell. The SCREEN cannot
			// see that: the frame the agent painted before it died still carries its own composer at
			// column 0, so isAgentReady answers yes for a pane holding nothing but a prompt, and this
			// recovery never ran for the case it was written for. So the OS is asked too, and either
			// answer alone is enough to relaunch. A limit dialog is alive, not dead: relaunching would
			// discard it and hit the same limit again.
			const processGone = !created && (await paneAgentState(target)) === "gone";
			if (!created && !processGone) res = await awaitReady(target);
			if (!res) throw new Error("session readiness unavailable");
			const screenDead = !created && !res?.ready && !isAgentWorking(res?.screen ?? "");
			if (!created && !res.limit && (processGone || screenDead)) {
				// A proven-gone process needs no second look - the recheck reads the same lying frame.
				const recheck = processGone
					? ""
					: await peekPane(target)
							.then((p) => p.ansi)
							.catch(() => res?.screen ?? "");
				const ready = isAgentReady(recheck);
				if (!processGone && (ready || isAgentWorking(recheck))) {
					// The frame was a sub-second transition after all.
					res = { alive: true, ready, screen: recheck };
				} else {
					await killSession(target);
					await ensureSession(target, launch);
					res = await awaitReady(target);
				}
			}
			// Original ensureSession, not relaunch.
			greetFreshLaunch(target, { created, resumeSessionId: msg.resumeSessionId, ready: res.ready });
			const live = res.ready || isAgentWorking(res.screen);
			if (res.limit) {
				console.error(
					`[host-wake] ${msg.team} hit a usage limit: ${res.limit.headline ?? "no headline on screen"}`,
				);
			} else {
				console.error(`[host-wake] ${msg.team} ${live ? "Claude is up" : "did not reach the REPL"}`);
			}
			safeSend({
				type: "wake_result",
				team: msg.team,
				success: live,
				screen: res.screen,
				...(res.limit ? { error: `session limit hit${res.limit.detail ? ` (${res.limit.detail})` : ""}` } : {}),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: message });
		}
		return;
	}

	const projectPath = msg.projectPath || findProjectPath(project);

	try {
		const resolved = resolveProject(projectPath);
		const projectName = path.basename(resolved);
		console.error(`[host-wake] starting ${msg.team} at ${resolved}`);

		const { pluginsProvisioned } = await ensureContainerUpAsync(resolved);

		console.error(`[host-wake] ${msg.team} container is up, starting Claude`);

		const target: TmuxTarget = { kind: "devcontainer", name: projectName, sessionName: session };
		const { created } = await ensureSession(
			target,
			buildLaunchCommand(target, {
				resumeSessionId: msg.resumeSessionId,
				sessionToken: msg.sessionToken,
				pathPrefix: LAUNCH_PATH_PREFIX,
			}),
		);
		console.error(`[host-wake] ${msg.team} session ${created ? "started" : "already running"}`);

		// Zero captures means a dead launch.
		let lastScreen = "";
		let launchAlive = !created;
		let limit: LimitNotice | undefined;
		if (created) {
			const res = await awaitReady(target);
			lastScreen = res.screen;
			launchAlive = res.alive;
			limit = res.limit;
			if (res.ready) spawnReloadPlugins(target);
			greetFreshLaunch(target, { created, resumeSessionId: msg.resumeSessionId, ready: res.ready });
			if (limit)
				console.error(
					`[host-wake] ${msg.team} hit a usage limit: ${limit.headline ?? "no headline on screen"}`,
				);
			else console.error(`[host-wake] ${msg.team} ${res.ready ? "Claude is ready" : "did not reach the REPL"}`);
		} else {
			try {
				lastScreen = (await peekPane(target)).ansi;
			} catch {
				// A reattach is alive regardless.
			}
		}

		safeSend({
			type: "wake_result",
			team: msg.team,
			success: launchAlive,
			pluginsProvisioned,
			screen: lastScreen,
			...(limit ? { error: `session limit hit${limit.detail ? ` (${limit.detail})` : ""}` } : {}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: message });
	}
}

////////////////////////////////
//  Host op handler (console terminal view)

// The runner owns single-flight and the cadence floor.
const hostOpRunner = createHostOpRunner({
	// Internal callers use peekPane for its reject-on-absent.
	peekPane: peekWithFallback,
	sendText,
	sendKey,
	createSession: async (target, workdirHint, resumeSessionId, sessionToken) => {
		let workdir: string | undefined;
		if (target.kind === "host") {
			const resolved = resolveSpawnWorkdir(target.name, workdirHint);
			// Thrown rather than swallowed: the runner turns it into a failed op, and the console shows
			// the reason. A silent fallback here would start the session in the wrong tree.
			if ("error" in resolved) throw new Error(resolved.error);
			workdir = resolved.workdir;
		}
		const { created } = await ensureSession(
			target,
			buildLaunchCommand(target, { workdir, resumeSessionId, sessionToken, pathPrefix: LAUNCH_PATH_PREFIX }),
		);
		if (created) {
			const ready = await awaitReady(target);
			greetFreshLaunch(target, { created, resumeSessionId, ready: ready.ready });
			return { created, ready: ready.ready, alive: ready.alive };
		}
		return { created };
	},
	reloadPlugins: async (target) => {
		const pane = await peekPane(target);
		if (!isAgentReady(pane.ansi) || isAgentWorking(pane.ansi)) throw new Error("session is busy");
		spawnReloadPlugins(target);
		return { initiated: true };
	},
	killSession,
	// A windows session browses WINDOWS, through PowerShell. Browsing /mnt from this side would offer
	// Linux directories the launch then refuses, and would miss every network drive.
	listDirs: async (p, spawn) => (spawn === WINDOWS_SPAWN ? listWindowsDirs(p) : listHostDirs(p)),
});

////////////////////////////////
//  Presence derivation (board tile working/needsLogin/limitBlocked)

// resize=false and priority="derive": never disturb an actively-viewed terminal.
const presenceScheduler = new PresenceScheduler({
	peek: (target) => hostOpRunner.peek(target, { resize: false, priority: "derive" }),
	report: (team, value) => {
		if (value)
			safeSend({
				type: "presence_derive",
				team,
				working: value.working,
				needsLogin: value.needsLogin,
				limitBlocked: value.limitBlocked,
				...(value.limitDetail ? { limitDetail: value.limitDetail } : {}),
			});
		else safeSend({ type: "presence_derive", team });
	},
});

async function handleHostOp(reqId: string, op: HostOp): Promise<void> {
	try {
		const result = await hostOpRunner.run(op);
		safeSend({ type: "host_op_reply", reqId, ok: true, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Classified here: the stderr is freshest.
		const errorKind = op.kind === "peek" ? classifyPeekError(message) : undefined;
		safeSend({ type: "host_op_reply", reqId, ok: false, error: message, errorKind });
	}
}
