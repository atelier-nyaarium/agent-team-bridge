import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { isAgentReady, stripAnsi } from "../../shared/agent-screen.js";
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

// The pane-screen classifiers live in shared/agent-screen.ts (the gateway's vibe-check idle gate needs them too);
// re-exported here so the daemon and existing tests can use this import path.
export { isAgentReady, isAgentWorking, isAtPrompt, isLoggedOut } from "../../shared/agent-screen.js";

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
// The container-logs fallback (shown while a session's tmux pane does not exist yet) tails this
// many recent lines with its own SHORTER timeout: `docker logs` on a chatty container is a more
// variable cost than a tmux capture-pane, and must not hold a peek-concurrency slot as long as a
// tmux exec can.
const CONTAINER_LOGS_TAIL = 200;
const CONTAINER_LOGS_TIMEOUT_MS = 5_000;

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

// The launch menus cleared by pressing "1" (which selects and confirms the highlighted option):
// dev-channels, folder-trust, and the fullscreen-renderer offer. They can appear in any order and
// not all on every launch, so the loop re-checks each poll rather than assuming a fixed sequence.
const STARTUP_PROMPT_RE =
	/I am using this for local development|Is this a project you created|trust this folder|Try the new fullscreen renderer/;

// The large-resumed-session picker (Resume from summary / Resume full session as-is / Don't ask me
// again), shown instead of the ordinary startup menus when `claude --resume` lands on an old,
// token-heavy transcript. A daemon-driven wake has no human present to weigh the token-cost
// tradeoff, and a silent summary-resume would drop context an unattended session (mid task, holding
// state only in its own transcript) was relying on - so this one is answered "2" (full session),
// not the highlighted "1" (summary) the other menus confirm.
const RESUME_PROMPT_RE = /Resuming the full session will consume/;

////////////////////////////////
//  Functions & Helpers

/** The target for the local agent's OWN tmux session: bare `tmux` (kind "host" = this process's own
 * tmux, not a docker exec into another container - true whether the agent itself runs on the host or
 * inside a container). The session name is the session segment of PROJECT_NAME (the composite the
 * daemon launched under), so a session running under a minted id drives its own pane rather than the
 * conventional `claude` one; a bare or unset PROJECT_NAME parses to DEFAULT_SESSION. The single
 * source for every in-process tool that drives its own session (set_effort_level, compact_session,
 * the self path of reload_plugins), so the session name is derived in one place rather than
 * re-hardcoded per tool. */
export function selfSessionTarget(): TmuxTarget {
	return { kind: "host", name: "host", sessionName: parseSessionName(process.env.PROJECT_NAME ?? "").session };
}

// tmux matches a target session by PREFIX by default, so `-t story` would land on a sibling
// `story-2` when `story` itself is gone. Every session LOOKUP (not new-session, which assigns the
// name) uses the `=` exact-match prefix so an op can never hit the wrong session in a shared
// container. See tmux(1) target-session.
const exactSession = (name: string): string => `=${name}`;

/** The pane a host op addresses: the agent runs in pane 0 of its session, so the pane index is
 * fixed and only the session name varies (`=<sessionName>.0`, exact-match). The session name is an
 * argv element (never shell-interpolated) and slug-validated as defense in depth. */
function paneTarget(target: TmuxTarget): string {
	assertTmuxName(target.sessionName);
	return `${exactSession(target.sessionName)}.0`;
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
function run(argv: string[], timeoutMs = EXEC_TIMEOUT_MS, opts: { mergeStderr?: boolean } = {}): Promise<string> {
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
		let errBytes = 0;
		child.stderr.on("data", (d: Buffer) => {
			// Keep stderr in its OWN buffer (bounded like stdout) and decode it once at close: folding
			// raw stderr chunks into the stdout buffer could split a multi-byte character across the
			// two independently-scheduled streams. docker logs sends a container's stderr here on a
			// clean run, so mergeStderr appends the decoded stderr to the decoded stdout at close.
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

/** Capture the VISIBLE pane with ANSI colors (a live snapshot, not scrollback). Returns the raw
 * tmux shape; the container-logs fallback is layered on by `peekWithFallback`. `resize` defaults
 * true (fit the phone's terminal view before capturing); the presence scheduler's derive-only
 * peeks pass false to skip that side effect entirely - they only need the content to run the
 * working/needsLogin regex against, and must not fight the terminal view's own geometry or double
 * the exec cost when both peek the same pane. */
export async function peekPane(target: TmuxTarget, resize = true): Promise<TmuxPeek> {
	const pane = paneTarget(target);
	if (resize) {
		// Best-effort resize before the capture so the view fits the phone. Separate run() with a
		// swallowed failure: an old tmux without resize-window, or a transient error, must not fail
		// the capture itself.
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
	const ansi = await run(tmuxArgv(target, ["capture-pane", "-t", pane, "-e", "-p"]));
	const hash = crypto.createHash("sha256").update(ansi).digest("hex").slice(0, 16);
	return { ansi, hash };
}

/** Snapshot the devcontainer's `docker logs` (a bounded recent tail), for the console terminal view
 * while a session's tmux pane does not exist yet. Merges stdout+stderr so a boot failure printed to
 * either stream shows. Host targets have no container, so this rejects for them. */
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

/** The console-facing peek: a live tmux pane when this session's pane is up, else the devcontainer's
 * container logs while it is still booting (no pane yet). Only an `absent` pane (calm, still-booting)
 * falls back; a real failure, or an also-absent container (the true Offline moment), rejects with the
 * original peek error so the gateway keeps its absent/failure classification. Callers needing the raw
 * reject-on-absent to detect a dead launch (awaitReady, handleWake) use `peekPane` directly instead.
 * `resize` forwards to `peekPane` - see its own doc for why a derive-only caller passes false. */
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
			// The container is not running either (true Offline). Rethrow the ORIGINAL absent peek
			// error so the gateway keeps its absent classification and the console shows its waking
			// fallback, rather than surfacing the docker-logs failure.
			throw err;
		}
	}
}

/** Raw named-key send-keys invocation, no `-l`. Callers run this inside their own `serialized()`
 * lock, so it does not take one itself (nesting would deadlock: the inner call would wait on the
 * chain entry the outer call is currently occupying). */
function sendKeyRaw(target: TmuxTarget, key: string): Promise<string> {
	return run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), key]));
}

/** Type a literal line into the pane. When `submit` (default), a REAL Enter keypress follows as its
 * OWN send-keys invocation (same `serialized()` lock, so nothing else can land between the two) -
 * NOT embedded as a trailing CR inside the literal. A target CLI with paste detection (multiple
 * characters arriving in a single write) treats an embedded CR as inserted text rather than a submit
 * signal; only a keypress delivered alone registers as Enter. With `submit=false` the text is typed
 * with no Enter at all, staging it in the agent's composer for a later deliberate submit. The `--`
 * ends option parsing so text starting with a dash is typed literally. */
export function sendText(target: TmuxTarget, text: string, submit = true): Promise<void> {
	return serialized(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", text]));
		if (submit) await sendKeyRaw(target, "Enter");
	});
}

/** Send a single named control key (no literal text). Rejects (does not spawn) when the key is not
 * on the whitelist. */
export function sendKey(target: TmuxTarget, key: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		if (!ALLOWED_KEYS.has(key)) throw new Error(`disallowed key "${key}"`);
		await sendKeyRaw(target, key);
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
		await run(tmuxArgv(target, ["kill-session", "-t", exactSession(target.sessionName)]));
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
		await run(tmuxArgv(target, ["has-session", "-t", exactSession(target.sessionName)]));
		return true;
	} catch {
		return false;
	}
}

/** Press a single literal digit key: it selects AND confirms the matching option on the launch/resume
 * menus (no trailing Enter). The daemon presses it itself to clear these prompts, so it does not
 * pass through the console keystroke whitelist. */
function pressDigit(target: TmuxTarget, digit: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", digit]));
	});
}

/** Poll the pane until the REPL composer appears, pressing "1" through the dev-channels and
 * folder-trust menus as they show, and "2" through the large-resumed-session picker (full session,
 * not the highlighted summary option) so an unattended resume never silently drops context. A
 * pending prompt is answered BEFORE the composer is accepted, since only the composer check returns
 * and a stale composer sharing a frame with a live picker would otherwise end the loop. Returns
 * whether the launch is alive: a launch that exits instantly takes its tmux session down with it, so
 * a pane that never captures is a dead launch. */
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
		// A pending prompt OUTRANKS the composer. A reattached pane can carry the previous
		// incarnation's composer in the same frame as a live picker, and conceding ready there
		// returns out of the loop and strands the picker unanswered forever.
		if (STARTUP_PROMPT_RE.test(clean)) {
			try {
				await pressDigit(target, "1");
			} catch {
				// a transient send failure self-heals on the next poll
			}
			continue;
		}
		if (RESUME_PROMPT_RE.test(clean)) {
			try {
				await pressDigit(target, "2");
			} catch {
				// a transient send failure self-heals on the next poll
			}
			continue;
		}
		if (isAgentReady(clean)) return { alive: true, ready: true, screen };
	}
	// Same invariant as the loop's own exit: a frame still showing a prompt is not ready, however
	// much of a composer sits above it.
	const finalClean = stripAnsi(screen);
	const prompted = STARTUP_PROMPT_RE.test(finalClean) || RESUME_PROMPT_RE.test(finalClean);
	return { alive: captureOk, ready: !prompted && isAgentReady(finalClean), screen };
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
