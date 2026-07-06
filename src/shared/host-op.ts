////////////////////////////////
//  Interfaces & Types
//
//  The gateway<->host-daemon RPC vocabulary for the console terminal view. These
//  ride the existing host WebSocket as opaque JSON (not codegen'd, not console-
//  facing): the gateway builds a HostOp and correlates the reply by reqId; the host
//  daemon executes it against tmux. Type-only, no runtime deps, so both the gateway
//  and the host MCP can import it without pulling node:child_process across the line.
//
//  Deliberately type-only (no zod schema, unlike the evie/console frames): this RPC
//  rides the DIRECT, token-authenticated host WS, not the untrusted evie relay, so it
//  follows the same hand-typed + field-guard convention as the wake/catalog frames on
//  that channel rather than the zod-at-the-boundary ethos reserved for the evie link.

/** Which tmux a host op targets: a named session on the host machine (bare `tmux`), or in a
 * devcontainer (`docker exec`). A target carries its session NAME; the pane is always `.0`
 * (reserved for the agent), so a target can address one of several named sessions on the same
 * host or container. `name` is the device label (the host, or the devcontainer team). */
export interface TmuxTarget {
	kind: "host" | "devcontainer";
	name: string;
	sessionName: string;
}

/** The only control keys a console may send by name. Enforced at BOTH the gateway dispatch
 * (fail fast, no host round-trip) and the host executor (the keystroke gate), so an arbitrary
 * string can never reach `tmux send-keys` as a key token. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
	"Enter",
	"Escape",
	"C-c",
	"Up",
	"Down",
	"Left",
	"Right",
	"Tab",
	"BTab",
	"BSpace",
	"M-BSpace",
]);

/** The slug a tmux session/device name must match (lowercase alnum + hyphen, no leading hyphen,
 * bounded). The host executor (tmuxCore.assertName, reloadPlugins.assertSlug) is the keystroke-level
 * gate; the gateway applies the same rule at the boundary so a malformed or oversized session
 * segment is rejected with a clear error before it is relayed. */
export const TMUX_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_TMUX_NAME_LEN = 64;
export function isTmuxName(name: string): boolean {
	return name.length <= MAX_TMUX_NAME_LEN && TMUX_NAME_RE.test(name);
}
/** Throwing form for the host executor sinks (tmuxCore, reloadPlugins), so the regex + length cap
 * are enforced identically at the host as at the gateway boundary. */
export function assertTmuxName(name: string): void {
	if (!isTmuxName(name)) throw new Error(`invalid tmux name "${name}"`);
}

/** Host tmux session names the bridge must never drive, create, or kill: the daemon's own supervisor
 * session shares the bare host tmux server, so a forget would take down the wake plumbing and a
 * create/wake would relaunch over that non-agent pane. Enforced at four sites: the console op boundary
 * (resolveTmuxTarget, which blocks every host op), the wake dispatch (gateway doWakeTeam) and the wake
 * handler (daemon handleWake), and the destructive tmux sink (createSession/killSession backstop). The
 * conventional host agent session (DEFAULT_SESSION) is intentionally absent; reattaching to a live
 * agent is expected. */
export const RESERVED_HOST_SESSIONS: ReadonlySet<string> = new Set(["host-daemon"]);
export function isReservedHostSession(session: string): boolean {
	return RESERVED_HOST_SESSIONS.has(session);
}

/** A team/project name that reaches the daemon's shell launch command. Looser than a tmux slug - a
 * catalog project may legitimately contain dots (a "my.app" dir) and a composite is `project.session`
 * - but still free of any shell metacharacter (quote, semicolon, space, $), so it can never break out
 * of the single-quoted launch command. */
export const SHELL_SAFE_NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;
export function isShellSafeName(name: string): boolean {
	return name.length <= MAX_TMUX_NAME_LEN && SHELL_SAFE_NAME_RE.test(name);
}

/** A conversationId must be a dotless slug so it stays ONE injective segment of a flattened channel
 * key (the upcoming dot-delimited grammar splits store keys on "."). Capped at 128 - it is a key
 * component, not a tmux name, so it is looser on length than a slug but identical on charset. Every
 * producer already complies (crypto.randomUUID, the console sha256 hex owner id). */
export const CONVERSATION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_CONVERSATION_ID_LEN = 128;

export type HostOp =
	| { kind: "peek"; target: TmuxTarget }
	// dedupKey = `${conversationId}:${opId}`: the host replays a completed mutating op's ack for a
	// re-relayed identical op instead of re-running it (idempotency across a relay timeout or a
	// gateway restart). It guards the keystroke injections and the two session-lifecycle ops below.
	// submit (default true) appends the trailing Enter; submit:false types the literal text into the
	// composer without submitting, so the console Send button can stage text before a deliberate submit.
	| { kind: "sendText"; target: TmuxTarget; text: string; submit?: boolean; dedupKey?: string }
	| { kind: "sendKey"; target: TmuxTarget; key: string; dedupKey?: string }
	// Start a new tmux session on the target running a fresh agent. The daemon owns the launch
	// command (model/effort/plugin); the op carries only the target, the session name, and an optional
	// host-only workdirHint (resolved by the daemon's resolveHostWorkdir), so a console can never
	// inject an arbitrary host command or path.
	| { kind: "createSession"; target: TmuxTarget; workdirHint?: string; dedupKey?: string }
	// Drive the target session's pane through the plugin update + MCP reconnect sequence.
	| { kind: "reloadPlugins"; target: TmuxTarget; dedupKey?: string }
	// Tear down the target tmux session (the console's Forget). Idempotent: killing an
	// already-gone session is treated as success.
	| { kind: "killSession"; target: TmuxTarget; dedupKey?: string };

/** A captured tmux pane plus a short content hash, so the console can skip an unchanged frame. The
 * raw return of `peekPane`; `peekWithFallback` wraps it into the tagged `HostPeekResult` below. */
export interface TmuxPeek {
	ansi: string;
	hash: string;
}

/** The console terminal view's peek result over the host WS: a live tmux pane once this session's
 * pane exists, else a snapshot of the devcontainer's `docker logs` while it is still booting (no
 * pane yet). The two carry different payloads (a pane's ANSI vs the log text), tagged by `kind`.
 * Host-WS-only (type-only, not codegen'd), so a discriminated union is safe here; the console-facing
 * schema (ConsolePeekResultSchema) stays a flat object for codegen reasons. */
export type HostPeekResult =
	| { kind: "tmux"; ansi: string; hash: string }
	| { kind: "container-logs"; text: string; hash: string };

/** What kind of failure a peek hit: the pane is merely ABSENT (booting, exited, or stopped - a calm
 * transient) vs a real FAILURE (timeout, offline host). */
export type PeekErrorKind = "absent" | "failure";

/** The gateway-side resolution of a host op: ok + a result, or an error string (plus an `errorKind`
 * for a failed peek, classified at the host so consumers read a kind, not stderr wording). */
export interface HostOpResult {
	ok: boolean;
	result?: unknown;
	error?: string;
	errorKind?: PeekErrorKind;
}

// A peek whose tmux server/pane/container is gone emits one of these stderr fragments; a timeout or
// any other exit is a real failure. The single classifier, so the absent-vs-failure decision lives
// in one place (here, at the host) rather than re-derived from stderr wording at each consumer.
const PEEK_ABSENT_PATTERNS = [
	"no server running",
	"can't find session",
	"can't find pane",
	"no such container",
	"is not running",
];
export function classifyPeekError(error: string): PeekErrorKind {
	const lower = error.toLowerCase();
	if (lower.includes("timed out") || lower.includes("tmux command exited")) return "failure";
	if (PEEK_ABSENT_PATTERNS.some((s) => lower.includes(s))) return "absent";
	return "failure";
}
