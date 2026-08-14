import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReservedHostSession, isTmuxName, type TmuxTarget } from "../../shared/host-op.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();
let projectDirs: string[] = [path.join(HOME, "projects")];

/** Overrides the search roots for devcontainer/host project and workdir resolution. Mirrors
 * startHostDaemon's own dirs param: an empty list leaves the current roots in place. */
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

/** Expand a ~-rooted path against home; an absolute path passes through. Null for any other
 * shape, so callers cannot accidentally treat a label as a path. */
function expandWorkdirPath(value: string, home: string): string | null {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value.startsWith("/") ? value : null;
}

/** Working directory for a host session. Two forms, distinguished by shape (a label can never
 * contain a separator, see sanitizeLabel):
 *  - a console-picked path (absolute or ~-rooted): used verbatim when it is a real directory. The
 *    quote/backtick/$ guard mirrors buildLaunchCommand's own, so a path that would be dropped
 *    there falls back here already.
 *  - a legacy label hint: the first `<projectDir>/<hint>` that is a real directory (a plain dir,
 *    unlike findProjectPath it does not require a .devcontainer). The hint is the record's human
 *    label (never the opaque session id), so a session created as "myproject" opens in
 *    ~/projects/myproject.
 * Anything else (missing, deleted dir, a `\`, `.`/`..`) lands in home. dirs/home are injectable
 * for tests. */
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

// The wire sanity bound on one listing, far above any real directory. Never a UX cap: the console
// filters locally against whatever arrives, and `truncated` tells it the filter may be incomplete.
const MAX_DIR_ENTRIES = 5000;

/** The listDirs host op: immediate subdirectories of one host directory (dirs and dir symlinks),
 * sorted case-insensitively. Missing/unreadable paths and non-path shapes return empty rather than
 * erroring - this feeds an autocomplete, which has no use for the reason. home injectable for
 * tests. */
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

// The launch command for a session's tmux. The daemon owns it (callers supply only the target +
// optional resume id), so an arbitrary host command can never be injected. The session registers
// under its COMPOSITE name (`project.session`) by overriding PROJECT_NAME AFTER sourcing ~/.bashrc;
// the override must run in the same shell as claude (a prefix on `source` would not survive), so the
// whole chain is one `bash -c`. A host session keeps its pane alive with `exec bash` after Claude
// exits; a devcontainer session opens in its workspace project. The
// target's name/sessionName are slug-validated by callers; the resume id is uuid-shaped and the
// workdir is a resolved fs path, double-quoted for spaces (a workdir bearing a quote is dropped, see
// below).
export function buildLaunchCommand(
	target: TmuxTarget,
	opts: { resumeSessionId?: string; workdir?: string; sessionToken?: string } = {},
): string {
	const composite = composeSessionName(target.name, target.sessionName);
	const resume =
		opts.resumeSessionId && /^[0-9a-fA-F-]{8,}$/.test(opts.resumeSessionId)
			? ` --resume ${opts.resumeSessionId}`
			: "";
	// Hex-only by construction, and re-checked here because it lands inside the `bash -c '...'`
	// string. A malformed one is refused rather than escaped or dropped: launching without it would
	// start a session that can never claim its own name, which is far harder to diagnose than a
	// failed launch.
	if (opts.sessionToken && !/^[0-9a-f]{16,}$/.test(opts.sessionToken)) {
		throw new Error("refusing to launch: session token is not the expected hex form");
	}
	const exportToken = opts.sessionToken ? `export SWITCHBOARD_SESSION_TOKEN=${opts.sessionToken}; ` : "";
	const claude = `claude --model opus --effort xhigh ${CLAUDE_FLAGS}${resume}`;
	if (target.kind === "host") {
		// The workdir is double-quoted for spaces. A single quote would close the outer `bash -c '...'`
		// and a double quote would close the cd's own quoting to run injected commands; a workdir with
		// either is dropped rather than escaped (the agent then starts in the daemon's cwd). The label
		// sanitizer forbids path separators but not quotes, so both are guarded here.
		const safeWorkdir = opts.workdir && !opts.workdir.includes("'") && !opts.workdir.includes('"');
		const cd = safeWorkdir ? `cd "${opts.workdir}"; ` : "";
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${exportToken}${cd}${claude}; exec bash'`;
	}
	return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${exportToken}cd /workspace/${target.name}; exec ${claude}'`;
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

// The composite-parsing mirror of handleWake's own target resolution, without any container
// bring-up: a watched team is by construction already live (the gateway derives its watch list
// from the presence plane's own online/verifying rows), so a peek either finds the pane or fails
// "absent" - the scheduler's own failure-streak handling covers that, no wake needed here.
// Returns undefined for a malformed or reserved-session team, which the caller drops rather than
// watching.
export function resolveWatchTarget(team: string): TmuxTarget | undefined {
	const { project, session } = parseSessionName(team);
	if (!isTmuxName(project) || !isTmuxName(session)) return undefined;
	if (project === "host") {
		if (isReservedHostSession(session)) return undefined;
		return { kind: "host", name: "host", sessionName: session };
	}
	return { kind: "devcontainer", name: project, sessionName: session };
}
