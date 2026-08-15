// Shared host-side primitives for the bun setup orchestrators: typed wrappers over Bun.$ (docker,
// and admin-only kubectl run through the gateway container), base64 Secret reads,
// Opaque-Secret apply, the interactive menu/prompt loop, .env read/write, and logging.

import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { $ } from "bun";

////////////////////////////////
//  Constants

// Only the admin-provisioning path copies its explicitly configured kubeconfig here. Ordinary
// gateways never receive a kubeconfig and enroll through the Console instead.
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
//  OS-aware host primitives

/** The LAN-facing IPv4 of the interface that reaches the internet: the source address the OS picks
 * when routing to a public IP, so a Docker-bridge or VPN address never wins the phone's pinned-TLS
 * dial. Cross-platform in place of `ip route get` / `hostname -I`: a connected UDP socket binds the
 * outbound interface, and its local address is that source IP. No packet is sent. Resolves 0.0.0.0
 * when no route is available. */
export function detectLanHost(): Promise<string> {
	return new Promise((resolve) => {
		const sock = dgram.createSocket("udp4");
		const finish = (ip: string): void => {
			try {
				sock.close();
			} catch {}
			resolve(ip);
		};
		sock.once("error", () => finish("0.0.0.0"));
		try {
			sock.connect(80, "1.1.1.1", () => {
				try {
					finish(sock.address().address || "0.0.0.0");
				} catch {
					finish("0.0.0.0");
				}
			});
		} catch {
			finish("0.0.0.0");
		}
	});
}

/** Best-effort 0600 on a host-local secret file. POSIX applies the mode; on Windows fs.chmod only
 * toggles the read-only bit, so a caller must not treat this as a hard guarantee there. Never throws. */
export function secureFile(filePath: string): void {
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {}
}

/** True when the path exists and is a directory (cross-platform `test -d`). */
export function dirExists(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
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

/** docker compose in the current project. */
export function dc(...args: string[]) {
	return $`docker compose ${args}`;
}

/** The federation Router is its own compose project, so it needs the file and project name that
 * `start-federation.sh` uses; a bare `docker compose` here would target the gateway instead. */
export function dcFederation(...args: string[]) {
	return $`docker compose -f docker-compose.federation.yml -p switchboard-federation ${args}`;
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

/** Ensure the gateway container is up, starting it if down (e.g. right after a purge). Builds so a
 * pulled code change is picked up rather than an old image crash-looping; the layer cache keeps an
 * unchanged build fast. This deliberately does not require Kubernetes: a new Gateway starts in
 * credentials-free arming mode until its Console delivers an enrollment bundle. */
export async function ensureContainer(): Promise<void> {
	if (await containerUp()) return;
	note(`Starting gateway docker`);
	const up = await dc("up", "--build", "-d").quiet().nothrow();
	if (up.exitCode !== 0) die(`docker compose up failed (is docker running?)`);
}

/** Prepare Kubernetes access for the explicit Evie Admin Provision action. The kubeconfig location
 * is intentionally opt-in and local to the administrator's .env; it is copied into the running
 * container only for that admin workflow, never declared by Docker Compose. */
export async function ensureAdminKubernetes(): Promise<void> {
	const kubeconfig = await envGet("SWITCHBOARD_KUBECONFIG");
	if (!kubeconfig) {
		throw new Error(
			"Evie Admin Provision requires SWITCHBOARD_KUBECONFIG in .env (for example: SWITCHBOARD_KUBECONFIG=/absolute/path/to/kubeconfig.yaml)",
		);
	}
	const source = path.resolve(kubeconfig);
	if (!(await Bun.file(source).exists())) {
		throw new Error(`SWITCHBOARD_KUBECONFIG does not exist: ${source}`);
	}
	await ensureContainer();
	const copy = await $`docker cp ${source} ${`${CONTAINER}:${KUBECONFIG_IN}`}`.quiet().nothrow();
	if (copy.exitCode !== 0) throw new Error("could not copy SWITCHBOARD_KUBECONFIG into the admin container");
	const chmod = await $`docker exec ${CONTAINER} chmod 600 ${KUBECONFIG_IN}`.quiet().nothrow();
	if (chmod.exitCode !== 0) throw new Error("could not secure the admin kubeconfig in the gateway container");
	for (let i = 0; i < 30; i++) {
		const probe = await $`docker exec ${CONTAINER} kubectl --kubeconfig=${KUBECONFIG_IN} version`.quiet().nothrow();
		if (probe.exitCode === 0) return;
		await Bun.sleep(2000);
	}
	throw new Error(`kubectl not reachable through '${CONTAINER}'`);
}

/** Remove the transient admin credential after an admin operation completes. Failure is harmless:
 * the next ordinary compose recreation has no kubeconfig mount and therefore cannot depend on it. */
export async function clearAdminKubeconfig(): Promise<void> {
	await $`docker exec ${CONTAINER} rm -f ${KUBECONFIG_IN}`.quiet().nothrow();
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

/** Numbered dial menu, looping until the admin quits (q or empty). TTY only - a non-TTY caller
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
		// A failed operation drops back to the menu so the admin can retry, instead of
		// crashing the whole tool.
		try {
			await item.run();
		} catch (e) {
			err(e instanceof Error ? e.message : String(e));
		}
	}
}

/** Read one trimmed line from the admin. Bun's prompt() leaves the cursor on the answer's line,
 * so the next output mashes onto it; emit the newline ourselves to keep every answer separated. */
export function ask(label: string): string {
	const v = prompt(label) ?? "";
	process.stdout.write("\n");
	return v.trim();
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

/** Write KEY=value to .env, replacing any existing KEY line and keeping every other line. Blank lines
 * are dropped so the rewrite stays idempotent rather than accreting a stray trailing blank each call
 * (splitting a newline-terminated file yields a trailing empty element). Comment lines survive. */
export async function envSet(key: string, value: string): Promise<void> {
	const env = await Bun.file(ENV_FILE)
		.text()
		.catch(() => "");
	const kept = env.split("\n").filter((l) => l !== "" && !l.startsWith(`${key}=`));
	kept.push(`${key}=${value}`);
	await Bun.write(ENV_FILE, `${kept.join("\n")}\n`);
}
