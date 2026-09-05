import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_VAULT_CAPTURE_CHARS, VAULT_ROUTE_WAIT_CAP_MS, VaultValueAnswerSchema } from "../../shared/schemasVault.js";
import { routerPost } from "../bridge/helpers.js";
import {
	DEFAULT_ENV_NAME,
	FILE_ENV_NAME,
	OUTPUT_CAP_CHARS,
	runWithValue,
	type VaultRunHandle,
	type VaultRunResult,
} from "./vaultRun.js";

////////////////////////////////
//  Schemas

const WAIT_SECONDS = Math.floor(VAULT_ROUTE_WAIT_CAP_MS / 1000);

const CaptureSchema = z.object({
	publicTitle: z.string().min(1).max(256).describe(`The new entry's title, public.`),
	publicDescription: z.string().max(2048).optional().describe(`Public description.`),
});

const WaitSchema = z
	.number()
	.int()
	.min(0)
	.max(VAULT_ROUTE_WAIT_CAP_MS)
	.optional()
	.describe(`How long to wait, up to ${WAIT_SECONDS} seconds, before answering \`pending\` or \`running\`.`);

const SearchInputSchema = {
	query: z.string().max(256).optional().describe(`Substring of the public title or description. Omit for all.`),
};

const RunInputSchema = {
	command: z
		.string()
		.min(1)
		.max(4096)
		.describe(`Shell line, run with \`sh -c\`. The owner reads it before approving.`),
	cwd: z
		.string()
		.max(4096)
		.optional()
		.describe(`Working directory. Default: the MCP process's, not the project root.`),
	entryId: z.string().min(1).max(64).optional().describe(`Entry whose value to inject. Omit for a capture-only run.`),
	shape: z
		.enum(["env", "stdin", "file"])
		.optional()
		.describe(
			`
\`env\`: the value in \`$VAULT_VALUE\` (default).
\`stdin\`: the value followed by a newline on stdin.
\`file\`: a 0600 file holding the value, its path in \`$VAULT_FILE\`, gone after exit.
`.trim(),
		),
	envName: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
		.max(64)
		.optional()
		.describe(`Variable name for the \`env\` shape only; ignored by the others.`),
	capture: CaptureSchema.optional().describe(
		`Store the command's stdout as a new entry; stdout is then never returned.`,
	),
	waitMs: WaitSchema,
};

const CollectInputSchema = {
	jobId: z.string().min(1).max(128).describe(`From a \`pending\` or \`running\` answer.`),
	waitMs: WaitSchema,
};

const WithdrawInputSchema = {
	jobId: z.string().min(1).max(128).describe(`The job to give up.`),
};

////////////////////////////////
//  Interfaces & Types

export type VaultPost = (path: string, body: Record<string, unknown>) => Promise<unknown>;

export interface VaultToolDeps {
	post: VaultPost;
	run: typeof runWithValue;
	now: () => number;
}

interface RunSpec {
	command: string;
	cwd?: string;
	shape: "env" | "stdin" | "file";
	envName?: string;
	capture?: z.infer<typeof CaptureSchema>;
}

type Job =
	| { kind: "awaiting"; spec: RunSpec; requestId: string; deadlineAt: number }
	| { kind: "running"; spec: RunSpec; handle: VaultRunHandle; startedAt: number };

export type VaultToolAnswer = Record<string, unknown>;

////////////////////////////////
//  Functions & Helpers

const SEARCH_DESCRIPTION = `
# Vault Search

List the owner's vault entries this session may use: id, public title, public description, and whether a value is held.

No tool answers a value. Use the id with \`vault_run\`.
`.trim();

const RUN_DESCRIPTION = `
# Vault Run

Run a shell command with a vault entry's value injected, once the owner approves the operation on the phone.

The command is what the owner reads. Name the real program and target: \`ssh deploy@prod\`, not \`sh script.sh\`.

Shapes: \`env\` puts the value in \`$${DEFAULT_ENV_NAME}\` (or \`envName\`); \`stdin\` writes it followed by a newline; \`file\` writes a 0600 file and names it in \`$${FILE_ENV_NAME}\`, gone after exit. Never expand the value onto a command line: \`ps\` shows argv.

Answers:
- \`ran\`: exit code or the signal that ended it, stdout, and stderr, with the value's bytes replaced by \`[vault]\`. Each stream is capped at ${OUTPUT_CAP_CHARS} characters; \`truncated\` says when.
- \`pending\`: the owner has not answered yet. \`jobId\` is the request id. \`vault_collect\` waits again; \`vault_withdraw\` gives up.
- \`running\`: the command outlived the wait. \`jobId\` names it in this process. \`vault_collect\` waits for it.
- \`refused\`: the owner declined, the request expired, or this session may not use the entry.

The wait is capped at ${WAIT_SECONDS} seconds per call. Jobs live in this process only; a lost answer is not recoverable, but a repeated \`vault_run\` with the same entry and command joins the request still open for it.

\`capture\` stores stdout as a new entry the owner can edit on the phone: \`captured\` is its id, and stdout is never returned. An empty, oversized, or refused capture answers \`captured: null\` with a reason. With no \`entryId\` the command runs at once with nothing injected: the road for generating a secret.
`.trim();

const COLLECT_DESCRIPTION = `
# Vault Collect

Continue a \`pending\` or \`running\` job from \`vault_run\`. Answers as \`vault_run\` does.
`.trim();

const WITHDRAW_DESCRIPTION = `
# Vault Withdraw

Give up a job: a pending request is withdrawn from the owner's phone, a running command is stopped. \`withdrawn: false\` with a reason means the request may still be live; retry, or let it expire.
`.trim();

const budget = (waitMs: number | undefined): number =>
	Math.min(waitMs ?? VAULT_ROUTE_WAIT_CAP_MS, VAULT_ROUTE_WAIT_CAP_MS);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** routerPost throws a non-2xx as its body text; a route's own refusal reads through it. */
function refusalOf(error: unknown, action: string): VaultToolAnswer {
	const message = errorText(error);
	const body = /^HTTP \d+: ([\s\S]*)$/.exec(message)?.[1] ?? message;
	try {
		const parsed = JSON.parse(body) as unknown;
		const answer = VaultValueAnswerSchema.safeParse(parsed);
		if (answer.success && answer.data.outcome === "refused")
			return { outcome: "refused", reason: answer.data.reason };
		const gateway = (parsed as { error?: unknown } | null)?.error;
		if (typeof gateway === "string") return { outcome: "refused", reason: `${action}: ${gateway}` };
	} catch {}
	return { outcome: "refused", reason: `${action}: ${message}` };
}

async function finish(spec: RunSpec, result: VaultRunResult, deps: VaultToolDeps): Promise<VaultToolAnswer> {
	const base = {
		outcome: "ran",
		exitCode: result.exitCode,
		...(result.signal ? { signal: result.signal } : {}),
		stderr: result.stderr,
		...(result.truncated ? { truncated: true } : {}),
	};
	if (!spec.capture) return { ...base, stdout: result.stdout };
	// A cut output would store a piece of the secret as the whole of it.
	if (result.truncated) return { ...base, captured: null, reason: "stdout was cut, so nothing was stored" };
	const raw = result.rawStdout ?? "";
	// The gateway trims one trailing newline; the value is judged as it will be stored.
	const stored = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	if (!stored) return { ...base, captured: null, reason: "the command wrote nothing to stdout" };
	if (stored.length > MAX_VAULT_CAPTURE_CHARS)
		return { ...base, captured: null, reason: `stdout exceeds ${MAX_VAULT_CAPTURE_CHARS} characters` };
	try {
		const created = (await deps.post("/vault/capture", { ...spec.capture, value: raw })) as { id?: string };
		return { ...base, captured: created.id ?? null };
	} catch (error) {
		return { ...base, captured: null, reason: refusalOf(error, "capture").reason };
	}
}

export function createVaultTools(deps: VaultToolDeps) {
	const jobs = new Map<string, Job>();
	const collecting = new Map<string, Promise<VaultToolAnswer>>();

	/** Waits for the child until the deadline; a longer run stays collectable. */
	async function settle(
		jobId: string,
		spec: RunSpec,
		handle: VaultRunHandle,
		deadlineAt: number,
	): Promise<VaultToolAnswer> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), Math.max(0, deadlineAt - deps.now()));
		});
		const result = await Promise.race([handle.done, expiry]).finally(() => clearTimeout(timer));
		if (result === null) {
			jobs.set(jobId, { kind: "running", spec, handle, startedAt: deps.now() });
			return { outcome: "running", jobId };
		}
		jobs.delete(jobId);
		return finish(spec, result, deps);
	}

	/** An approved answer starts the child; the rest are returned as they are. */
	async function proceed(
		jobId: string,
		spec: RunSpec,
		answer: unknown,
		deadlineAt: number,
	): Promise<VaultToolAnswer> {
		const parsed = VaultValueAnswerSchema.safeParse(answer);
		if (!parsed.success) {
			jobs.delete(jobId);
			return { outcome: "refused", reason: "the gateway answered in an unrecognized shape" };
		}
		if (parsed.data.outcome === "refused") {
			jobs.delete(jobId);
			return { outcome: "refused", reason: parsed.data.reason };
		}
		if (parsed.data.outcome === "pending") {
			const requestId = parsed.data.requestId;
			jobs.set(requestId, { kind: "awaiting", spec, requestId, deadlineAt: parsed.data.deadlineAt });
			return { outcome: "pending", jobId: requestId, deadlineAt: parsed.data.deadlineAt };
		}
		jobs.delete(jobId);
		const handle = deps.run({ ...spec, value: parsed.data.value, keepRawStdout: !!spec.capture });
		// The job keeps the id the caller already holds; only a fresh run mints one.
		return settle(jobId || crypto.randomUUID(), spec, handle, deadlineAt);
	}

	return {
		async search(args: { query?: string }): Promise<VaultToolAnswer> {
			try {
				return (await deps.post(
					"/vault/search",
					args.query === undefined ? {} : { query: args.query },
				)) as VaultToolAnswer;
			} catch (error) {
				return refusalOf(error, "search");
			}
		},

		async run(args: {
			command: string;
			cwd?: string;
			entryId?: string;
			shape?: "env" | "stdin" | "file";
			envName?: string;
			capture?: z.infer<typeof CaptureSchema>;
			waitMs?: number;
		}): Promise<VaultToolAnswer> {
			const spec: RunSpec = {
				command: args.command,
				...(args.cwd === undefined ? {} : { cwd: args.cwd }),
				shape: args.shape ?? "env",
				...(args.envName === undefined ? {} : { envName: args.envName }),
				...(args.capture === undefined ? {} : { capture: args.capture }),
			};
			const waitMs = budget(args.waitMs);
			const deadlineAt = deps.now() + waitMs;
			if (!args.entryId) {
				if (!spec.capture) return { outcome: "refused", reason: "name an entryId, or capture" };
				return settle(crypto.randomUUID(), spec, deps.run({ ...spec, keepRawStdout: true }), deadlineAt);
			}
			let answer: unknown;
			try {
				answer = await deps.post("/vault/use", { entryId: args.entryId, operation: args.command, waitMs });
			} catch (error) {
				return refusalOf(error, "use");
			}
			return proceed("", spec, answer, deadlineAt);
		},

		/** One collect per job; a second caller shares the answer. */
		async collect(args: { jobId: string; waitMs?: number }): Promise<VaultToolAnswer> {
			const shared = collecting.get(args.jobId);
			if (shared) return shared;
			const job = jobs.get(args.jobId);
			if (!job) return { outcome: "refused", reason: "no such job" };
			const waitMs = budget(args.waitMs);
			const deadlineAt = deps.now() + waitMs;
			const work = (async () => {
				if (job.kind === "running") return settle(args.jobId, job.spec, job.handle, deadlineAt);
				let answer: unknown;
				try {
					answer = await deps.post("/vault/collect", { requestId: job.requestId, waitMs });
				} catch (error) {
					jobs.delete(args.jobId);
					return refusalOf(error, "collect");
				}
				return proceed(args.jobId, job.spec, answer, deadlineAt);
			})();
			collecting.set(args.jobId, work);
			try {
				return await work;
			} finally {
				collecting.delete(args.jobId);
			}
		},

		async withdraw(args: { jobId: string }): Promise<VaultToolAnswer> {
			const job = jobs.get(args.jobId);
			if (!job) return { withdrawn: false, reason: "no such job" };
			if (job.kind === "running") {
				jobs.delete(args.jobId);
				job.handle.kill();
				await job.handle.done;
				return { withdrawn: true };
			}
			let answer: { withdrawn?: boolean };
			try {
				answer = (await deps.post("/vault/withdraw", { requestId: job.requestId })) as { withdrawn?: boolean };
			} catch (error) {
				// The request may still be live; the job stays for another try.
				return { withdrawn: false, reason: refusalOf(error, "withdraw").reason };
			}
			jobs.delete(args.jobId);
			return answer.withdrawn
				? { withdrawn: true }
				: { withdrawn: false, reason: "the request had already settled" };
		},

		/** Children are stopped before anything is awaited. */
		async shutdown(): Promise<void> {
			const held = [...jobs.values()];
			jobs.clear();
			const stopped = held
				.filter((job) => job.kind === "running")
				.map((job) => {
					job.handle.kill();
					return job.handle.done;
				});
			const withdrawn = held
				.filter((job) => job.kind === "awaiting")
				.map((job) => deps.post("/vault/withdraw", { requestId: job.requestId }));
			await Promise.allSettled([...stopped, ...withdrawn]);
		},
	};
}

function text(answer: VaultToolAnswer): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(answer, null, 2) }] };
}

/** Long polls are never re-posted: a lost answer must not open a second request. */
const postOnce: VaultPost = (path, body) => routerPost(path, body, { retries: 0 });

////////////////////////////////
//  Registration

export function registerVaultTools(
	mcpServer: McpServer,
	deps: VaultToolDeps = { post: postOnce, run: runWithValue, now: () => Date.now() },
): ReturnType<typeof createVaultTools> {
	const tools = createVaultTools(deps);
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const searchSchema: any = SearchInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const runSchema: any = RunInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const collectSchema: any = CollectInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const withdrawSchema: any = WithdrawInputSchema;

	mcpServer.registerTool(
		"vault_search",
		{ title: `Vault Search`, description: SEARCH_DESCRIPTION, inputSchema: searchSchema },
		async (args: { query?: string }) => text(await tools.search(args)),
	);
	mcpServer.registerTool(
		"vault_run",
		{ title: `Vault Run`, description: RUN_DESCRIPTION, inputSchema: runSchema },
		async (args: Parameters<typeof tools.run>[0]) => text(await tools.run(args)),
	);
	mcpServer.registerTool(
		"vault_collect",
		{ title: `Vault Collect`, description: COLLECT_DESCRIPTION, inputSchema: collectSchema },
		async (args: { jobId: string; waitMs?: number }) => text(await tools.collect(args)),
	);
	mcpServer.registerTool(
		"vault_withdraw",
		{ title: `Vault Withdraw`, description: WITHDRAW_DESCRIPTION, inputSchema: withdrawSchema },
		async (args: { jobId: string }) => text(await tools.withdraw(args)),
	);
	return tools;
}
