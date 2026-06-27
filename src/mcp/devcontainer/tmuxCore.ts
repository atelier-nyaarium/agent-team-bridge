import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { ALLOWED_KEYS, assertTmuxName, type HostPeekResult, type TmuxTarget } from "../../shared/host-op.js";

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

////////////////////////////////
//  Functions & Helpers

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
	const ansi = await run(tmuxArgv(target, ["capture-pane", "-t", paneTarget(target), "-e", "-p"]));
	const hash = crypto.createHash("sha256").update(ansi).digest("hex").slice(0, 16);
	return { ansi, hash };
}

/** Type a literal line and submit it, atomically in ONE send-keys: the trailing CR is the
 * Enter key, so the text and its submission can never be torn apart by a failure between two
 * commands. The `--` ends option parsing so text starting with a dash is typed literally (and
 * it would swallow a `;` command separator, which is why the CR rides inside the literal). */
export function sendText(target: TmuxTarget, text: string): Promise<void> {
	return serialized(targetKey(target), async () => {
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", `${text}\r`]));
	});
}

/** Send a single named control key (no literal text, no trailing Enter). Rejects (does
 * not spawn) when the key is not on the whitelist. */
export function sendKey(target: TmuxTarget, key: string): Promise<void> {
	return serialized(targetKey(target), async () => {
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
	await run(tmuxArgv(target, ["new-session", "-d", "-s", target.sessionName, command]), 15_000);
}
