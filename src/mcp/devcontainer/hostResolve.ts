import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReservedHostSession, isTmuxName, type TmuxTarget } from "../../shared/host-op.js";
import { buildHostLaunch, isHostSpawn } from "../../shared/host-spawn.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();
let projectDirs: string[] = [path.join(HOME, "projects")];

/** An empty list leaves the current roots. */
export function setProjectDirs(dirs: string[]): void {
	if (dirs.length > 0) projectDirs = dirs;
}

////////////////////////////////
//  Catalog scanner

export function scanDevcontainerProjects(): Array<{ team: string; projectPath: string }> {
	const results: Array<{ team: string; projectPath: string }> = [];
	for (const dir of projectDirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
		let entries: string[];
		try {
			entries = fs.readdirSync(resolved);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(resolved, entry);
			// A directory named after a host spawn point would make `windows.<session>` mean two
			// different things - a PowerShell shell and a devcontainer - and `isHostSpawn` would win
			// at every resolver while catalog membership disagreed. Refused at the scan so the
			// ambiguity never enters the catalog at all.
			if (isHostSpawn(entry)) continue;
			try {
				if (!fs.statSync(full).isDirectory()) continue;
				if (fs.existsSync(path.join(full, ".devcontainer", "devcontainer.json"))) {
					results.push({ team: entry, projectPath: full });
				}
			} catch {
				// skip inaccessible entries
			}
		}
	}
	return results;
}

////////////////////////////////
//  Workdir resolution

export function findProjectPath(team: string): string {
	for (const dir of projectDirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
		const candidate = path.join(resolved, team);
		if (fs.existsSync(path.join(candidate, ".devcontainer", "devcontainer.json"))) {
			return candidate;
		}
	}
	return path.join(projectDirs[0], team);
}

/** Null for any other shape, so a label is never treated as a path. */
function expandWorkdirPath(value: string, home: string): string | null {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value.startsWith("/") ? value : null;
}

/** A picked path or a label hint, told apart by shape: a label holds no separator. The quote guard
 * mirrors buildLaunchCommand's. Anything unresolvable lands in home. */
export function resolveHostWorkdir(
	hint: string | undefined,
	dirs: string[] = projectDirs,
	home: string = HOME,
): string {
	if (!hint) return home;
	const picked = expandWorkdirPath(hint, home);
	if (picked != null) {
		if (/['"`$\\]/.test(picked)) return home;
		try {
			if (fs.statSync(picked).isDirectory()) return picked;
		} catch {
			// deleted or unreadable since it was picked
		}
		return home;
	}
	if (hint === "." || hint === ".." || hint.includes("/") || hint.includes("\\")) return home;
	for (const dir of dirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(home, dir);
		const candidate = path.join(resolved, hint);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// missing or not a dir, try the next base
		}
	}
	return home;
}

// A wire bound, not a UX cap.
const MAX_DIR_ENTRIES = 5000;

/** Immediate subdirectories, sorted case-insensitively. Empty rather than erroring: this feeds an
 * autocomplete, which has no use for the reason. */
export function listHostDirs(rawPath: string, home: string = HOME): { entries: string[]; truncated?: boolean } {
	const resolved = expandWorkdirPath(rawPath, home);
	if (resolved == null) return { entries: [] };
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(resolved, { withFileTypes: true });
	} catch {
		return { entries: [] };
	}
	const entries: string[] = [];
	for (const d of dirents) {
		let isDir = d.isDirectory();
		if (!isDir && d.isSymbolicLink()) {
			try {
				isDir = fs.statSync(path.join(resolved, d.name)).isDirectory();
			} catch {
				// dangling symlink
			}
		}
		if (isDir) entries.push(d.name);
	}
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
	if (entries.length > MAX_DIR_ENTRIES) return { entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: true };
	return { entries };
}

////////////////////////////////
//  Launch command

const CLAUDE_FLAGS =
	"--dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium";

// One `bash -c`: the PROJECT_NAME override must run in the same shell as claude, after ~/.bashrc.
// A host target dispatches on its spawn NAME through the registry, which is what lets a machine
// offer more than one shell; `kind` stays the tmux LOCATION (bare tmux here, `docker exec` there)
// and says nothing about which interpreter runs. A second field naming the shell would have to agree
// with the name forever, so there isn't one.
export function buildLaunchCommand(
	target: TmuxTarget,
	opts: { resumeSessionId?: string; workdir?: string; sessionToken?: string } = {},
): string {
	const composite = composeSessionName(target.name, target.sessionName);
	const resume =
		opts.resumeSessionId && /^[0-9a-fA-F-]{8,}$/.test(opts.resumeSessionId)
			? ` --resume ${opts.resumeSessionId}`
			: "";
	// Refused, not dropped: a session that cannot claim its name is harder to diagnose.
	if (opts.sessionToken && !/^[0-9a-f]{16,}$/.test(opts.sessionToken)) {
		throw new Error("refusing to launch: session token is not the expected hex form");
	}
	const exportToken = opts.sessionToken ? `export SWITCHBOARD_SESSION_TOKEN=${opts.sessionToken}; ` : "";
	// Everything after argv[0]. The binary itself belongs to the spawn point: a Windows session runs
	// `claude.exe`, since bare `claude` does not resolve from PowerShell.
	const claudeArgs = `--model opus --effort xhigh ${CLAUDE_FLAGS}${resume}`;
	if (target.kind === "host") {
		// Either quote would break out of the nesting, so a workdir bearing one is dropped.
		const safeWorkdir = opts.workdir && !opts.workdir.includes("'") && !opts.workdir.includes('"');
		return buildHostLaunch(target.name, {
			composite,
			claudeArgs,
			exportToken,
			workdir: safeWorkdir ? opts.workdir : undefined,
		});
	}
	return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${exportToken}cd /workspace/${target.name}; exec claude ${claudeArgs}'`;
}

////////////////////////////////
//  First-launch greeting

export const FIRST_LAUNCH_GREETING = "welcome, see your switchboard capabilities";

// Wake reports created too.
export function shouldGreetLaunch(opts: { created: boolean; resumeSessionId?: string; ready: boolean }): boolean {
	return opts.created && opts.ready && !opts.resumeSessionId;
}

////////////////////////////////
//  Watch target resolution

// No bring-up: a watched team is already live.
export function resolveWatchTarget(team: string): TmuxTarget | undefined {
	const { project, session } = parseSessionName(team);
	if (!isTmuxName(project) || !isTmuxName(session)) return undefined;
	// Registry-wide, so the daemon's reserved session is refused under EVERY host spawn point
	// (`windows.host-daemon` as much as `host.host-daemon`) rather than only the one named here.
	if (isHostSpawn(project)) {
		if (isReservedHostSession(session)) return undefined;
		return { kind: "host", name: project, sessionName: session };
	}
	return { kind: "devcontainer", name: project, sessionName: session };
}
