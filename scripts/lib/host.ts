// Shared host-side primitives for the bun setup orchestrators: typed wrappers over Bun.$ (docker
// compose for the gateway and the Router), the interactive menu/prompt loop, .env read/write, and
// logging.

import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import { $ } from "bun";

////////////////////////////////
//  Constants

export const CONTAINER = "switchboard";

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

/** Every non-internal IPv4 this machine holds, the route-out address first. That first entry is the
 * one the Router binds, so the order is also the answer to "which of these is it on". Docker and VPN
 * addresses are kept rather than guessed at by interface name: they are real addresses, and hiding
 * one makes a bind that landed on it unexplainable. */
export async function detectLanHosts(): Promise<string[]> {
	const primary = await detectLanHost();
	const all = Object.values(os.networkInterfaces())
		.flat()
		.filter((n) => n && n.family === "IPv4" && !n.internal)
		.map((n) => (n as os.NetworkInterfaceInfo).address);
	return [...new Set([primary, ...all])].filter((a) => a && a !== "0.0.0.0");
}

/** Every LAN-reachable IPv4 this machine holds, the internet-facing one
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
//  Docker (Bun.$)

/** docker compose in the current project. */
export function dc(...args: string[]) {
	return $`docker compose ${args}`;
}

/** The federation Router is its own compose project, so it needs the file and project name that
 * `start-federation.sh` uses; a bare `docker compose` here would target the gateway instead. */
export function dcFederation(...args: string[]) {
	return $`docker compose -f docker-compose.federation.yml -p switchboard-federation ${args}`;
}

/** Create a docker network unless it already exists.
 *
 * `switchboard-federation` is declared EXTERNAL by both compose files, so compose refuses to start
 * anything when it is missing rather than creating it. On the Router's own machine something has
 * always made it first; on a machine that only runs a gateway, nothing had, and `compose up` failed
 * with "declared as external, but could not be found". Every path that brings a container up owns
 * this, not just the start scripts. */
export async function ensureNetwork(name: string): Promise<void> {
	const exists = await $`docker network inspect ${name}`.quiet().nothrow();
	if (exists.exitCode !== 0) await $`docker network create ${name}`.quiet().nothrow();
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
