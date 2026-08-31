import { CodexAppServerResponseSchema, CodexAppServerThreadStartResultSchema } from "../../shared/codex-agent.js";
import type { CodexChild } from "./codexTargets.js";
import {
	type LifecycleDeps,
	type ThreadInspection,
	ThreadLifecycle,
	type ThreadPhase,
} from "./codexThreadLifecycle.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

/** Each offered model id, mapped to the strongest reasoning tier it advertises. */
type OfferedModels = Map<string, string | undefined>;

export interface AppServerTransport {
	/** Rejects only with an `AppServerFailure`; a double rejecting with anything else is not a transport. */
	request(method: string, params: unknown): Promise<unknown>;
	notify(method: string, params: unknown): void;
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	close(): void;
}

export interface ThreadSettings {
	cwd: string;
	/** Optional override. Verified against `model/list` like the default, never taken on trust. */
	model?: string;
}

/** What the lifecycle tells its consumer; both default to nothing so a caller that only reads needs neither. */
export type LifecycleHooks = Partial<Pick<LifecycleDeps, "onTerminal" | "onPoisoned">>;

////////////////////////////////
//  Functions & Helpers

const METHOD_NOT_FOUND = -32601;
const REQUEST_TIMEOUT_MS = 60_000;

export type AppServerFailureKind = "refused" | "timeout" | "unreadable" | "closed";

/** Every failure this module minted; an error wearing the prototype is not one. */
const minted = new WeakSet<AppServerFailure>();

/** Required by the constructor and never exported, so a constructor reached through an instance mints nothing. */
const MINT = Symbol("AppServerFailure");

/** How a request failed. Module-private, so only this transport mints one; a caller branches on `kind`. */
class AppServerFailure extends Error {
	readonly kind: AppServerFailureKind;
	/** The JSON-RPC code and data; refusals only. */
	readonly code: number | undefined;
	readonly data: unknown;

	constructor(mint: symbol, kind: AppServerFailureKind, message: string, refusal?: { code: number; data?: unknown }) {
		super(message);
		if (mint !== MINT) throw new Error(`AppServerFailure is minted by the transport`);
		this.name = "AppServerFailure";
		this.kind = kind;
		this.code = refusal?.code;
		this.data = refusal?.data;
		minted.add(this);
	}
}

export type { AppServerFailure };

export function isAppServerFailure(error: unknown): error is AppServerFailure {
	return error instanceof AppServerFailure && minted.has(error);
}

/**
 * Every server-initiated request, and the refusal it always gets.
 *
 * Switchboard grants nothing on a caller's behalf. Each is refused in the shape that method expects,
 * so Codex proceeds inside its existing sandbox rather than stalling.
 */
const DECLINED_REQUESTS = new Map<string, unknown>([
	["item/commandApproval", { decision: "denied" }],
	["item/fileChangeApproval", { decision: "denied" }],
	["thread/userInput", { cancelled: true }],
	["thread/elicitation", { action: "cancel" }],
	["app/toolApproval", { decision: "denied" }],
	["permission/request", { granted: false }],
]);

// A server-supplied name is echoed back bounded.
const MAX_ECHOED_METHOD = 80;

/** One line per message is the whole wire format. */
function frame(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

/** The JSONL wire over a child's stdio. A failed request rejects with this module's own `AppServerFailure`. */
export function createJsonlTransport(child: CodexChild): AppServerTransport {
	let nextId = 1;
	let buffered = "";
	let closed = false;
	// Typed to the minted failure, so an ending that rejects with a bare Error does not compile.
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: AppServerFailure) => void }>();
	const eventListeners: Array<(message: { method: string; params?: unknown }) => void> = [];

	function fail(kind: AppServerFailureKind, message: string): void {
		for (const waiter of pending.values()) waiter.reject(new AppServerFailure(MINT, kind, message));
		pending.clear();
	}

	function write(message: unknown): void {
		if (closed) return;
		try {
			child.stdin.write(frame(message));
		} catch {
			// A pipe refusing a write is a dead child, whether or not its exit has been seen yet. The
			// kill makes the exit path run, which is what drops the supervisor's lease.
			closed = true;
			fail("closed", `app server exited`);
			child.kill();
		}
	}

	function answerServerRequest(id: string | number, method: string | undefined): void {
		// A Map, since an object would resolve `constructor` to an inherited function.
		const declined = method === undefined ? undefined : DECLINED_REQUESTS.get(method);
		if (declined !== undefined) {
			write({ jsonrpc: "2.0", id, result: declined });
			return;
		}
		// Refused, not ignored: silence hangs whatever Codex is waiting on.
		const named = (method ?? "malformed").slice(0, MAX_ECHOED_METHOD);
		write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `unsupported request: ${named}` } });
	}

	function handle(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		// An uncaught throw in a stream handler takes the daemon down.
		if (typeof message !== "object" || message === null || Array.isArray(message)) return;
		const frame = message as Record<string, unknown>;

		const parsed = CodexAppServerResponseSchema.safeParse(frame);
		if (parsed.success) {
			// Never coerced: a string "1" must not settle numeric 1.
			const waiter = typeof parsed.data.id === "number" ? pending.get(parsed.data.id) : undefined;
			if (!waiter) return;
			pending.delete(parsed.data.id as number);
			if (parsed.data.error) {
				const { code, message, data } = parsed.data.error;
				waiter.reject(new AppServerFailure(MINT, "refused", message, { code, data }));
			} else waiter.resolve(parsed.data.result);
			return;
		}

		// An id we minted is ours however malformed the frame is.
		if (typeof frame.id === "number" && pending.has(frame.id)) {
			const waiter = pending.get(frame.id);
			pending.delete(frame.id);
			waiter?.reject(new AppServerFailure(MINT, "unreadable", `unreadable response`));
			return;
		}

		// Anything else with an id is a request, and something is waiting on it.
		if (frame.id !== undefined) {
			answerServerRequest(
				frame.id as string | number,
				typeof frame.method === "string" ? frame.method : undefined,
			);
			return;
		}
		if (typeof frame.method === "string") {
			// Queued, not inline: resolving a request only SCHEDULES its continuation, so an inline
			// listener would run first and invert wire order when a reply and a notification share a chunk.
			const notification = frame as { method: string; params?: unknown };
			queueMicrotask(() => {
				for (const listener of eventListeners) listener(notification);
			});
		}
	}

	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString();
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) handle(line);
	});

	child.onExit(() => {
		closed = true;
		fail("closed", `app server exited`);
	});

	return {
		request(method, params) {
			if (closed) return Promise.reject(new AppServerFailure(MINT, "closed", `app server exited`));
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new AppServerFailure(MINT, "timeout", `timed out: ${method}`));
				}, REQUEST_TIMEOUT_MS);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value);
					},
					reject: (err) => {
						clearTimeout(timer);
						reject(err);
					},
				});
				write({ jsonrpc: "2.0", id, method, params });
			});
		},
		notify(method, params) {
			write({ jsonrpc: "2.0", method, params });
		},
		onEvent(listener) {
			eventListeners.push(listener);
		},
		close() {
			// Already ended by an exit, a refused write or an earlier close: nothing left to fail or kill.
			if (closed) return;
			closed = true;
			fail("closed", `app server exited`);
			child.kill();
		},
	};
}

/** Per model, since they differ: luna tops out at `max` while others offer `ultra`. Undefined leaves
 * the thread on that model's own default. */
export function strongestEffort(model: {
	supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown }>;
}): string | undefined {
	const order = ["low", "medium", "high", "xhigh", "max", "ultra"];
	return (model.supportedReasoningEfforts ?? [])
		.map((e) => e.reasoningEffort)
		.filter((e): e is string => typeof e === "string" && order.includes(e))
		.sort((a, b) => order.indexOf(a) - order.indexOf(b))
		.pop();
}

////////////////////////////////
//  Class

/**
 * A client over one App Server child.
 *
 * Fail-closed at every edge: no thread before `initialize` completes and the model is confirmed
 * offered, and every permission request is refused rather than granted.
 */
export class CodexAppServerClient {
	private readonly lifecycle: ThreadLifecycle;

	private constructor(
		private readonly transport: AppServerTransport,
		private readonly defaultModel: string,
		private readonly offered: OfferedModels,
		hooks: LifecycleHooks,
	) {
		this.lifecycle = new ThreadLifecycle({
			request: (method, params) => transport.request(method, params),
			classify: (error) => (isAppServerFailure(error) ? error : null),
			onTerminal: hooks.onTerminal ?? (() => {}),
			onPoisoned: hooks.onPoisoned ?? (() => {}),
		});
	}

	/**
	 * Handshake, then confirm the model.
	 *
	 * An unlisted model is refused rather than falling back to the server's default. `initialize`
	 * advertises no version, so `model/list` is the only compatibility check there is.
	 */
	static async open(
		transport: AppServerTransport,
		requestedModel: string,
		hooks: LifecycleHooks = {},
	): Promise<CodexAppServerClient> {
		await transport.request("initialize", {
			clientInfo: { name: "switchboard", title: "Switchboard", version: "1" },
		});
		transport.notify("initialized", {});

		const listed = (await transport.request("model/list", {})) as {
			data?: Array<{ id?: string; supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown }> }>;
		};
		const offered = new Map<string, string | undefined>();
		for (const model of listed.data ?? []) {
			if (typeof model.id === "string") offered.set(model.id, strongestEffort(model));
		}
		if (!offered.has(requestedModel)) throw new Error(`model not offered: ${requestedModel}`);

		return new CodexAppServerClient(transport, requestedModel, offered, hooks);
	}

	onEvent(listener: (message: { method: string; params?: unknown }) => void): void {
		this.transport.onEvent(listener);
	}

	/** Sandbox is explicit: the default is read-only, and `approvalPolicy: "never"` cannot escalate. */
	async startThread(settings: ThreadSettings): Promise<string> {
		const model = settings.model ?? this.defaultModel;
		// An override is checked against the same list the default was.
		if (!this.offered.has(model)) throw new Error(`model not offered: ${model}`);

		const result = await this.transport.request("thread/start", {
			cwd: settings.cwd,
			model,
			// Absent when the model advertises no tiers.
			...(this.offered.get(model) ? { reasoningEffort: this.offered.get(model) } : {}),
			approvalPolicy: "never",
			sandbox: "workspace-write",
		});
		const threadId = CodexAppServerThreadStartResultSchema.parse(result).thread.id;
		this.lifecycle.started(threadId);
		return threadId;
	}

	/** Loads the thread whatever its state: a parked one is unarchived first. */
	async resumeThread(threadId: string): Promise<void> {
		await this.lifecycle.activate(threadId);
	}

	/** `includeTurns` is load-bearing and NOT the default. Without it the reply is well-formed with an
	 * empty `turns` array, and reconciliation reports a completed turn as unrecoverable. */
	async readThread(threadId: string): Promise<unknown> {
		return this.lifecycle.read(threadId, { threadId, includeTurns: true });
	}

	async startTurn(threadId: string, text: string): Promise<string> {
		return this.lifecycle.startTurn(threadId, {
			threadId,
			input: [{ type: "text", text }],
		});
	}

	/** The wire field is `expectedTurnId`; `turn/interrupt` names the same value `turnId`. */
	async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
		await this.lifecycle.steerTurn(threadId, turnId, {
			threadId,
			expectedTurnId: turnId,
			input: [{ type: "text", text }],
		});
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.lifecycle.interruptTurn(threadId, turnId, { threadId, turnId });
	}

	/** The one entry for a terminal: published through the hook, then the thread is parked. */
	settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome): Promise<void> {
		return this.lifecycle.settleTurn(threadId, turnId, terminal);
	}

	/** For a thread whose first turn is in doubt: take what it holds, or delete it once two reads prove nothing. */
	adoptOrDispose(threadId: string): Promise<ThreadInspection> {
		return this.lifecycle.adoptOrDispose(threadId);
	}

	stateOf(threadId: string): ThreadPhase | undefined {
		return this.lifecycle.stateOf(threadId);
	}

	close(): void {
		this.lifecycle.close();
		this.transport.close();
	}
}
