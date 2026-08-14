import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { isAgentReady, type LimitNotice, limitNotice, stripAnsi } from "../../shared/agent-screen.js";
import {
	ALLOWED_KEYS,
	assertTmuxName,
	classifyPeekError,
	type HostPeekResult,
	isReservedHostSession,
	type TmuxPeek,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { parseSessionName } from "../../shared/session-id.js";

// Re-exported so the daemon and tests keep this import path.
export { isAgentReady, isAgentWorking, isLoggedOut, limitNotice } from "../../shared/agent-screen.js";

////////////////////////////////
//  Constants

const containerName = (team: string): string => `${team}_devcontainer-dev-1`;
const EXEC_TIMEOUT_MS = 8_000;
// Bounds one sealed reply.
const MAX_CAPTURE_BYTES = 256_000;
const CONTAINER_LOGS_TAIL = 200;
const CONTAINER_LOGS_TIMEOUT_MS = 5_000;

// Fits the phone's view.
const TMUX_COLS = 53;
const TMUX_ROWS = 38;

// A resumed history renders slowly.
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;
// A dead launch never captures.
const DEAD_LAUNCH_PROBES = 8;

// Answered with "1".
const STARTUP_PROMPT_RE =
	/I am using this for local development|Is this a project you created|trust this folder|Try the new fullscreen renderer/;

// Answered with "2": full session, not summary. An unattended wake must not drop context.
const RESUME_PROMPT_RE = /Resuming the full session will consume/;

////////////////////////////////
//  Functions & Helpers

/** The target for this process's own tmux session. */
export function selfSessionTarget(): TmuxTarget {
	return { kind: "host", name: "host", sessionName: parseSessionName(process.env.PROJECT_NAME ?? "").session };
}

// Bare -t matches by prefix, so "story" lands on "story-2".
const exactSession = (name: string): string => `=${name}`;

/** The agent runs in pane 0. */
function paneTarget(target: TmuxTarget): string {
	assertTmuxName(target.sessionName);
	return `${exactSession(target.sessionName)}.0`;
}

/** The host's own tmux, or docker exec into the devcontainer. */
function tmuxArgv(target: TmuxTarget, sub: string[]): string[] {
	if (target.kind === "host") return ["tmux", ...sub];
	assertTmuxName(target.name);
	return ["docker", "exec", "-u", "vscode", containerName(target.name), "tmux", ...sub];
}

/** Spawn argv (no shell) and resolve stdout. */
function run(argv: string[], timeoutMs = EXEC_TIMEOUT_MS, opts: { mergeStderr?: boolean } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		// Decode once: a chunk boundary splits multi-byte chars.
		const chunks: Buffer[] = [];
		let bytes = 0;
		const errChunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("tmux command timed out"));
		}, timeoutMs);
		child.stdout.on("data", (d: Buffer) => {
			// Still drain past the cap.
			if (bytes < MAX_CAPTURE_BYTES) {
				chunks.push(d);
				bytes += d.length;
			}
		});
		let errBytes = 0;
		child.stderr.on("data", (d: Buffer) => {
			// Own buffer: the streams schedule independently.
			if (errBytes < MAX_CAPTURE_BYTES) {
				errChunks.push(d);
				errBytes += d.length;
			}
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(Buffer.concat(errChunks).toString("utf-8").trim() || `command exited ${code}`));
				return;
			}
			const out = Buffer.concat(chunks).subarray(0, MAX_CAPTURE_BYTES).toString("utf-8");
			if (!opts.mergeStderr) {
				resolve(out);
				return;
			}
			const err = Buffer.concat(errChunks).subarray(0, MAX_CAPTURE_BYTES).toString("utf-8");
			resolve(err ? `${out}${err}` : out);
		});
	});
}

// Keeps text and Enter atomic.
const sendChains = new Map<string, Promise<unknown>>();
const targetKey = (t: TmuxTarget): string => `${t.kind}:${t.name}:${t.sessionName}`;

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = sendChains.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	// One rejection must not poison the chain.
	sendChains.set(
		key,
		next.catch(() => {}),
	);
	return next;
}

/** Capture the visible pane with ANSI colors. Derive-only callers pass `resize: false` so they do
 * not fight the terminal view's geometry. */
export async function peekPane(target: TmuxTarget, resize = true): Promise<TmuxPeek> {
	const pane = paneTarget(target);
	if (resize) {
		// Best effort: an old tmux lacks resize-window.
		await run(
			tmuxArgv(target, [
				"resize-window",
				"-t",
				exactSession(target.sessionName),
				"-x",
				String(TMUX_COLS),
				"-y",
				String(TMUX_ROWS),
			]),
		).catch(() => {});
	}
	// -J rejoins wrapped rows, so a long URL copies as one string.
	const ansi = await run(tmuxArgv(target, ["capture-pane", "-t", pane, "-e", "-J", "-p"]));
	const hash = crypto.createHash("sha256").update(ansi).digest("hex").slice(0, 16);
	return { ansi, hash };
}

/** A bounded `docker logs` tail, shown while a pane does not exist yet. */
async function captureContainerLogs(target: TmuxTarget): Promise<{ text: string; hash: string }> {
	if (target.kind === "host") throw new Error("no such container");
	assertTmuxName(target.name);
	const text = await run(
		["docker", "logs", "--tail", String(CONTAINER_LOGS_TAIL), containerName(target.name)],
		CONTAINER_LOGS_TIMEOUT_MS,
		{ mergeStderr: true },
	);
	const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
	return { text, hash };
}

/** The console-facing peek: the live pane, else container logs while it boots. Callers needing
 * reject-on-absent to detect a dead launch use `peekPane`. */
export async function peekWithFallback(target: TmuxTarget, resize = true): Promise<HostPeekResult> {
	try {
		const { ansi, hash } = await peekPane(target, resize);
		return { kind: "tmux", ansi, hash };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (classifyPeekError(message) !== "absent") throw err;
		try {
			const { text, hash } = await captureContainerLogs(target);
			return { kind: "container-logs", text, hash };
		} catch {
			// Rethrow the original: keeps the absent classification.
			throw err;
		}
	}
}

/** Callers hold the lock; nesting would deadlock. */
function sendKeyRaw(target: TmuxTarget, key: string): Promise<string> {
	return run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), key]));
}

/** Type a literal line into the pane. With `submit`, Enter follows as its OWN send-keys call: paste
 * detection reads an embedded CR as text, not as a submit. `--` keeps a leading dash literal. */
export function sendText(target: TmuxTarget, text: string, submit = true): Promise<void> {
	return serialized(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", text]));
		if (submit) await sendKeyRaw(target, "Enter");
	});
}

/** Send a whitelisted control key. */
export function sendKey(target: TmuxTarget, key: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		if (!ALLOWED_KEYS.has(key)) throw new Error(`disallowed key "${key}"`);
		await sendKeyRaw(target, key);
	});
}

/** Start a detached tmux session. `command` is daemon-built, never console-supplied. */
export async function createSession(target: TmuxTarget, command: string): Promise<void> {
	assertTmuxName(target.sessionName);
	assertNotReservedHostSink(target);
	await run(tmuxArgv(target, ["new-session", "-d", "-s", target.sessionName, command]), 15_000);
}

/** The mutating sinks' last line of defense. Host-scoped: no devcontainer target is reserved. */
function assertNotReservedHostSink(target: TmuxTarget): void {
	if (target.kind === "host" && isReservedHostSession(target.sessionName)) {
		throw new Error(`refusing to operate reserved host session "${target.sessionName}"`);
	}
}

/** Tear down a tmux session. */
export async function killSession(target: TmuxTarget): Promise<void> {
	assertTmuxName(target.sessionName);
	assertNotReservedHostSink(target);
	try {
		await run(tmuxArgv(target, ["kill-session", "-t", exactSession(target.sessionName)]));
	} catch (err) {
		// Already gone is success. An unconfirmed kill is not, so it rethrows.
		if (classifyPeekError(err instanceof Error ? err.message : String(err)) !== "absent") throw err;
	}
	sendChains.delete(targetKey(target));
}

/** Whether `target.sessionName` exists. */
export async function hasSession(target: TmuxTarget): Promise<boolean> {
	assertTmuxName(target.sessionName);
	try {
		await run(tmuxArgv(target, ["has-session", "-t", exactSession(target.sessionName)]));
		return true;
	} catch {
		return false;
	}
}

/** A digit selects and confirms, with no Enter. Daemon-pressed, so it skips the key whitelist. */
function pressDigit(target: TmuxTarget, digit: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", digit]));
	});
}

/** Poll until the composer appears, pressing through the startup and resume menus. */
export async function awaitReady(
	target: TmuxTarget,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ alive: boolean; ready: boolean; screen: string; limit?: LimitNotice }> {
	const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? READY_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	let captureOk = false;
	let missedProbes = 0;
	let screen = "";
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pollMs));
		try {
			screen = (await peekPane(target)).ansi;
			captureOk = true;
		} catch {
			// Never captured means a dead launch.
			if (!captureOk && ++missedProbes >= DEAD_LAUNCH_PROBES) return { alive: false, ready: false, screen };
			continue;
		}
		// SGR escapes split a prompt phrase.
		const clean = stripAnsi(screen);
		// A prompt outranks a stale composer sharing its frame.
		if (STARTUP_PROMPT_RE.test(clean)) {
			try {
				await pressDigit(target, "1");
			} catch {
				// Self-heals next poll.
			}
			continue;
		}
		if (RESUME_PROMPT_RE.test(clean)) {
			try {
				await pressDigit(target, "2");
			} catch {
				// Self-heals next poll.
			}
			continue;
		}
		// Answers nothing: one choice buys usage credits.
		const limit = limitNotice(clean);
		if (limit) return { alive: true, ready: false, screen, limit };
		if (isAgentReady(clean)) return { alive: true, ready: true, screen };
	}
	const finalClean = stripAnsi(screen);
	const prompted = STARTUP_PROMPT_RE.test(finalClean) || RESUME_PROMPT_RE.test(finalClean);
	return { alive: captureOk, ready: !prompted && isAgentReady(finalClean), screen };
}

/** Reattach if alive, else launch. A duplicate `new-session` errors, hence the recheck. */
export async function ensureSession(target: TmuxTarget, command: string): Promise<{ created: boolean }> {
	if (await hasSession(target)) return { created: false };
	try {
		await createSession(target, command);
		return { created: true };
	} catch (err) {
		if (await hasSession(target)) return { created: false };
		throw err;
	}
}
