import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
	askpassBrief,
	closedGateway,
	createGatewayPort,
	parseProcCmdline,
	runAskpass,
	secretPrompt,
	type TtyPort,
} from "./vault-askpass/askpass.js";

// sudo, ssh, and git run this with the prompt as its one argument and read the value from stdout.

/** The installer's wrapper names the token file; the default is the owner's home. */
const TOKEN_FILE =
	process.env.VAULT_ASKPASS_TOKEN_FILE ?? path.join(os.homedir(), ".config", "switchboard", "vault-askpass.token");
/** Exit 0 with the line on Enter, empty or not; anything else is a closed tty. */
const READ_SECRET =
	'trap "stty echo" EXIT; trap "stty echo; exit 1" TERM INT; stty -echo; IFS= read -r line; printf %s "$line"';
/** Drains half-typed input when the phone wins. */
const DRAIN_TTY = "stty -icanon -echo min 0 time 0; head -c 4096 >/dev/null 2>&1; stty icanon echo min 1 time 0";

function readCmdline(prompt: string): string {
	try {
		let exe: string | undefined;
		try {
			exe = fs.readlinkSync(`/proc/${process.ppid}/exe`);
		} catch {}
		const parsed = askpassBrief(parseProcCmdline(fs.readFileSync(`/proc/${process.ppid}/cmdline`)), exe);
		if (parsed) return parsed;
	} catch {}
	return prompt.trim() || "askpass";
}

/** A no-echo read in an sh child, so it never blocks the phone. */
function openTty(): TtyPort | null {
	let fd: number;
	try {
		fd = fs.openSync("/dev/tty", "r+");
	} catch {
		return null;
	}
	return {
		readSecret: (prompt, signal) =>
			new Promise((resolve) => {
				fs.writeSync(fd, `${prompt} `);
				const child = spawn("sh", ["-c", READ_SECRET], { stdio: [fd, "pipe", fd] });
				let typed = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					typed += chunk.toString("utf8");
				});
				const settle = (value: string | null) => {
					signal.removeEventListener("abort", onAbort);
					fs.writeSync(fd, "\n");
					if (value === null && !signal.aborted)
						fs.writeSync(fd, "(waiting for the phone; Ctrl-C cancels)\n");
					resolve(value);
				};
				const onAbort = () => {
					child.kill("SIGTERM");
					spawnSync("sh", ["-c", DRAIN_TTY], { stdio: [fd, "ignore", "ignore"] });
					settle(null);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (signal.aborted) return;
					settle(code === 0 ? typed : null);
				});
				child.on("error", () => settle(null));
			}),
	};
}

/** A loopback POST that no proxy variable can divert. */
function loopbackPost(url: string, init: RequestInit): Promise<Response> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const request = (target.protocol === "https:" ? https : http).request(
			target,
			{ method: init.method ?? "POST", headers: init.headers as Record<string, string> },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 0 })),
				);
				response.on("error", reject);
			},
		);
		request.on("error", reject);
		init.signal?.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
		request.end(typeof init.body === "string" ? init.body : undefined);
	});
}

function readToken(): string | null {
	try {
		return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
	} catch {
		return null;
	}
}

async function main(): Promise<number> {
	const prompt = process.argv[2] ?? "Password:";
	const token = readToken();
	if (!token) console.error(`[vault-askpass] no token at ${TOKEN_FILE}; run scripts/install-vault-askpass.ts`);
	const baseUrl = (process.env.BRIDGE_ROUTER_URL ?? "http://127.0.0.1:20000").replace(/\/+$/, "");
	const forSecret = secretPrompt(prompt);
	if (!forSecret) console.error("[vault-askpass] not a secret prompt; the terminal answers it");
	// A caller's abort withdraws the phone's request before exit.
	const cancel = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => cancel.abort());
	const outcome = await runAskpass(
		{ cmdline: readCmdline(prompt), prompt, signal: cancel.signal },
		{
			gateway: token && forSecret ? createGatewayPort({ baseUrl, token, fetch: loopbackPost }) : closedGateway,
			tty: openTty(),
			now: () => Date.now(),
		},
	);
	if (outcome.kind !== "value") {
		console.error(`[vault-askpass] no value: ${outcome.kind}`);
		return 1;
	}
	process.stdout.write(`${outcome.value}\n`);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`[vault-askpass] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	},
);
