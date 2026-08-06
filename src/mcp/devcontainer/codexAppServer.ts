import {
	CodexAppServerResponseSchema,
	CodexAppServerThreadStartResultSchema,
	CodexAppServerTurnStartResultSchema,
} from "../../shared/codex-thinking.js";
import type { CodexChild } from "./codexTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface AppServerTransport {
	request(method: string, params: unknown): Promise<unknown>;
	notify(method: string, params: unknown): void;
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	close(): void;
}

export interface ThreadSettings {
	cwd: string;
	model: string;
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
const DECLINED_REQUESTS: Record<string, unknown> = {
	"item/commandApproval": { decision: "denied" },
	"item/fileChangeApproval": { decision: "denied" },
	"thread/userInput": { cancelled: true },
	"thread/elicitation": { action: "cancel" },
	"app/toolApproval": { decision: "denied" },
	"permission/request": { granted: false },
};

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

	function answerServerRequest(id: string | number, method: string): void {
		const declined = DECLINED_REQUESTS[method];
		if (declined !== undefined) {
			write({ jsonrpc: "2.0", id, result: declined });
			return;
		}
		// An unknown request is refused rather than ignored: silence would hang whatever Codex is
		// waiting on, and guessing a permissive shape would grant something nobody reviewed.
		write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `unsupported request: ${method}` } });
	}

	function handle(line: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		if (typeof message.method === "string") {
			// An id alongside a method makes it a REQUEST awaiting an answer, not a notification.
			if (message.id !== undefined) answerServerRequest(message.id as string | number, message.method);
			else for (const listener of eventListeners) listener(message as { method: string; params?: unknown });
			return;
		}

		const parsed = CodexAppServerResponseSchema.safeParse(message);
		if (!parsed.success) return;
		const waiter = pending.get(Number(parsed.data.id));
		if (!waiter) return;
		pending.delete(Number(parsed.data.id));
		if (parsed.data.error) waiter.reject(new Error(parsed.data.error.message));
		else waiter.resolve(parsed.data.result);
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
 * while others also offer `ultra`, so a fixed string would under-drive one of them. */
export function strongestEffort(model: { supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown }> }): string {
	const order = ["low", "medium", "high", "xhigh", "max", "ultra"];
	const offered = (model.supportedReasoningEfforts ?? [])
		.map((e) => e.reasoningEffort)
		.filter((e): e is string => typeof e === "string");
	return offered.sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? "high";
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
		private readonly model: string,
		private readonly reasoningEffort: string,
	) {}

	/** Handshake, then confirm the model. A model the server does not list is refused here rather than
	 * silently falling back to the server's own default, which would run a tier nobody asked for. */
	static async open(transport: AppServerTransport, requestedModel: string): Promise<CodexAppServerClient> {
		await transport.request("initialize", {
			clientInfo: { name: "switchboard", title: "Switchboard", version: "1" },
		});
		transport.notify("initialized", {});

		const listed = (await transport.request("model/list", {})) as {
			data?: Array<{ id?: string; supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown }> }>;
		};
		const model = listed.data?.find((m) => m.id === requestedModel);
		if (!model) throw new Error(`model not offered: ${requestedModel}`);

		return new CodexAppServerClient(transport, requestedModel, strongestEffort(model));
	}

	onEvent(listener: (message: { method: string; params?: unknown }) => void): void {
		this.transport.onEvent(listener);
	}

	async startThread(settings: ThreadSettings): Promise<string> {
		const result = await this.transport.request("thread/start", {
			cwd: settings.cwd,
			model: settings.model ?? this.model,
			reasoningEffort: this.reasoningEffort,
			approvalPolicy: "never",
		});
		return CodexAppServerThreadStartResultSchema.parse(result).thread.id;
	}

	async resumeThread(threadId: string): Promise<void> {
		await this.transport.request("thread/resume", { threadId });
	}

	async readThread(threadId: string): Promise<unknown> {
		return this.transport.request("thread/read", { threadId });
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
