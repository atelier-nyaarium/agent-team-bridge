// Shared host-side primitives for the bun provisioning/setup orchestrators: thin typed wrappers
// over Bun.$ (docker, and kubectl run through the gateway container that holds the evie
// kubeconfig) plus base64 Secret reads and Opaque-Secret apply, the interactive menu/prompt loop,
// .env read/write, and the logging the orchestrators share.

import { $ } from "bun";

////////////////////////////////
//  Constants

// The gateway container holds the evie kubeconfig, so every kubectl call runs through it.
export const CONTAINER = "switchboard";
export const NS = "evie-bot";
export const KUBECONFIG_IN = "/app/kubeconfig.yaml";

////////////////////////////////
//  Logging

export const note = (msg: string): void => console.log(`>> ${msg}`);
export const err = (msg: string): void => console.error(`ERROR: ${msg}`);

/** Print an error and exit non-zero. */
export function die(msg: string): never {
	err(msg);
	process.exit(1);
}

////////////////////////////////
//  Docker + kubectl (Bun.$)

/** kubectl inside the gateway container. Returns the ShellPromise; await `.text()` for stdout,
 * `.quiet().nothrow()` for a probe whose exit code you want to read. */
export function k(...args: string[]) {
	return $`docker exec ${CONTAINER} kubectl --kubeconfig=${KUBECONFIG_IN} -n ${NS} ${args}`;
}

/** kubectl with `stdin` piped in (e.g. `apply -f -`). */
export function kStdin(stdin: string, ...args: string[]) {
	return $`docker exec -i ${CONTAINER} kubectl --kubeconfig=${KUBECONFIG_IN} -n ${NS} ${args} < ${Buffer.from(stdin)}`;
}

/** docker exec into the gateway container (printenv, rm, ...). */
export function dx(...args: string[]) {
	return $`docker exec ${CONTAINER} ${args}`;
}

/** docker compose in the current project. */
export function dc(...args: string[]) {
	return $`docker compose ${args}`;
}

/** True when the gateway container is currently running. `.nothrow()` so a down docker daemon
 * reads as "not up" instead of throwing a raw shell error. */
export async function containerUp(): Promise<boolean> {
	const ps = await $`docker ps --format ${"{{.Names}}"}`.quiet().nothrow();
	return ps
		.text()
		.split("\n")
		.map((n) => n.trim())
		.includes(CONTAINER);
}

/** Ensure the gateway container is up so kubectl can reach the cluster; start it for this run
 * if it is down (e.g. right after a purge). The image already exists, so this is a fast `up`,
 * not a rebuild, and the container is left running. */
export async function ensureContainer(): Promise<void> {
	if (await containerUp()) return;
	note(`gateway container is down - starting it so kubectl can reach the cluster`);
	const up = await dc("up", "-d").quiet().nothrow();
	if (up.exitCode !== 0) die(`docker compose up failed (is docker running?)`);
	for (let i = 0; i < 30; i++) {
		const probe = await $`docker exec ${CONTAINER} kubectl --kubeconfig=${KUBECONFIG_IN} version`.quiet().nothrow();
		if (probe.exitCode === 0) return;
		await Bun.sleep(2000);
	}
	die(`the '${CONTAINER}' container started but kubectl is not reachable through it`);
}

/** A base64-decoded kubectl jsonpath read; empty string when the secret/field is absent. */
export async function kGetB64(...args: string[]): Promise<string> {
	const r = await k(...args)
		.quiet()
		.nothrow();
	const v = r.text().trim();
	return v ? Buffer.from(v, "base64").toString() : "";
}

/** Read a ServiceAccount-token Secret's (token, ca.crt) pair, base64-decoded; empty strings when absent. */
export async function readSaCreds(secret: string): Promise<{ saToken: string; caPem: string }> {
	const saToken = await kGetB64("get", "secret", secret, "-o", "jsonpath={.data.token}");
	const caPem = await kGetB64("get", "secret", secret, "-o", "jsonpath={.data.ca\\.crt}");
	return { saToken, caPem };
}

/** Apply an Opaque Secret (values base64-encoded) as YAML on stdin, so values never hit argv.
 * serverSide uses SSA + --force-conflicts (for a Secret a controller also writes). Returns whether the
 * apply succeeded, so the caller chooses to throw or tolerate. */
export async function applySecret(name: string, data: Record<string, string>, serverSide = false): Promise<boolean> {
	const lines = Object.entries(data)
		.map(([key, val]) => `  ${key}: ${Buffer.from(val).toString("base64")}`)
		.join("\n");
	const yaml = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\n  namespace: ${NS}\ntype: Opaque\ndata:\n${lines}\n`;
	const flags = serverSide ? ["apply", "--server-side", "--force-conflicts", "-f", "-"] : ["apply", "-f", "-"];
	return (
		(
			await kStdin(yaml, ...flags)
				.quiet()
				.nothrow()
		).exitCode === 0
	);
}

////////////////////////////////
//  Interactive menu + prompts (Bun built-ins, zero deps)

export interface MenuItem {
	key: string;
	label: string;
	run: () => Promise<void> | void;
}

/** Numbered dial menu, looping until the operator quits (q or empty). TTY only - a non-TTY caller
 * drives the flow directly instead. */
export async function menu(title: string, items: MenuItem[]): Promise<void> {
	for (;;) {
		console.log(`\n${title}`);
		for (const it of items) console.log(`  ${it.key}) ${it.label}`);
		console.log(`  q) Quit`);
		const choice = ask(">");
		if (choice === "" || choice.toLowerCase() === "q") return;
		const item = items.find((i) => i.key === choice);
		if (!item) {
			console.log(`Enter ${items.map((i) => i.key).join(", ")}, or q.`);
			continue;
		}
		// A failed operation drops back to the menu so the operator can retry, instead of
		// crashing the whole tool.
		try {
			await item.run();
		} catch (e) {
			err(e instanceof Error ? e.message : String(e));
		}
	}
}

/** Read one trimmed line from the operator. */
export function ask(label: string): string {
	return (prompt(label) ?? "").trim();
}

/** A y/N confirmation; defaults to No. */
export function confirm(label: string): boolean {
	return ask(`${label} [y/N]:`).toLowerCase() === "y";
}

////////////////////////////////
//  JSON

/** Parse JSON, returning null on any malformed input. */
export function jparse<T = unknown>(s: string): T | null {
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

////////////////////////////////
//  .env file (the project's gateway config)

const ENV_FILE = ".env";

/** Read KEY's value from .env (text after the first '=', trimmed); empty when absent. */
export async function envGet(key: string): Promise<string> {
	const env = await Bun.file(ENV_FILE)
		.text()
		.catch(() => "");
	const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
	return line ? line.slice(key.length + 1).trim() : "";
}

/** Write KEY=value to .env, replacing any existing KEY line and keeping every other line. Blank
 * lines are dropped: splitting a newline-terminated file yields a trailing empty element, so
 * dropping all blanks keeps the rewrite idempotent instead of accreting a stray blank each call.
 * Comment lines (neither KEY= nor empty) survive. */
export async function envSet(key: string, value: string): Promise<void> {
	const env = await Bun.file(ENV_FILE)
		.text()
		.catch(() => "");
	const kept = env.split("\n").filter((l) => l !== "" && !l.startsWith(`${key}=`));
	kept.push(`${key}=${value}`);
	await Bun.write(ENV_FILE, `${kept.join("\n")}\n`);
}
