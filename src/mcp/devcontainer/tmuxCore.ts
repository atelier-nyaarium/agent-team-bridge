import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
	ALLOWED_KEYS,
	assertTmuxName,
	classifyPeekError,
	type HostPeekResult,
	isReservedHostSession,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { DEFAULT_SESSION } from "../../shared/session-id.js";

////////////////////////////////
//  Constants

// A devcontainer's container name follows the compose convention.
const containerName = (team: string): string => `${team}_devcontainer-dev-1`;
// A name reaching docker exec must be a slug. The name is also passed as an argv
// element (never interpolated into a shell), so this is defense in depth against a
// crafted target, and rejects a bogus name early.
const EXEC_TIMEOUT_MS = 8_000;
// Hard cap on a captured pane so one peek can never return an unbounded payload over
// the sealed reply path. Excess bytes are dropped (the visible pane is far smaller).
const MAX_CAPTURE_BYTES = 256_000;

// The detached agent session is sized to fit the phone's terminal view before each capture. A
// detached session keeps the resize-window size (no attached client overrides it), and a same-size
// resize is a no-op redraw, so the cost is one cheap spawn per peek.
const TMUX_COLS = 58;
const TMUX_ROWS = 40;

// Startup readiness polling. A large resumed history can take a while to render, so the budget is
// generous; the gateway-side wake wait runs until the woken container registers (bounded well above
// this budget), so this readiness poll never races it.
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;
// A live session (even a slow one) captures its booting/menu screen within a poll or two; a dead
// launch (bad bashrc, claude off PATH) takes its tmux session down and never captures. Bail after
// this many consecutive no-capture polls so a dead launch fails fast instead of stalling the budget.
const DEAD_LAUNCH_PROBES = 8;

// The ready composer prompt "❯" anchored at column 0. The dev-channels / folder-trust /
// resume-picker menus show an INDENTED cursor ("  ❯ 1."), so the line-start anchor matches the real
// composer and never a menu line.
const COMPOSER_RE = /^❯/mu;
// The settled spinner frame "✻". A turn is still running while its status line also shows the
// ellipsis "…" or "Waiting for"; once it shows neither, the turn is done.
const SNOWFLAKE = "✻";
const ELLIPSIS_RE = /…|\.{3}/u;
const WAITING_RE = /Waiting for/;
// The launch menus cleared by pressing "1" (which selects and confirms the highlighted option):
// dev-channels, folder-trust, and the fullscreen-renderer offer. They can appear in any order and
// not all on every launch, so the loop re-checks each poll rather than assuming a fixed sequence.
const STARTUP_PROMPT_RE =
	/I am using this for local development|Is this a project you created|trust this folder|Try the new fullscreen renderer/;
// The auth status renders in the bottom toolbar, below the composer's lower rule line (three U+2500
// dashes). Scoping the logged-out check to the region after the last rule keeps "/login" typed into
// the composer, or printed in the transcript above, from tripping it.
const TOOLBAR_RULE = "───";
const LOGGED_OUT_RE = /Not logged in|Run \/login/;

////////////////////////////////
//  Functions & Helpers

/** The target for the local agent's OWN tmux session: bare `tmux` (kind "host" = local, not docker
 * exec), the conventional `DEFAULT_SESSION` pane. The single source for an in-process tool that
 * drives its own session (set_effort_level, compact_session), so the session name is anchored to one
 * constant rather than re-hardcoded per tool. */
export function selfSessionTarget(): TmuxTarget {
	return { kind: "host", name: "host", sessionName: DEFAULT_SESSION };
}

/** The pane a host op addresses: the agent runs in pane 0 of its session, so the pane index is
 * fixed and only the session name varies (`<sessionName>.0`). The session name is an argv element
 * (never shell-interpolated) and slug-validated as defense in depth. */
function paneTarget(target: TmuxTarget): string {
	assertTmuxName(target.sessionName);
	return `${target.sessionName}.0`;
}

/** Build the argv for a tmux subcommand against a target: the host's own tmux for a host
 * session, or `docker exec` into the devcontainer. The name is an argv element, never
 * shell-interpolated, so it cannot be parsed as a shell token. */
function tmuxArgv(target: TmuxTarget, sub: string[]): string[] {
	if (target.kind === "host") return ["tmux", ...sub];
	assertTmuxName(target.name);
	return ["docker", "exec", "-u", "vscode", containerName(target.name), "tmux", ...sub];
}

/** Spawn argv (no shell) and resolve stdout. Rejects on a non-zero exit (a missing
 * container/pane surfaces as the stderr message) or a timeout. */
function run(argv: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		// Accumulate raw bytes and decode ONCE at close: a TUI pane is full of multi-byte
		// box-drawing chars, and a per-chunk toString would emit U+FFFD where a character
		// straddles a chunk boundary (likely once a scrollback capture passes the pipe size).
		const chunks: Buffer[] = [];
		let bytes = 0;
		const errChunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("tmux command timed out"));
		}, timeoutMs);
		child.stdout.on("data", (d: Buffer) => {
			// Keep up to the cap (a redrawing TUI pane is well under it); still drain the rest
			// so the child cannot block on a full pipe.
			if (bytes < MAX_CAPTURE_BYTES) {
				chunks.push(d);
				bytes += d.length;
			}
		});
		child.stderr.on("data", (d: Buffer) => {
			errChunks.push(d);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(chunks).subarray(0, MAX_CAPTURE_BYTES).toString("utf-8"));
			else reject(new Error(Buffer.concat(errChunks).toString("utf-8").trim() || `tmux command exited ${code}`));
		});
	});
}

// Serialize tmux writes per target so a text+Enter pair is never interleaved with
// another send to the same pane (which would submit a half-built line).
const sendChains = new Map<string, Promise<unknown>>();
const targetKey = (t: TmuxTarget): string => `${t.kind}:${t.name}:${t.sessionName}`;

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = sendChains.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	// The chain swallows failures so one rejected send does not poison the next.
	sendChains.set(
		key,
		next.catch(() => {}),
	);
	return next;
}

/** Capture the VISIBLE pane with ANSI colors (a live snapshot, not scrollback). */
export async function peekPane(target: TmuxTarget): Promise<HostPeekResult> {
	const pane = paneTarget(target);
	// Best-effort resize before the capture so the view fits the phone. Separate run() with a
	// swallowed failure: an old tmux without resize-window, or a transient error, must not fail the
	// capture itself.
	await run(
		tmuxArgv(target, ["resize-window", "-t", target.sessionName, "-x", String(TMUX_COLS), "-y", String(TMUX_ROWS)]),
	).catch(() => {});
	const ansi = await run(tmuxArgv(target, ["capture-pane", "-t", pane, "-e", "-p"]));
	const hash = crypto.createHash("sha256").update(ansi).digest("hex").slice(0, 16);
	return { ansi, hash };
}

/** Type a literal line and submit it, atomically in ONE send-keys: the trailing CR is the
 * Enter key, so the text and its submission can never be torn apart by a failure between two
 * commands. The `--` ends option parsing so text starting with a dash is typed literally (and
 * it would swallow a `;` command separator, which is why the CR rides inside the literal). */
export function sendText(target: TmuxTarget, text: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", `${text}\r`]));
	});
}

/** Send a single named control key (no literal text, no trailing Enter). Rejects (does
 * not spawn) when the key is not on the whitelist. */
export function sendKey(target: TmuxTarget, key: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		if (!ALLOWED_KEYS.has(key)) throw new Error(`disallowed key "${key}"`);
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), key]));
	});
}

/** Start a new detached tmux session named `target.sessionName` running `command`. `new-session`
 * addresses the session by NAME (not the `.0` pane), so this validates `sessionName` directly. The
 * command is the shell-command tmux runs in the session; the daemon builds it (model/effort/plugin)
 * and it is never console-supplied, so an arbitrary host command cannot be injected here. */
export async function createSession(target: TmuxTarget, command: string): Promise<void> {
	assertTmuxName(target.sessionName);
	assertNotReservedHostSink(target);
	await run(tmuxArgv(target, ["new-session", "-d", "-s", target.sessionName, command]), 15_000);
}

/** The mutating sinks' last line of defense: never create, kill, or inject a keystroke into a
 * reserved host session (the daemon's own supervisor pane). The console boundary and the wake
 * handler guard this upstream, but the sinks own the invariant so a future caller cannot bypass it.
 * Host-scoped: the reserved set names host sessions only, so a devcontainer target is never reserved. */
function assertNotReservedHostSink(target: TmuxTarget): void {
	if (target.kind === "host" && isReservedHostSession(target.sessionName)) {
		throw new Error(`refusing to operate reserved host session "${target.sessionName}"`);
	}
}

/** Tear down a tmux session. Idempotent: killing a session that is already gone (tmux exits
 * non-zero with "can't find session") is treated as success, since the end state is identical. */
export async function killSession(target: TmuxTarget): Promise<void> {
	assertTmuxName(target.sessionName);
	assertNotReservedHostSink(target);
	try {
		await run(tmuxArgv(target, ["kill-session", "-t", target.sessionName]));
	} catch (err) {
		// A session that is already gone (no tmux server, no such session, dead container) is the
		// desired end state, so it counts as success. A timeout or unknown exit leaves the kill
		// UNCONFIRMED: rethrow so the caller does not drop the resume record over a still-live tmux.
		if (classifyPeekError(err instanceof Error ? err.message : String(err)) !== "absent") throw err;
	}
	// The session is gone (a rethrow above skips this): drop its serialize chain so the map cannot
	// grow by every session that ever received a keystroke.
	sendChains.delete(targetKey(target));
}

/** Whether `target.sessionName` exists. `has-session` exits non-zero when it does not, so a
 * non-zero exit is "absent", not a failure. Lets a caller reattach rather than re-launch. */
export async function hasSession(target: TmuxTarget): Promise<boolean> {
	assertTmuxName(target.sessionName);
	try {
		await run(tmuxArgv(target, ["has-session", "-t", target.sessionName]));
		return true;
	} catch {
		return false;
	}
}

// capture-pane runs with -e, so the screen carries SGR color escapes. Strip them before matching: an
// escape at the start of a line defeats the composer's ^ anchor, and one splitting a phrase defeats a
// substring check. The Kotlin twin strips the same in AgentScreen.kt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the literal ESC of an ANSI CSI sequence
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(screen: string): string {
	return screen.replace(ANSI_CSI_RE, "");
}

/** Whether a captured pane shows claude at the idle REPL composer, i.e. startup finished (menus
 * cleared, history rendered). The composer prompt sits at column 0; the dev-channels / folder-trust /
 * resume-picker menus show an indented cursor, so the line-start anchor never matches a menu. Both a
 * fresh launch and a resumed session settle here. Used once per wake or fresh spawn to know the
 * session is up; the working/done state (isAgentWorking) takes over after the first message. The
 * Kotlin twin lives in AgentScreen.kt. */
export function isAgentReady(screen: string): boolean {
	return COMPOSER_RE.test(stripAnsi(screen));
}

/** Whether a captured pane shows claude actively working a turn. The status line is the last line
 * carrying the settled spinner; the turn is running while that line shows the ellipsis or "Waiting
 * for". A pane with no spinner line is idle (a fresh REPL) or done, not working - so the chip can
 * poll this across all listed sessions without lighting a freshly-spawned idle one. Meaningful after
 * a message has been sent (the Kotlin twin lives in AgentScreen.kt). */
export function isAgentWorking(screen: string): boolean {
	const status = stripAnsi(screen)
		.split("\n")
		.findLast((line) => line.includes(SNOWFLAKE));
	if (status === undefined) return false;
	return ELLIPSIS_RE.test(status) || WAITING_RE.test(status);
}

/** Whether the captured pane shows claude logged out: its bottom toolbar prints "Not logged in" /
 * "Run /login". Independent of ready/working - a logged-out session still renders the composer, so a
 * caller must check this separately. Detectable at any peek (the footer persists), including a token
 * that expires mid-session. The Kotlin twin lives in AgentScreen.kt. */
export function isLoggedOut(screen: string): boolean {
	const lines = stripAnsi(screen).split("\n");
	const lastRule = lines.findLastIndex((line) => line.includes(TOOLBAR_RULE));
	const footer = lines.slice(lastRule + 1).join("\n");
	return LOGGED_OUT_RE.test(footer);
}

/** Press the literal "1" key: it selects AND confirms the highlighted option on the launch menus
 * (no trailing Enter). The daemon presses it itself to clear the dev-channels and folder-trust
 * prompts, so it does not pass through the console keystroke whitelist. */
function pressOne(target: TmuxTarget): Promise<void> {
	return serialized(targetKey(target), async () => {
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", "1"]));
	});
}

/** Poll the pane until the REPL composer appears, pressing "1" through the dev-channels and
 * folder-trust menus as they show. Returns whether the launch is alive: a launch that exits
 * instantly takes its tmux session down with it, so a pane that never captures is a dead launch. */
export async function awaitReady(
	target: TmuxTarget,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ alive: boolean; ready: boolean; screen: string }> {
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
			// A dead pane cannot be captured. If it has NEVER captured, bail early as a dead launch
			// rather than waiting out the full (resume-sized) budget. Once it has captured at least
			// once it is alive, so a later transient peek failure does not trip the dead-launch out.
			if (!captureOk && ++missedProbes >= DEAD_LAUNCH_PROBES) return { alive: false, ready: false, screen };
			continue;
		}
		// capture-pane -e carries SGR escapes that precede the composer and split a prompt phrase, so
		// match against the stripped text (isAgentReady strips internally; the prompt check must too).
		const clean = stripAnsi(screen);
		if (isAgentReady(clean)) return { alive: true, ready: true, screen };
		if (STARTUP_PROMPT_RE.test(clean)) {
			try {
				await pressOne(target);
			} catch {
				// a transient send failure self-heals on the next poll
			}
		}
	}
	return { alive: captureOk, ready: isAgentReady(screen), screen };
}

/** Reattach to `target.sessionName` if it is already alive, else launch a fresh agent. Returns
 * whether a new session was created, so a create_session op reattaches instead of double-launching
 * (a duplicate `new-session` on an existing name errors). */
export async function ensureSession(target: TmuxTarget, command: string): Promise<{ created: boolean }> {
	if (await hasSession(target)) return { created: false };
	try {
		await createSession(target, command);
		return { created: true };
	} catch (err) {
		// A racing create, or a transient has-session miss above, can leave the session already
		// present; tmux then rejects new-session as a duplicate. Re-check: if it now exists, that is
		// the desired end state (reattach), else surface the real failure.
		if (await hasSession(target)) return { created: false };
		throw err;
	}
}
