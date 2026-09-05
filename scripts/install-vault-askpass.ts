// Installs the askpass helper for this owner.
//
//   bun scripts/install-vault-askpass.ts [--gateway http://127.0.0.1:20000]

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "main-vault-askpass.js");
const HOME = os.homedir();
const SHARE_DIR = path.join(HOME, ".local", "share", "switchboard");
const CONFIG_DIR = path.join(HOME, ".config", "switchboard");
const BIN = path.join(HOME, ".local", "bin", "vault-askpass");
const TOKEN_FILE = path.join(CONFIG_DIR, "vault-askpass.token");
const DEFAULT_GATEWAY = "http://127.0.0.1:20000";

const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Absolute paths, for a caller that resets HOME or PATH. */
function wrapper(gateway: string): string {
	const exports = [`export VAULT_ASKPASS_TOKEN_FILE=${quoted(TOKEN_FILE)}`];
	if (gateway !== DEFAULT_GATEWAY) exports.push(`export BRIDGE_ROUTER_URL=${quoted(gateway)}`);
	return [
		"#!/usr/bin/env bash",
		`BUN=${quoted(process.execPath)}`,
		'[ -x "$BUN" ] || BUN="$(command -v bun 2>/dev/null)"',
		`[ -x "$BUN" ] || BUN="\${BUN_INSTALL:-${quoted(path.join(HOME, ".bun"))}}/bin/bun"`,
		'if [ ! -x "$BUN" ]; then',
		'\techo "vault-askpass: bun not found" >&2',
		"\texit 1",
		"fi",
		...exports,
		`exec "$BUN" ${quoted(path.join(SHARE_DIR, "main-vault-askpass.js"))} "$@"`,
		"",
	].join("\n");
}

function hostToken(): string {
	const env = readFileSync(path.join(ROOT, ".env"), "utf8");
	const line = env.split("\n").find((entry) => entry.startsWith("HOST_WS_TOKEN="));
	const token = line?.slice("HOST_WS_TOKEN=".length).trim();
	if (!token) throw new Error("HOST_WS_TOKEN is not in .env; run ./start-gateway.sh first");
	return token;
}

async function mint(gateway: string): Promise<{ tokenId: string; token: string }> {
	let response: Response;
	try {
		response = await fetch(`${gateway}/vault/helper-token`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-host-token": hostToken() },
			body: "{}",
		});
	} catch {
		throw new Error(`no gateway answers at ${gateway}; run ./start-gateway.sh, or pass --gateway`);
	}
	const body = (await response.json().catch(() => null)) as {
		tokenId?: string;
		token?: string;
		error?: string;
	} | null;
	if (!response.ok || !body?.token || !body.tokenId) {
		throw new Error(`the gateway refused to mint a helper token: ${body?.error ?? response.status}`);
	}
	return { tokenId: body.tokenId, token: body.token };
}

function gatewayArg(argv: string[]): string {
	const flag = argv.indexOf("--gateway");
	const raw = flag >= 0 ? argv[flag + 1] : (process.env.BRIDGE_ROUTER_URL ?? DEFAULT_GATEWAY);
	if (!raw || raw.startsWith("-")) throw new Error("--gateway needs a URL");
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`not a gateway URL: ${raw}`);
	return raw.replace(/\/+$/, "");
}

async function main(argv: string[]): Promise<void> {
	const gateway = gatewayArg(argv);
	if (!existsSync(BUNDLE)) throw new Error(`${BUNDLE} is missing; run bun run build --build-only`);

	const minted = await mint(gateway);
	mkdirSync(SHARE_DIR, { recursive: true });
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	chmodSync(CONFIG_DIR, 0o700);
	mkdirSync(path.dirname(BIN), { recursive: true });
	copyFileSync(BUNDLE, path.join(SHARE_DIR, "main-vault-askpass.js"));
	// Created fresh, so the mode holds from the first byte.
	rmSync(TOKEN_FILE, { force: true });
	writeFileSync(TOKEN_FILE, `${minted.token}\n`, { mode: 0o600 });
	writeFileSync(BIN, wrapper(gateway), { mode: 0o755 });
	chmodSync(BIN, 0o755);

	console.log(`Helper token ${minted.tokenId} minted. Revoke it from the phone's Vault tab.`);
	console.log(`token: ${TOKEN_FILE} (0600)`);
	console.log(`helper: ${BIN}`);
	console.log("\nAdd to your shell profile:\n");
	console.log(`  export SUDO_ASKPASS="${BIN}"`);
	console.log(`  export SSH_ASKPASS="${BIN}"`);
	console.log(`  export GIT_ASKPASS="${BIN}"`);
	console.log("\nsudo asks the helper only under -A; plain sudo is unchanged.");
	console.log("ssh asks the helper only when it has no tty. SSH_ASKPASS_REQUIRE=force is optional: with it,");
	console.log("every ssh prompt goes through the helper, which still offers the tty beside the phone.");
}

main(process.argv.slice(2)).catch((err) => {
	console.error(`install failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
