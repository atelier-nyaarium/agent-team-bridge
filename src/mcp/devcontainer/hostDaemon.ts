import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
	classifyPeekError,
	type HostOp,
	isReservedHostSession,
	isTmuxName,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { createReconnector } from "../../shared/reconnect.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
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

const HOME = os.homedir();

let ws: WebSocket | null = null;
let gatewayUrl = "ws://localhost:20000";
let projectDirs: string[] = [path.join(HOME, "projects")];
let channelPushHandler: ChannelPushHandler | null = null;
const reconnector = createReconnector(() => connect());
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
	// A host session's workdir hint (the record's label): the pane opens in ~/projects/<hint>. Absent
	// for a devcontainer wake (its workdir is fixed at /workspace/<project>).
	workdirHint?: string;
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

/** Working directory for a host session: the first `<projectDir>/<hint>` that is a real directory
 * (a plain dir, unlike findProjectPath it does not require a .devcontainer), else home. The hint is
 * the record's human label (never the opaque session id, which has no matching project dir), so a
 * session created as "myproject" opens in ~/projects/myproject. A missing hint, or one that is not a
 * single path segment (a `/` or `\`, or `.`/`..`), lands in home rather than escaping the project
 * roots - belt and suspenders over the store's label sanitization. dirs/home are injectable for
 * tests. */
export function resolveHostWorkdir(
	hint: string | undefined,
	dirs: string[] = projectDirs,
	home: string = HOME,
): string {
	if (!hint || hint === "." || hint === ".." || hint.includes("/") || hint.includes("\\")) return home;
	for (const dir of dirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(home, dir);
		const candidate = path.join(resolved, hint);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// missing or not a dir, try the next base
		}
	}
	return home;
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
		});
		console.error(`[host-wake] starting host session ${msg.team}`);
		try {
			const { created } = await ensureSession(target, launch);
			let res = await awaitReady(target);
			// The host launch tail `; exec bash` keeps the pane alive after claude exits, so a reattach
			// can land on a dead shell. awaitReady has now pressed through any startup menus and polled,
			// so a pane that neither reached the composer nor is working a turn is dead - relaunch it
			// with --resume. A fresh launch (created) is never a reattach, so never force-relaunched.
			if (!created && !res.ready && !isAgentWorking(res.screen)) {
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
			console.error(`[host-wake] ${msg.team} ${live ? "Claude is up" : "did not reach the REPL"}`);
			safeSend({ type: "wake_result", team: msg.team, success: live, screen: res.screen });
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
			buildLaunchCommand(target, { resumeSessionId: msg.resumeSessionId }),
		);
		console.error(`[host-wake] ${msg.team} session ${created ? "started" : "already running"}`);

		// For a fresh launch, poll the pane to clear the dev-channels + folder-trust menus (press "1")
		// until the REPL composer shows, and track whether it ever captured: a launch that exits
		// instantly takes its tmux session down with it, so zero captures means a dead launch ->
		// report a failed wake so /send fails fast. A slow-but-alive session captures at least once.
		let lastScreen = "";
		let launchAlive = !created;
		if (created) {
			const res = await awaitReady(target);
			lastScreen = res.screen;
			launchAlive = res.alive;
			console.error(`[host-wake] ${msg.team} ${res.ready ? "Claude is ready" : "did not reach the REPL"}`);
		} else {
			try {
				lastScreen = (await peekPane(target)).ansi;
			} catch {
				// reattach is alive regardless; the screen is best-effort
			}
		}

		// Send wake_result with a screen capture so the caller can assess; success reflects whether
		// the launched session is actually alive (dead-launch detection above).
		safeSend({ type: "wake_result", team: msg.team, success: launchAlive, pluginsProvisioned, screen: lastScreen });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: message });
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
// exits; a devcontainer session opens in its workspace project. The
// target's name/sessionName are slug-validated by callers; the resume id is uuid-shaped and the
// workdir is a resolved fs path, double-quoted for spaces (a workdir bearing a quote is dropped, see
// below).
export function buildLaunchCommand(
	target: TmuxTarget,
	opts: { resumeSessionId?: string; workdir?: string } = {},
): string {
	const composite = composeSessionName(target.name, target.sessionName);
	const resume =
		opts.resumeSessionId && /^[0-9a-fA-F-]{8,}$/.test(opts.resumeSessionId)
			? ` --resume ${opts.resumeSessionId}`
			: "";
	const claude = `claude --model opus --effort xhigh ${CLAUDE_FLAGS}${resume}`;
	if (target.kind === "host") {
		// The workdir is double-quoted for spaces. A single quote would close the outer `bash -c '...'`
		// and a double quote would close the cd's own quoting to run injected commands; a workdir with
		// either is dropped rather than escaped (the agent then starts in the daemon's cwd). The label
		// sanitizer forbids path separators but not quotes, so both are guarded here.
		const safeWorkdir = opts.workdir && !opts.workdir.includes("'") && !opts.workdir.includes('"');
		const cd = safeWorkdir ? `cd "${opts.workdir}"; ` : "";
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${cd}${claude}; exec bash'`;
	}
	return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; cd /workspace/${target.name}; exec ${claude}'`;
}

// The executor owns single-flight + the peek cadence floor; this module only relays the
// reply onto the host WS, correlated by reqId.
const hostOpRunner = createHostOpRunner({
	// The console-facing peek falls back to container logs while a pane does not exist yet; the raw
	// peekPane serves the internal wake/ready callers that need its reject-on-absent.
	peekPane: peekWithFallback,
	sendText,
	sendKey,
	createSession: async (target, workdirHint, resumeSessionId) => {
		// A create_session for an existing session reattaches instead of erroring on a duplicate
		// new-session. For a fresh launch, clear the dev-channels + folder-trust menus in the
		// BACKGROUND: the host op must return well under the gateway's 20s timeout, so we do not block
		// on the REPL becoming ready (a large/slow launch would blow that budget). resumeSessionId only
		// takes effect on that fresh-launch branch - a reattach ignores the whole launch command,
		// resume included.
		const workdir = target.kind === "host" ? resolveHostWorkdir(workdirHint) : undefined;
		const { created } = await ensureSession(target, buildLaunchCommand(target, { workdir, resumeSessionId }));
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
});

////////////////////////////////
//  Presence derivation (board tile working/needsLogin)

// The composite-parsing mirror of handleWake's own target resolution, without any container
// bring-up: a watched team is by construction already live (the gateway derives its watch list
// from the presence plane's own online/verifying rows), so a peek either finds the pane or fails
// "absent" - the scheduler's own failure-streak handling covers that, no wake needed here.
// Returns undefined for a malformed or reserved-session team, which the caller drops rather than
// watching.
export function resolveWatchTarget(team: string): TmuxTarget | undefined {
	const { project, session } = parseSessionName(team);
	if (!isTmuxName(project) || !isTmuxName(session)) return undefined;
	if (project === "host") {
		if (isReservedHostSession(session)) return undefined;
		return { kind: "host", name: "host", sessionName: session };
	}
	return { kind: "devcontainer", name: project, sessionName: session };
}

// Drives the intent-ramped board-tile derivation loop: peeks each watched session at its own
// resolved cadence through hostOpRunner's own single-flight/cadence-floor/slot-priority pipeline
// (resize=false - a background derivation peek must never resize the pane out from under an
// actively-viewed terminal; priority="derive" - it always yields slot admission to an interactive
// peek). A confirmed flip (or a derivation-impossible clear) is reported back to the gateway as a
// presence_derive frame.
const presenceScheduler = new PresenceScheduler({
	peek: (target) => hostOpRunner.peek(target, { resize: false, priority: "derive" }),
	report: (team, value) => {
		if (value) safeSend({ type: "presence_derive", team, working: value.working, needsLogin: value.needsLogin });
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
