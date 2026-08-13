import type { AgentChild } from "./codexTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface AcpEvent {
	method: string;
	params?: unknown;
}

export interface AcpTransport {
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	notify(method: string, params: unknown): void;
	onEvent(listener: (event: AcpEvent) => void): void;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

const METHOD_NOT_FOUND = -32601;
const REQUEST_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

function frame(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

function serverRequestResult(method: string): unknown | undefined {
	if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
	return undefined;
}

export function createAcpTransport(child: AgentChild): AcpTransport {
	let nextId = 1;
	let buffered = "";
	let closed = false;
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const listeners: Array<(event: AcpEvent) => void> = [];

	const rejectPending = (error: Error): void => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};

	const write = (message: unknown): void => {
		if (closed) return;
		try {
			child.stdin.write(frame(message));
		} catch {
			closed = true;
		}
	};

	const handle = (line: string): void => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null || Array.isArray(message)) return;
		const record = message as Record<string, unknown>;
		const id = record.id;
		if (id !== undefined && record.method === undefined) {
			const waiter = pending.get(String(id));
			if (!waiter) return;
			pending.delete(String(id));
			if (record.error && typeof record.error === "object") {
				const error = record.error as { message?: unknown };
				waiter.reject(new Error(typeof error.message === "string" ? error.message : "ACP request failed"));
			} else {
				waiter.resolve(record.result);
			}
			return;
		}
		if (id !== undefined && typeof record.method === "string") {
			const result = serverRequestResult(record.method);
			if (result !== undefined) write({ jsonrpc: "2.0", id, result });
			else
				write({
					jsonrpc: "2.0",
					id,
					error: { code: METHOD_NOT_FOUND, message: `unsupported request: ${record.method}` },
				});
			return;
		}
		if (typeof record.method === "string") {
			const event = { method: record.method, params: record.params };
			queueMicrotask(() => {
				for (const listener of listeners) listener(event);
			});
		}
	};

	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString();
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) handle(line);
	});
	child.stdout.on("error", () => {});
	child.stdin.on("error", () => {});
	child.onExit((info) => {
		closed = true;
		const error = new Error(info.reason === "authFailed" ? "Copilot login required" : "Copilot ACP exited");
		rejectPending(error);
	});

	return {
		request(method, params, timeoutMs = method === "session/prompt" ? PROMPT_TIMEOUT_MS : REQUEST_TIMEOUT_MS) {
			if (closed) return Promise.reject(new Error("Copilot ACP exited"));
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(String(id));
					reject(new Error(`timed out: ${method}`));
				}, timeoutMs);
				pending.set(String(id), {
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
				write({ jsonrpc: "2.0", id, method, params });
			});
		},
		notify(method, params) {
			write({ jsonrpc: "2.0", method, params });
		},
		onEvent(listener) {
			listeners.push(listener);
		},
		close() {
			if (closed) return;
			closed = true;
			rejectPending(new Error("Copilot ACP closed"));
			child.kill();
		},
	};
}

////////////////////////////////
//  Client

export interface CopilotAcpSessionInfo {
	sessionId: string;
	model?: string;
}

interface AcpConfigOption {
	id?: unknown;
}

function supportsConfigOption(configOptions: AcpConfigOption[] | undefined, id: string): boolean {
	return configOptions === undefined || configOptions.some((option) => option.id === id);
}

export class CopilotAcpClient {
	private constructor(private readonly transport: AcpTransport) {}

	static async open(transport: AcpTransport): Promise<CopilotAcpClient> {
		const result = (await transport.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: "switchboard", version: "1" },
		})) as { protocolVersion?: number };
		if (result.protocolVersion !== 1) throw new Error("unsupported ACP protocol version");
		transport.notify("initialized", {});
		return new CopilotAcpClient(transport);
	}

	onEvent(listener: (event: AcpEvent) => void): void {
		this.transport.onEvent(listener);
	}

	async newSession(cwd: string, model?: string): Promise<CopilotAcpSessionInfo> {
		const result = (await this.transport.request("session/new", { cwd, mcpServers: [] })) as {
			sessionId?: unknown;
			configOptions?: AcpConfigOption[];
		};
		if (typeof result.sessionId !== "string" || result.sessionId.length === 0)
			throw new Error("ACP returned no session ID");
		if (model && supportsConfigOption(result.configOptions, "model")) await this.setModel(result.sessionId, model);
		if (supportsConfigOption(result.configOptions, "allow_all"))
			await this.enableAgentPermissions(result.sessionId);
		return { sessionId: result.sessionId, model };
	}

	async loadSession(sessionId: string, cwd: string): Promise<void> {
		const result = (await this.transport.request("session/load", { sessionId, cwd, mcpServers: [] })) as {
			configOptions?: AcpConfigOption[];
		};
		if (supportsConfigOption(result.configOptions, "allow_all")) await this.enableAgentPermissions(sessionId);
	}

	async setModel(sessionId: string, model: string): Promise<void> {
		await this.transport.request("session/set_config_option", { sessionId, configId: "model", value: model });
	}

	private async enableAgentPermissions(sessionId: string): Promise<void> {
		await this.transport.request("session/set_config_option", {
			sessionId,
			configId: "allow_all",
			value: "on",
		});
	}

	async prompt(sessionId: string, text: string): Promise<{ stopReason?: string }> {
		const result = await this.transport.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text }],
		});
		return typeof result === "object" &&
			result !== null &&
			typeof (result as { stopReason?: unknown }).stopReason === "string"
			? { stopReason: (result as { stopReason: string }).stopReason }
			: {};
	}

	cancel(sessionId: string): void {
		this.transport.notify("session/cancel", { sessionId });
	}

	close(): void {
		this.transport.close();
	}
}

export async function defaultOpenCopilotClient(child: AgentChild): Promise<CopilotAcpClient> {
	const transport = createAcpTransport(child);
	try {
		return await CopilotAcpClient.open(transport);
	} catch (error) {
		transport.close();
		throw error;
	}
}
