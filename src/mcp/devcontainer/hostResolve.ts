import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkdir, type WorkdirContext, workdirOrFallback } from "../../shared/agent-workdir.js";
import { type HostListDirsResult, isReservedHostSession, isTmuxName, type TmuxTarget } from "../../shared/host-op.js";
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

/** This machine's roots and home, for anything asking the shared resolver a question about it. */
export function hostWorkdirContext(dirs: string[] = projectDirs, home: string = HOME): WorkdirContext {
	return { roots: dirs, home };
}

/** The daemon's binding of the shared rule. It contributes the one thing that legitimately differs
 * per machine - which roots a bare label is looked up under - and nothing else: the grammar and the
 * fallback belong to `agent-workdir.ts`, so the daemonless path cannot read the same string
 * differently. Still answers a bare directory, since reporting a refusal instead is a change to a
 * contract `codexTools` documents to callers and ships separately. */
export function resolveHostWorkdir(
	hint: string | undefined,
	dirs: string[] = projectDirs,
	home: string = HOME,
): string {
	return workdirOrFallback(resolveWorkdir(hint, "sessionWorkdirHint", hostWorkdirContext(dirs, home)));
}

// A wire bound, not a UX cap.
const MAX_DIR_ENTRIES = 5000;

/** Immediate subdirectories, sorted case-insensitively. Empty rather than erroring: this feeds an
 * autocomplete, which has no use for the reason.
 *
 * A blank path is this machine's home, and the answer says so: the caller asked for the default
 * directory without knowing its spelling, so the names alone would not tell it where they sit. */
export function listHostDirs(rawPath: string, home: string = HOME): HostListDirsResult {
	const blank = rawPath.length === 0;
	const resolved = blank ? home : expandWorkdirPath(rawPath, home);
	if (resolved == null) return { entries: [] };
	const where = blank ? { path: resolved } : {};
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
	if (entries.length > MAX_DIR_ENTRIES) {
		return { entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: true, ...where };
	}
	return { entries, ...where };
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
	opts: { resumeSessionId?: string; workdir?: string; sessionToken?: string; pathPrefix?: string } = {},
): string {
	const composite = composeSessionName(target.name, target.sessionName);
	const resume =
		opts.resumeSessionId && /^[0-9a-fA-F-]{8,}$/.test(opts.resumeSessionId)
			? ` --resume ${opts.resumeSessionId}`
			: "";
	// Refused, not dropped: a session that cannot claim its name is harder to diagnose.
	if (opts.sessionToken && !/^[0-9a-f]{16,}$/.test(opts.sessionToken)) {
		throw new Error(`refusing to launch: session token is not the expected hex form`);
	}
	const exportToken = opts.sessionToken ? `export SWITCHBOARD_SESSION_TOKEN=${opts.sessionToken}; ` : "";
	// Everything after argv[0]. The binary itself belongs to the spawn point: a Windows session runs
	// `claude.exe`, since bare `claude` does not resolve from PowerShell.
	const claudeArgs = `--model opus --effort xhigh ${CLAUDE_FLAGS}${resume}`;
	if (target.kind === "host") {
		// Either quote would break out of the nesting, so a workdir bearing one is dropped.
		const safeWorkdir = opts.workdir && !opts.workdir.includes("'") && !opts.workdir.includes('"');
		// Dropped unless it is a plain absolute path, for the same reason.
		const safePathPrefix = opts.pathPrefix && /^\/[A-Za-z0-9_./-]+$/.test(opts.pathPrefix);
		return buildHostLaunch(target.name, {
			composite,
			claudeArgs,
			exportToken,
			workdir: safeWorkdir ? opts.workdir : undefined,
			pathPrefix: safePathPrefix ? opts.pathPrefix : undefined,
		});
	}
	return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${exportToken}cd /workspace/${target.name}; exec claude ${claudeArgs}'`;
}

////////////////////////////////
//  First-launch greeting

export const FIRST_LAUNCH_GREETING = `welcome, see your switchboard capabilities`;

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
