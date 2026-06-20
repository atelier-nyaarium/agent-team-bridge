////////////////////////////////
//  Interfaces & Types
//
//  The gateway<->host-daemon RPC vocabulary for the console terminal view. These
//  ride the existing host WebSocket as opaque JSON (not codegen'd, not console-
//  facing): the gateway builds a HostOp and correlates the reply by reqId; the host
//  daemon executes it against tmux. Type-only, no runtime deps, so both the gateway
//  and the host MCP can import it without pulling node:child_process across the line.

/** Which tmux a host op targets: the orchestrator's own session, or a devcontainer's. */
export interface TmuxTarget {
	kind: "gateway" | "devcontainer";
	name: string;
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
]);

export type HostOp =
	| { kind: "peek"; target: TmuxTarget }
	// dedupKey = `${conversationId}:${opId}`: the host replays a completed send's ack for a
	// re-relayed identical op instead of re-injecting the keystrokes (idempotency across a
	// relay timeout or a gateway restart).
	| { kind: "sendText"; target: TmuxTarget; text: string; dedupKey?: string }
	| { kind: "sendKey"; target: TmuxTarget; key: string; dedupKey?: string };

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
