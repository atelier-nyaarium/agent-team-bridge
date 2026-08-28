import {
	CodexAppServerResponseSchema,
	CodexAppServerThreadStartResultSchema,
	CodexAppServerTurnStartResultSchema,
} from "../../shared/codex-agent.js";
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

const METHOD_NOT_FOUND = -32601;
const REQUEST_TIMEOUT_MS = 60_000;

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
			if (parsed.data.error) waiter.reject(new Error(parsed.data.error.message));
			else waiter.resolve(parsed.data.result);
			return;
		}

		// An id we minted is ours however malformed the frame is.
		if (typeof frame.id === "number" && pending.has(frame.id)) {
			const waiter = pending.get(frame.id);
			pending.delete(frame.id);
			waiter?.reject(new Error(`unreadable response`));
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
		for (const waiter of pending.values()) waiter.reject(new Error(`app server exited`));
		pending.clear();
	});

	return {
		request(method, params) {
			if (closed) return Promise.reject(new Error(`app server exited`));
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
	private constructor(
		private readonly transport: AppServerTransport,
		private readonly defaultModel: string,
		private readonly offered: OfferedModels,
	) {}

	/**
	 * Handshake, then confirm the model.
	 *
	 * An unlisted model is refused rather than falling back to the server's default. `initialize`
	 * advertises no version, so `model/list` is the only compatibility check there is.
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
		return CodexAppServerThreadStartResultSchema.parse(result).thread.id;
	}

	async resumeThread(threadId: string): Promise<void> {
		await this.transport.request("thread/resume", { threadId });
	}

	/** `includeTurns` is load-bearing and NOT the default. Without it the reply is well-formed with an
	 * empty `turns` array, and reconciliation reports a completed turn as unrecoverable. */
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

	/** The wire field is `expectedTurnId`; `turn/interrupt` names the same value `turnId`. */
	async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
		await this.transport.request("turn/steer", {
			threadId,
			expectedTurnId: turnId,
			input: [{ type: "text", text }],
		});
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.transport.request("turn/interrupt", { threadId, turnId });
	}

	close(): void {
		this.transport.close();
	}
}
