import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendBuildTranscript, beginBuildTranscript } from "./buildTranscript.js";

////////////////////////////////
//  Interfaces & Types

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

// Project validation

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
		// Non-fatal. Compose project may not exist yet.
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

// The CLI writes everything else.
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

	// Idempotent: adds the marketplace if missing, then installs each plugin.
	const installSteps = [
		`claude plugin marketplace add ${MARKETPLACE_SOURCE} 2>/dev/null || true`,
		...PLUGINS.map((p) => `claude plugin install ${p.name}@${p.marketplace}`),
	].join(" && ");

	execSync(`"${bin}" exec --workspace-folder "${projectPath}" bash -lc "${installSteps.replace(/"/g, '\\"')}"`, {
		encoding: "utf-8",
		timeout: 120_000,
	});

	// jq-merge autoUpdate into the entry the CLI wrote, and nyaascripts into ~/.claude.json.
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

// The CLI's JSON answer is the last stdout line; earlier output is progress.
const STDOUT_TAIL_CHARS = 65_536;

/** One CLI run, both streams into the project's transcript as they arrive. */
function runDevcontainer(project: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
	appendBuildTranscript(project, `$ devcontainer ${args.join(" ")}\n`);
	return new Promise((resolve) => {
		const child = spawn(devcontainerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout = (stdout + text).slice(-STDOUT_TAIL_CHARS);
			appendBuildTranscript(project, text);
		});
		child.stderr.on("data", (chunk: Buffer) => appendBuildTranscript(project, chunk.toString("utf8")));
		child.on("error", (error) => {
			appendBuildTranscript(project, `${error.message}\n`);
			resolve({ code: null, stdout });
		});
		child.on("close", (code) => resolve({ code, stdout }));
	});
}

export async function ensureContainerUpAsync(projectPath: string): Promise<ContainerUpResult> {
	if (isContainerReady(projectPath)) return { wasAlreadyRunning: true, pluginsProvisioned: false };

	const project = path.basename(projectPath);
	beginBuildTranscript(project);
	teardownContainer(projectPath);

	const up = await runDevcontainer(project, ["up", "--workspace-folder", projectPath, "--remove-existing-container"]);
	if (up.code !== 0) throw new Error(`devcontainer up failed for '${projectPath}' (exit ${up.code ?? "signal"})`);
	parseDevcontainerOutput(up.stdout, projectPath);

	const lifecycle = await runDevcontainer(project, ["run-user-commands", "--workspace-folder", projectPath]);
	if (lifecycle.code !== 0) console.error(`[devcontainer] run-user-commands failed for '${projectPath}' (non-fatal)`);

	let pluginsProvisioned = false;
	if (!hasPluginSettings(projectPath)) {
		try {
			provisionPluginSettings(projectPath);
			pluginsProvisioned = true;
		} catch (e) {
			const message = (e as Error).message;
			console.error(`[devcontainer] plugin provisioning failed: ${message}`);
			appendBuildTranscript(project, `[plugins] ${message}\n`);
		}
	}
	return { wasAlreadyRunning: false, pluginsProvisioned };
}
