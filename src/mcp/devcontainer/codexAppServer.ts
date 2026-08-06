import {
	CodexAppServerResponseSchema,
	CodexAppServerThreadStartResultSchema,
	CodexAppServerTurnStartResultSchema,
} from "../../shared/codex-thinking.js";
import type { CodexChild } from "./codexTargets.js";

////////////////////////////////
//  Interfaces & Types

/** Each offered model id, mapped to the strongest reasoning tier it advertises. */
type OfferedModels = Map<string, string | undefined>;

export interface AppServerTransport {
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

////////////////////////////////
//  Functions & Helpers

// JSON-RPC's own code for a method the receiver does not implement. A server-initiated request that
// reaches the unknown branch gets this rather than silence, so the App Server is never left waiting.
const METHOD_NOT_FOUND = -32601;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Every server-initiated request this client answers, and the answer it always gives.
 *
 * Codex asks permission for things Switchboard never grants on a caller's behalf: running a command
 * it wants approved, writing a file outside what the thread already allows, prompting a human,
 * elicitation, and app or tool approval. Each is refused in the shape that method expects, so Codex
 * proceeds within the sandbox it already has instead of stalling on an answer that never comes.
 */
const DECLINED_REQUESTS = new Map<string, unknown>([
	["item/commandApproval", { decision: "denied" }],
	["item/fileChangeApproval", { decision: "denied" }],
	["thread/userInput", { cancelled: true }],
	["thread/elicitation", { action: "cancel" }],
	["app/toolApproval", { decision: "denied" }],
	["permission/request", { granted: false }],
]);

// A method name is server-supplied, so it is echoed back bounded. An unbounded one would put an
// arbitrary string of Codex's choosing into an error this side generates.
const MAX_ECHOED_METHOD = 80;

/** Frame a JSON-RPC message as one line, which is the whole wire format. */
function frame(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

export function createJsonlTransport(child: CodexChild): AppServerTransport {
	let nextId = 1;
	let buffered = "";
	let closed = false;
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	const eventListeners: Array<(message: { method: string; params?: unknown }) => void> = [];

	function write(message: unknown): void {
		if (closed) return;
		child.stdin.write(frame(message));
	}

	function answerServerRequest(id: string | number, method: string | undefined): void {
		// A Map rather than an object literal: an object would resolve a method named `constructor` or
		// `toString` to an inherited function and answer with a body that serializes to nothing.
		const declined = method === undefined ? undefined : DECLINED_REQUESTS.get(method);
		if (declined !== undefined) {
			write({ jsonrpc: "2.0", id, result: declined });
			return;
		}
		// Refused rather than ignored: silence would hang whatever Codex is waiting on, and guessing a
		// permissive shape would grant something nobody reviewed.
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
		// `null` and a bare array both parse as valid JSON, and reading a property off either throws
		// inside a stream handler, where an uncaught throw takes the whole daemon down.
		if (typeof message !== "object" || message === null || Array.isArray(message)) return;
		const frame = message as Record<string, unknown>;

		const parsed = CodexAppServerResponseSchema.safeParse(frame);
		if (parsed.success) {
			// Correlate on the exact id sent, never a coerced one, so a string "1" cannot settle the
			// promise waiting on numeric 1.
			const waiter = typeof parsed.data.id === "number" ? pending.get(parsed.data.id) : undefined;
			if (!waiter) return;
			pending.delete(parsed.data.id as number);
			if (parsed.data.error) waiter.reject(new Error(parsed.data.error.message));
			else waiter.resolve(parsed.data.result);
			return;
		}

		// An id we minted is ours no matter how malformed the frame is. Treating it as a server request
		// would answer the child using our own id and leave the real caller waiting out the timeout.
		if (typeof frame.id === "number" && pending.has(frame.id)) {
			const waiter = pending.get(frame.id);
			pending.delete(frame.id);
			waiter?.reject(new Error("unreadable response"));
			return;
		}

		// Anything else carrying an id is a REQUEST, however malformed, and something is waiting on it.
		// A well-formed method gets its decline; anything else still gets an answer.
		if (frame.id !== undefined) {
			answerServerRequest(
				frame.id as string | number,
				typeof frame.method === "string" ? frame.method : undefined,
			);
			return;
		}
		if (typeof frame.method === "string") {
			// Queued, not called inline. Resolving a request only SCHEDULES its awaiting continuation, so
			// a listener invoked synchronously here would run first and invert wire order whenever a reply
			// and a notification arrive in one chunk. That is not rare: a steer's reply and its turn's own
			// `turn/completed` routinely land together, and the inversion made the steer look undelivered.
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
		for (const waiter of pending.values()) waiter.reject(new Error("app server exited"));
		pending.clear();
	});

	return {
		request(method, params) {
			if (closed) return Promise.reject(new Error("app server exited"));
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`timed out: ${method}`));
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
			closed = true;
			child.kill();
		},
	};
}

/** The strongest tier a model offers, read per model because they differ: luna tops out at `max`
 * while others also offer `ultra`, so a fixed string would under-drive one of them. Undefined when a
 * model advertises none, which leaves the thread on that model's own default. */
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
 * Fail-closed at every edge: it refuses to hand out threads until `initialize` has completed and the
 * requested model is confirmed offered, and it answers every permission request Codex raises with a
 * refusal rather than a grant.
 */
export class CodexAppServerClient {
	private constructor(
		private readonly transport: AppServerTransport,
		private readonly defaultModel: string,
		private readonly offered: OfferedModels,
	) {}

	/**
	 * Handshake, then confirm the model.
	 *
	 * A model the server does not list is refused rather than falling back to the server's own default,
	 * which would run a tier nobody asked for. `initialize` advertises no version or capabilities, so
	 * `model/list` is the only thing there is to check compatibility against.
	 */
	static async open(transport: AppServerTransport, requestedModel: string): Promise<CodexAppServerClient> {
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

		return new CodexAppServerClient(transport, requestedModel, offered);
	}

	onEvent(listener: (message: { method: string; params?: unknown }) => void): void {
		this.transport.onEvent(listener);
	}

	/** Sandbox and network are deliberately not sent: the thread takes the App Server's ordinary
	 * workspace-write behavior, which is what the questionnaire chose. */
	async startThread(settings: ThreadSettings): Promise<string> {
		const model = settings.model ?? this.defaultModel;
		// An override is checked against the same list the default was, so a caller-supplied model can
		// never reach thread/start unverified and quietly run a tier nobody asked for.
		if (!this.offered.has(model)) throw new Error(`model not offered: ${model}`);

		const result = await this.transport.request("thread/start", {
			cwd: settings.cwd,
			model,
			// Absent when the model advertises no tiers, so it runs at its own default rather than one
			// this side guessed.
			...(this.offered.get(model) ? { reasoningEffort: this.offered.get(model) } : {}),
			approvalPolicy: "never",
		});
		return CodexAppServerThreadStartResultSchema.parse(result).thread.id;
	}

	async resumeThread(threadId: string): Promise<void> {
		await this.transport.request("thread/resume", { threadId });
	}

	/** `includeTurns` is load-bearing and NOT the default. Without it the App Server answers with an
	 * empty `turns` array rather than an error, so reconciliation reads a well-formed reply, finds the
	 * turn missing, and reports a completed turn as unrecoverable. */
	async readThread(threadId: string): Promise<unknown> {
		return this.transport.request("thread/read", { threadId, includeTurns: true });
	}

	/** Only once the terminal is durably acknowledged, or a later follow-up has nothing to resume. */
	async unsubscribeThread(threadId: string): Promise<void> {
		await this.transport.request("thread/unsubscribe", { threadId });
	}

	async startTurn(threadId: string, text: string): Promise<string> {
		const result = await this.transport.request("turn/start", {
			threadId,
			input: [{ type: "text", text }],
		});
		return CodexAppServerTurnStartResultSchema.parse(result).turn.id;
	}

	async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
		await this.transport.request("turn/steer", { threadId, turnId, input: [{ type: "text", text }] });
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.transport.request("turn/interrupt", { threadId, turnId });
	}

	close(): void {
		this.transport.close();
	}
}
