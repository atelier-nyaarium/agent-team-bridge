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

export type HostOp =
	| { kind: "peek"; target: TmuxTarget }
	// dedupKey = `${conversationId}:${opId}`: the host replays a completed mutating op's ack for a
	// re-relayed identical op instead of re-running it (idempotency across a relay timeout or a
	// gateway restart). It guards the keystroke injections and the two session-lifecycle ops below.
	| { kind: "sendText"; target: TmuxTarget; text: string; dedupKey?: string }
	| { kind: "sendKey"; target: TmuxTarget; key: string; dedupKey?: string }
	// Start a new tmux session on the target running a fresh agent. The daemon owns the launch
	// command (model/effort/plugin); the op carries only the target + the chosen session name, so a
	// console can never inject an arbitrary host command.
	| { kind: "createSession"; target: TmuxTarget; dedupKey?: string }
	// Drive the target session's pane through the plugin update + MCP reconnect sequence.
	| { kind: "reloadPlugins"; target: TmuxTarget; dedupKey?: string };

/** A captured pane plus a short content hash, so the console can skip an unchanged frame. */
export interface HostPeekResult {
	ansi: string;
	hash: string;
}

/** The gateway-side resolution of a host op: ok + a result, or an error string. */
export interface HostOpResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}
