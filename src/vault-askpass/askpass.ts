// The askpass decision over ports; the entry point wires the real ones.

import { VAULT_ROUTE_WAIT_CAP_MS, type VaultValueAnswer, VaultValueAnswerSchema } from "../shared/schemasVault.js";

/** A tty race polls briefly; a hold without one is long. */
export const RACE_WAIT_MS = 25_000;
export const HOLD_WAIT_MS = VAULT_ROUTE_WAIT_CAP_MS;
export const WITHDRAW_TIMEOUT_MS = 3_000;
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

/** sudo options that take a value, so the value is never read as the command. */
const SUDO_VALUED_FLAGS = new Set(["-C", "-D", "-g", "-h", "-p", "-r", "-t", "-T", "-u", "-U"]);

export interface GatewayPort {
	/** Null when the gateway cannot be reached or refuses the token. */
	askpass(cmdline: string, waitMs: number, signal: AbortSignal, asker?: string): Promise<VaultValueAnswer | null>;
	collect(requestId: string, waitMs: number, signal: AbortSignal): Promise<VaultValueAnswer | null>;
	/** Bounded; a gateway that stalls does not hold the helper. */
	withdraw(requestId: string): Promise<void>;
}

export interface TtyPort {
	/** The typed line, empty when only Enter was pressed; null when the tty closed or the read was aborted. */
	readSecret(prompt: string, signal: AbortSignal): Promise<string | null>;
}

export interface AskpassPorts {
	gateway: GatewayPort;
	tty: TtyPort | null;
	now: () => number;
}

export type AskpassOutcome =
	| { kind: "value"; value: string; from: "phone" | "tty" }
	| { kind: "refused"; note?: string }
	| { kind: "unreachable" }
	| { kind: "no-answer" };

/** `/proc/<pid>/cmdline` is NUL-separated. */
export function parseProcCmdline(raw: Uint8Array | string): string {
	const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
	return text
		.split("\0")
		.filter((part) => part.length > 0)
		.join(" ")
		.trim();
}

/** One run of the caller: its pid and `/proc/<pid>/stat` start ticks, read past the parenthesised comm. */
export function askerOf(pid: number, stat: string): string | null {
	const close = stat.lastIndexOf(")");
	if (close === -1) return null;
	const start = stat
		.slice(close + 1)
		.trim()
		.split(/\s+/)[19];
	return start && /^\d+$/.test(start) ? `${pid}:${start}` : null;
}

/** Only a password or passphrase prompt reaches the phone; a confirmation or a username stays at the tty. */
export function secretPrompt(prompt: string): boolean {
	const text = prompt.toLowerCase();
	if (text.includes("yes/no") || text.includes("username")) return false;
	return /passw|passphrase|secret|token|pin\b/.test(text) || text.trim() === "";
}

/** The executable path stands in for the first word; sudo's askpass flag is dropped. */
export function askpassBrief(cmdline: string, exe?: string): string {
	const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "";
	if (exe) tokens[0] = exe;
	if (tokens[0].split("/").at(-1) !== "sudo") return tokens.join(" ");
	const kept = [tokens[0]];
	let index = 1;
	for (; index < tokens.length && tokens[index].startsWith("-"); index += 1) {
		const token = tokens[index];
		if (token === "--") break;
		if (token === "--askpass") continue;
		const flag = token.startsWith("--") || !token.includes("A") ? token : token.replace("A", "");
		if (flag !== "-") kept.push(flag);
		if (SUDO_VALUED_FLAGS.has(`-${flag.at(-1)}`) && !flag.startsWith("--") && index + 1 < tokens.length) {
			index += 1;
			kept.push(tokens[index]);
		}
	}
	return [...kept, ...tokens.slice(index)].join(" ");
}

/** The opening call asks for no wait, so the request id is known before anyone can win. */
async function askPhone(
	gateway: GatewayPort,
	cmdline: string,
	asker: string | undefined,
	collectMs: number,
	deadlineAt: number,
	now: () => number,
	signal: AbortSignal,
): Promise<AskpassOutcome> {
	let pendingId: string | null = null;
	let answer = await gateway.askpass(cmdline, 0, signal, asker);
	for (;;) {
		if (signal.aborted) {
			if (pendingId) await gateway.withdraw(pendingId);
			return { kind: "no-answer" };
		}
		if (answer === null) return { kind: "unreachable" };
		if (answer.outcome === "approved") return { kind: "value", value: answer.value, from: "phone" };
		if (answer.outcome === "refused")
			return answer.note ? { kind: "refused", note: answer.note } : { kind: "refused" };
		pendingId = answer.requestId;
		if (now() >= answer.deadlineAt || now() >= deadlineAt) return { kind: "no-answer" };
		answer = await gateway.collect(answer.requestId, collectMs, signal);
	}
}

/** An empty line asks again; a closed tty leaves the phone road running alone. */
async function askTty(tty: TtyPort, prompt: string, signal: AbortSignal): Promise<AskpassOutcome> {
	while (!signal.aborted) {
		const value = await tty.readSecret(prompt, signal);
		if (value === null) break;
		if (value) return { kind: "value", value, from: "tty" };
	}
	return { kind: "no-answer" };
}

/** The first value wins; only the caller's abort ends both roads. */
export async function runAskpass(
	input: { cmdline: string; prompt: string; asker?: string; deadlineMs?: number; signal?: AbortSignal },
	ports: AskpassPorts,
): Promise<AskpassOutcome> {
	if (input.signal?.aborted) return { kind: "no-answer" };
	const deadlineAt = ports.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
	const phoneAbort = new AbortController();
	const ttyAbort = new AbortController();
	input.signal?.addEventListener(
		"abort",
		() => {
			ttyAbort.abort();
			phoneAbort.abort();
		},
		{ once: true },
	);
	const phone = askPhone(
		ports.gateway,
		input.cmdline,
		input.asker,
		ports.tty ? RACE_WAIT_MS : HOLD_WAIT_MS,
		deadlineAt,
		ports.now,
		phoneAbort.signal,
	).catch((): AskpassOutcome => ({ kind: "unreachable" }));
	if (!ports.tty) return phone;

	const tty = askTty(ports.tty, input.prompt, ttyAbort.signal);
	const first = await Promise.race([
		phone.then((outcome) => ({ road: "phone" as const, outcome })),
		tty.then((outcome) => ({ road: "tty" as const, outcome })),
	]);
	if (first.road === "phone" && first.outcome.kind === "value") {
		ttyAbort.abort();
		return first.outcome;
	}
	if (first.road === "phone") {
		const typed = await tty;
		return typed.kind === "value" ? typed : first.outcome;
	}
	if (first.outcome.kind !== "value") return phone;
	phoneAbort.abort();
	await phone;
	return first.outcome;
}

/** The helper's HTTP door to the gateway's loopback routes. A session token beside the helper's names the session as the asker. */
export function createGatewayPort(deps: {
	baseUrl: string;
	token: string;
	sessionToken?: string;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
}): GatewayPort {
	const headers = {
		"content-type": "application/json",
		"x-vault-helper-token": deps.token,
		...(deps.sessionToken ? { "x-session-token": deps.sessionToken } : {}),
	};
	/** An abort answers null at once, whether or not the transport notices it. */
	const send = (path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response | null> =>
		new Promise((resolve) => {
			const onAbort = () => resolve(null);
			signal?.addEventListener("abort", onAbort, { once: true });
			deps.fetch(`${deps.baseUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			})
				.then(resolve, () => resolve(null))
				.finally(() => signal?.removeEventListener("abort", onAbort));
		});
	const ask = async (
		path: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<VaultValueAnswer | null> => {
		const response = await send(path, body, signal);
		if (!response) return null;
		// A missing token or an unenrolled gateway is the same road closed.
		const parsed = VaultValueAnswerSchema.safeParse(await response.json().catch(() => null));
		return parsed.success ? parsed.data : null;
	};
	return {
		askpass: (cmdline, waitMs, signal, asker) =>
			ask("/vault/askpass", { cmdline, waitMs, ...(asker ? { asker } : {}) }, signal),
		collect: (requestId, waitMs, signal) => ask("/vault/collect", { requestId, waitMs }, signal),
		withdraw: async (requestId) => {
			const bound = new AbortController();
			const timer = setTimeout(() => bound.abort(), WITHDRAW_TIMEOUT_MS);
			try {
				await send("/vault/withdraw", { requestId }, bound.signal);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** A helper with no token, or a prompt that is not for a secret, has no gateway road. */
export const closedGateway: GatewayPort = {
	askpass: async () => null,
	collect: async () => null,
	withdraw: async () => undefined,
};
