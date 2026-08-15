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
	peekPane,
	peekWithFallback,
	sendKey,
	sendText,
} from "./tmuxCore.js";

////////////////////////////////
//  Interfaces & Types

export type ChannelPushHandler = (msg: Record<string, unknown>) => void;

////////////////////////////////
//  Functions & Helpers

let ws: WebSocket | null = null;
let gatewayUrl = "ws://localhost:20000";
let channelPushHandler: ChannelPushHandler | null = null;
const reconnector = createReconnector(() => connect());
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
		ws!.send(JSON.stringify({ type: "catalog", projects }));
		console.error(`[host-wake] sent catalog with ${projects.length} projects`);

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

async function handleWake(msg: WakeMessage): Promise<void> {
	// Both segments reach tmux and shell commands.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		console.error(`[host-wake] refusing wake of "${msg.team}": invalid project/session name`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: "invalid session name" });
		return;
	}
	// The daemon shares this tmux server.
	if (project === "host") {
		if (isReservedHostSession(session)) {
			console.error(`[host-wake] refusing wake of "${msg.team}": "${session}" is a reserved host session`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: "reserved host session" });
			return;
		}
		const target: TmuxTarget = { kind: "host", name: "host", sessionName: session };
		const launch = buildLaunchCommand(target, {
			resumeSessionId: msg.resumeSessionId,
			workdir: resolveHostWorkdir(msg.workdirHint),
			sessionToken: msg.sessionToken,
		});
		console.error(`[host-wake] starting host session ${msg.team}`);
		try {
			const { created } = await ensureSession(target, launch);
			let res = await awaitReady(target);
			// `exec bash` outlives claude, so a reattach can land on a dead shell. A limit dialog is
			// alive, not dead: relaunching would discard it and hit the same limit again.
			if (!created && !res.ready && !res.limit && !isAgentWorking(res.screen)) {
				// The frame could be a sub-second transition.
				const recheck = await peekPane(target)
					.then((p) => p.ansi)
					.catch(() => res.screen);
				const ready = isAgentReady(recheck);
				if (ready || isAgentWorking(recheck)) {
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
			buildLaunchCommand(target, { resumeSessionId: msg.resumeSessionId, sessionToken: msg.sessionToken }),
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
		const workdir = target.kind === "host" ? resolveHostWorkdir(workdirHint) : undefined;
		const { created } = await ensureSession(
			target,
			buildLaunchCommand(target, { workdir, resumeSessionId, sessionToken }),
		);
		// Backgrounded: the op must beat the gateway's 20s timeout.
		if (created) {
			void awaitReady(target)
				.then((res) => greetFreshLaunch(target, { created, resumeSessionId, ready: res.ready }))
				.catch(() => {
					// Self-heals on the next launch.
				});
		}
	},
	reloadPlugins: async (target) => {
		spawnReloadPlugins(target);
	},
	killSession,
	listDirs: async (p) => listHostDirs(p),
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
