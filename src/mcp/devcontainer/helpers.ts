import { exec, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export interface ExecInContainerParams {
	projectPath: string;
	command: string[];
	timeoutMs?: number;
	stdin?: string;
}

export interface ContainerUpResult {
	wasAlreadyRunning: boolean;
	pluginsProvisioned: boolean;
}

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();

// Devcontainer CLI discovery

let cachedBin: string | null = null;

function findDevcontainerBin(): string {
	const candidates = [path.join(HOME, ".devcontainers/bin/devcontainer"), "/usr/local/bin/devcontainer"];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	try {
		return execSync("which devcontainer", { encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		throw new Error(`devcontainer CLI not found.`);
	}
}

function devcontainerBin(): string {
	if (!cachedBin) cachedBin = findDevcontainerBin();
	return cachedBin;
}

// Environment & project validation

export function assertNotContainer(): void {
	if (fs.existsSync("/.dockerenv") || process.env.REMOTE_CONTAINERS) {
		throw new Error(`This tool runs on the host, not inside a container.`);
	}
}

export function resolveProject(projectPath: string): string {
	if (projectPath.includes("..")) {
		throw new Error(`Path must not contain '..'.`);
	}
	const resolved = path.isAbsolute(projectPath) ? projectPath : path.join(HOME, projectPath);
	if (!fs.existsSync(resolved)) {
		throw new Error(`Project not found: ${resolved}`);
	}
	if (!fs.existsSync(path.join(resolved, ".devcontainer", "devcontainer.json"))) {
		throw new Error(`No .devcontainer/devcontainer.json in ${resolved}`);
	}
	return resolved;
}

// Container lifecycle

function teardownContainer(projectPath: string): void {
	const projectName = path.basename(projectPath);
	const composeName = `${projectName}_devcontainer`;
	try {
		execSync(`docker compose -p "${composeName}" down --remove-orphans`, {
			encoding: "utf-8",
			stdio: "pipe",
		});
	} catch {
		// non-fatal — compose project may not exist yet
	}
	try {
		execSync(`docker network ls --filter "name=${composeName}" -q | xargs -r docker network rm`, {
			encoding: "utf-8",
			shell: "/bin/bash",
			stdio: "pipe",
		});
	} catch {
		// non-fatal
	}
}

function parseDevcontainerOutput(output: string, projectPath: string): void {
	const lines = output.trim().split("\n");
	const lastLine = lines[lines.length - 1];
	try {
		const result = JSON.parse(lastLine);
		if (result.outcome !== "success") {
			throw new Error(`devcontainer up returned outcome '${result.outcome}' for '${projectPath}'.`);
		}
	} catch (e) {
		if (e instanceof SyntaxError) {
			throw new Error(`devcontainer up returned unexpected output for '${projectPath}':\n${lastLine}`);
		}
		throw e;
	}
}

function isContainerReady(projectPath: string): boolean {
	try {
		execSync(`"${devcontainerBin()}" exec --workspace-folder "${projectPath}" echo ok`, {
			timeout: 15_000,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

const PLUGINS = [
	{ name: "switchboard", marketplace: "atelier-nyaarium" },
	{ name: "nyaaskills", marketplace: "atelier-nyaarium" },
];

const MARKETPLACE_SOURCE = "atelier-nyaarium/claude-marketplace";

// Sets autoUpdate:true on the marketplace entry after `claude plugin install` creates it.
// Everything else (enabledPlugins, marketplace source, installed_plugins.json) is written
// by the CLI — this patch just flips the autoUpdate flag we want.
const AUTOUPDATE_PATCH = JSON.stringify({
	extraKnownMarketplaces: {
		"atelier-nyaarium": { autoUpdate: true },
	},
});

const MCP_SERVERS = JSON.stringify({
	mcpServers: {
		nyaascripts: {
			type: "stdio",
			command: "/home/vscode/scripts/nyaascripts",
			args: [],
			env: {},
		},
	},
});

function hasPluginSettings(projectPath: string): boolean {
	try {
		const result = execSync(
			`"${devcontainerBin()}" exec --workspace-folder "${projectPath}" bash -c "jq -e '.plugins[\\"switchboard@atelier-nyaarium\\"]' /home/vscode/.claude/plugins/installed_plugins.json 2>/dev/null"`,
			{ encoding: "utf-8", timeout: 10_000, stdio: "pipe" },
		);
		return result.trim().length > 0 && result.trim() !== "null";
	} catch {
		return false;
	}
}

function provisionPluginSettings(projectPath: string): void {
	const bin = devcontainerBin();
	const settingsPath = "/home/vscode/.claude/settings.json";
	const claudeJson = "/home/vscode/.claude.json";

	// Step 1: CLI install (idempotent; adds marketplace if missing, then installs each plugin).
	// These write to installed_plugins.json, known_marketplaces.json, and flip enabledPlugins in settings.json.
	const installSteps = [
		`claude plugin marketplace add ${MARKETPLACE_SOURCE} 2>/dev/null || true`,
		...PLUGINS.map((p) => `claude plugin install ${p.name}@${p.marketplace}`),
	].join(" && ");

	execSync(`"${bin}" exec --workspace-folder "${projectPath}" bash -lc "${installSteps.replace(/"/g, '\\"')}"`, {
		encoding: "utf-8",
		timeout: 120_000,
	});

	// Step 2: jq-merge the autoUpdate flag into the marketplace entry the CLI just wrote,
	// plus the nyaascripts mcpServer into ~/.claude.json.
	const autoUpdateJq = `'(if . == null then {} else . end) * ${AUTOUPDATE_PATCH.replace(/'/g, "'\\''")}'`;
	const settingsCmd = [
		`(cat ${settingsPath} 2>/dev/null || echo '{}') | jq ${autoUpdateJq} > /tmp/claude-settings.json`,
		`mv /tmp/claude-settings.json ${settingsPath}`,
	].join(" && ");

	const mcpJqScript = `'(if . == null then {} else . end) * ${MCP_SERVERS.replace(/'/g, "'\\''")}'`;
	const mcpCmd = [
		`(cat ${claudeJson} 2>/dev/null || echo '{}') | jq ${mcpJqScript} > /tmp/claude-json.tmp`,
		`mv /tmp/claude-json.tmp ${claudeJson}`,
	].join(" && ");

	const cmd = `${settingsCmd} && ${mcpCmd}`;
	execSync(`"${bin}" exec --workspace-folder "${projectPath}" bash -c "${cmd.replace(/"/g, '\\"')}"`, {
		encoding: "utf-8",
		timeout: 10_000,
	});
	console.log(`[devcontainer] provisioned plugins for '${projectPath}'`);
}

export function ensureContainerUp(projectPath: string): ContainerUpResult {
	if (isContainerReady(projectPath)) {
		return { wasAlreadyRunning: true, pluginsProvisioned: false };
	}

	teardownContainer(projectPath);

	const bin = devcontainerBin();

	let output: string;
	try {
		output = execSync(`"${bin}" up --workspace-folder "${projectPath}" --remove-existing-container`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`devcontainer up failed for '${projectPath}':\n${msg}`);
	}

	parseDevcontainerOutput(output, projectPath);

	// Run lifecycle commands (postCreateCommand, postStartCommand) so the
	// home directory gets provisioned and plugins are available.
	try {
		execSync(`"${bin}" run-user-commands --workspace-folder "${projectPath}"`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch {
		console.error(`[devcontainer] run-user-commands failed for '${projectPath}' (non-fatal)`);
	}

	let pluginsProvisioned = false;
	if (!hasPluginSettings(projectPath)) {
		try {
			provisionPluginSettings(projectPath);
			pluginsProvisioned = true;
		} catch (e) {
			console.error(`[devcontainer] plugin provisioning failed: ${(e as Error).message}`);
		}
	}

	return { wasAlreadyRunning: false, pluginsProvisioned };
}

export function ensureContainerUpAsync(projectPath: string): Promise<ContainerUpResult> {
	if (isContainerReady(projectPath)) {
		return Promise.resolve({ wasAlreadyRunning: true, pluginsProvisioned: false });
	}

	teardownContainer(projectPath);

	const bin = devcontainerBin();

	return new Promise((resolve, reject) => {
		exec(
			`"${bin}" up --workspace-folder "${projectPath}" --remove-existing-container`,
			{ encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(new Error(`devcontainer up failed for '${projectPath}':\n${error.message}`));
					return;
				}

				try {
					parseDevcontainerOutput(stdout, projectPath);
				} catch (e) {
					reject(e);
					return;
				}

				// Run lifecycle commands (postCreateCommand, postStartCommand)
				exec(
					`"${bin}" run-user-commands --workspace-folder "${projectPath}"`,
					{ encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
					(lcError) => {
						if (lcError) {
							console.error(`[devcontainer] run-user-commands failed for '${projectPath}' (non-fatal)`);
						}

						let pluginsProvisioned = false;
						if (!hasPluginSettings(projectPath)) {
							try {
								provisionPluginSettings(projectPath);
								pluginsProvisioned = true;
							} catch (e) {
								console.error(`[devcontainer] plugin provisioning failed: ${(e as Error).message}`);
							}
						}

						resolve({ wasAlreadyRunning: false, pluginsProvisioned });
					},
				);
			},
		);
	});
}

// Container execution

export function execInContainer({
	projectPath,
	command,
	timeoutMs = 120000,
	stdin,
}: ExecInContainerParams): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(devcontainerBin(), ["exec", "--workspace-folder", projectPath, ...command], {
			timeout: timeoutMs,
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d));
		proc.stderr.on("data", (d: Buffer) => (stderr += d));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				const msg = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || "(no output)";
				reject(new Error(`Exit ${code}: ${msg}`));
			}
		});

		if (stdin != null) {
			proc.stdin.write(stdin);
			proc.stdin.end();
		}
	});
}
