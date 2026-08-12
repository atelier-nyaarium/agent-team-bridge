import crypto from "node:crypto";
import path from "node:path";
import WebSocket from "ws";
import type { LimitNotice } from "../../shared/agent-screen.js";
import { daemonCapabilityDeclaration } from "../../shared/capabilities.js";
import { CodexEventAckSchema } from "../../shared/codex-thinking.js";
import { CopilotEventAckSchema } from "../../shared/copilot-thinking.js";
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
import { ExecutionTargetManager } from "./codexTargets.js";
import { CopilotDaemonService } from "./copilotDaemonService.js";
import { CopilotTargetManager } from "./copilotTargets.js";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
import {
	buildLaunchCommand,
	findProjectPath,
	listHostDirs,
	resolveHostWorkdir,
	resolveWatchTarget,
	scanDevcontainerProjects,
	setProjectDirs,
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
// Minted once per daemon process, deliberately NOT per socket. A reconnect changes which connection
// carries an event, not which supervisor produced it, so a durable event fenced by this id stays
// valid across a reconnect that a socket-scoped epoch would have discarded.
const daemonInstanceId = crypto.randomUUID();
const codexTargets = new ExecutionTargetManager();
const codexDaemon = new CodexDaemonService({
	targets: codexTargets,
	daemonInstanceId,
	send: safeSend,
	resolveHostCwd: (hint) => resolveHostWorkdir(hint),
});
const copilotTargets = new CopilotTargetManager();
const copilotDaemon = new CopilotDaemonService({
	targets: copilotTargets,
	daemonInstanceId,
	send: safeSend,
	resolveHostCwd: (hint) => resolveHostWorkdir(hint),
});
// One wake at a time per team: a reconnect + retry (or a duplicate wake message) must not run a
// second handleWake against a session the first is still bringing up - the reattach branch could
// otherwise kill a session mid-startup.
const inflightWakes = new Map<string, Promise<void>>();

// A send on a socket mid-close throws; the daemon must never die because a reply could not be
// delivered. Swallow it - the caller retries on reconnect.
function safeSend(payload: Record<string, unknown>): void {
	try {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	} catch (err) {
		console.error("[host-daemon] ws send failed:", err instanceof Error ? err.message : err);
	}
}

/** Reap every supervised App Server. A child outliving its supervisor would hold a thread nothing
 * can reach or stop. */
export function stopSupervisedChildren(): void {
	codexDaemon.shutdown();
	codexTargets.shutdown();
	copilotDaemon.shutdown();
	copilotTargets.shutdown();
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
		// Present the host-daemon token. The gateway's host slot is fail-closed: it refuses
		// the register unless it has HOST_WS_TOKEN set AND this token matches it, so
		// start-gateway.sh and start-host-daemon.sh wire the same value from .env.
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

		// Which supervisor and which children are live, then everything the gateway never committed.
		// A reconnect changes the socket, not what the children have already produced.
		safeSend(codexDaemon.hello());
		codexDaemon.replay();
		safeSend(copilotDaemon.hello());
		copilotDaemon.replay();

		const projects = scanDevcontainerProjects();
		ws!.send(JSON.stringify({ type: "catalog", projects }));
		console.error(`[host-wake] sent catalog with ${projects.length} projects`);

		// A fresh connection (first boot, or a reconnect after a gap) resets every tracked team's
		// hysteresis and reports it unknown. Without this, a flip that settled to a NEW confirmed
		// value during a disconnect gap (the WS down, but the daemon's own timers kept ticking
		// against a still-live tmux) would never be reported at all: observe() only fires on a
		// TRANSITION away from the already-confirmed value, so a tracker sitting on a stale
		// confirmation would just keep re-confirming it forever post-reconnect. Watches themselves
		// are not dropped - no fresh presence_watch push is required for peeking to resume.
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

		if (msg.type === "codex_command") {
			codexDaemon.handleCommand(msg);
		}

		if (msg.type === "codex_ack") {
			const ack = CodexEventAckSchema.safeParse(msg);
			if (ack.success) codexDaemon.acknowledge(ack.data);
		}

		if (msg.type === "copilot_command") {
			copilotDaemon.handleCommand(msg);
		}

		if (msg.type === "copilot_ack") {
			const ack = CopilotEventAckSchema.safeParse(msg);
			if (ack.success) copilotDaemon.acknowledge(ack.data);
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
	// The composite `project.session` to wake; the daemon parses it into the project (container/dir)
	// and the tmux session name.
	team: string;
	projectPath?: string;
	// The Claude harness id to `--resume`, if the gateway has one mapped for this session.
	resumeSessionId?: string;
	// A host session's workdir hint (the record's label): the pane opens in ~/projects/<hint>. Absent
	// for a devcontainer wake (its workdir is fixed at /workspace/<project>).
	workdirHint?: string;
	// The record's binding secret, exported into the launched session so its register can prove which
	// record it is. Absent for a wake with no record (or a record predating the field).
	sessionToken?: string;
}

async function handleWake(msg: WakeMessage): Promise<void> {
	// The composite carries (project, session); a bare name defaults the session to "claude". Both
	// segments are interpolated into tmux/shell commands, so reject a non-slug before launching.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		console.error(`[host-wake] refusing wake of "${msg.team}": invalid project/session name`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: "invalid session name" });
		return;
	}
	// A host session launches on the bare host tmux with no container bring-up. The daemon's own
	// supervisor session shares that server, so a reserved name would relaunch over (or kill) it.
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
			// The host launch tail `; exec bash` keeps the pane alive after claude exits, so a reattach
			// can land on a dead shell. awaitReady has now pressed through any startup menus and polled,
			// so a pane that neither reached the composer nor is working a turn is dead - relaunch it
			// with --resume. A fresh launch (created) is never a reattach, so never force-relaunched.
			// A limit-blocked pane is alive and holding an unanswered dialog, not a dead shell, so it must
			// not be killed: relaunching would discard the dialog and hit the same limit on the next turn.
			if (!created && !res.ready && !res.limit && !isAgentWorking(res.screen)) {
				// Re-capture before the destructive kill: the awaitReady frame could be a sub-second
				// composer/spinner transition on a still-live session.
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
			const live = res.ready || isAgentWorking(res.screen);
			if (res.limit) {
				console.error(`[host-wake] ${msg.team} hit a usage limit: ${res.limit.headline}`);
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

		// Reattach if the session is already alive, else launch it (with --resume baked into the
		// command when an id is mapped). The container is up, so the tmux ops go through tmuxCore's
		// docker exec (the proven terminal-op path).
		const target: TmuxTarget = { kind: "devcontainer", name: projectName, sessionName: session };
		const { created } = await ensureSession(
			target,
			buildLaunchCommand(target, { resumeSessionId: msg.resumeSessionId, sessionToken: msg.sessionToken }),
		);
		console.error(`[host-wake] ${msg.team} session ${created ? "started" : "already running"}`);

		// For a fresh launch, poll the pane to clear the dev-channels + folder-trust menus (press "1")
		// until the REPL composer shows, and track whether it ever captured: a launch that exits
		// instantly takes its tmux session down with it, so zero captures means a dead launch ->
		// report a failed wake so /send fails fast. A slow-but-alive session captures at least once.
		let lastScreen = "";
		let launchAlive = !created;
		let limit: LimitNotice | undefined;
		if (created) {
			const res = await awaitReady(target);
			lastScreen = res.screen;
			launchAlive = res.alive;
			limit = res.limit;
			if (limit) console.error(`[host-wake] ${msg.team} hit a usage limit: ${limit.headline}`);
			else console.error(`[host-wake] ${msg.team} ${res.ready ? "Claude is ready" : "did not reach the REPL"}`);
		} else {
			try {
				lastScreen = (await peekPane(target)).ansi;
			} catch {
				// reattach is alive regardless; the screen is best-effort
			}
		}

		// Send wake_result with a screen capture so the caller can assess; success reflects whether
		// the launched session is actually alive (dead-launch detection above).
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

// The executor owns single-flight + the peek cadence floor; this module only relays the
// reply onto the host WS, correlated by reqId.
const hostOpRunner = createHostOpRunner({
	// The console-facing peek falls back to container logs while a pane does not exist yet; the raw
	// peekPane serves the internal wake/ready callers that need its reject-on-absent.
	peekPane: peekWithFallback,
	sendText,
	sendKey,
	createSession: async (target, workdirHint, resumeSessionId, sessionToken) => {
		// A create_session for an existing session reattaches instead of erroring on a duplicate
		// new-session. For a fresh launch, clear the dev-channels + folder-trust menus in the
		// BACKGROUND: the host op must return well under the gateway's 20s timeout, so we do not block
		// on the REPL becoming ready (a large/slow launch would blow that budget). resumeSessionId only
		// takes effect on that fresh-launch branch - a reattach ignores the whole launch command,
		// resume included.
		const workdir = target.kind === "host" ? resolveHostWorkdir(workdirHint) : undefined;
		const { created } = await ensureSession(
			target,
			buildLaunchCommand(target, { workdir, resumeSessionId, sessionToken }),
		);
		if (created) {
			void awaitReady(target).catch(() => {
				// best-effort menu-clearing; a failure self-heals on the next launch
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

// Drives the intent-ramped board-tile derivation loop: peeks each watched session at its own
// resolved cadence through hostOpRunner's own single-flight/cadence-floor/slot-priority pipeline
// (resize=false - a background derivation peek must never resize the pane out from under an
// actively-viewed terminal; priority="derive" - it always yields slot admission to an interactive
// peek). A confirmed flip (or a derivation-impossible clear) is reported back to the gateway as a
// presence_derive frame.
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
		// Classify a peek failure at the source (the stderr is freshest here) so the gateway/console
		// read a kind instead of re-matching tmux/docker wording.
		const errorKind = op.kind === "peek" ? classifyPeekError(message) : undefined;
		safeSend({ type: "host_op_reply", reqId, ok: false, error: message, errorKind });
	}
}
