// Whether a backend's CLI is installed. Installing the binary IS the opt-in, so this one answer gates
// the daemon's capability declaration and the plugin's tool registration alike.

import fs from "node:fs";
import path from "node:path";
import type { AgentBackendDescriptor } from "./agent-backend.js";

////////////////////////////////
//  Functions & Helpers

/** PATH entries, split on the platform's separator. An empty entry means the working directory on
 * POSIX, which is never a place to find a trusted CLI, so it is dropped rather than resolved. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
	return (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
}

/** The suffixes a bare name may carry. POSIX has none; Windows resolves through PATHEXT, and a
 * missing one there would only ever find an extensionless file that Windows cannot execute. */
function executableSuffixes(env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return [""];
	const configured = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0);
	return ["", ...configured];
}

/**
 * Whether `name` resolves to an executable on PATH.
 *
 * Deliberately not `which`/`where`: this runs during startup, and spawning a process per backend
 * costs a beat on every session start and needs a shell on Windows. An unreadable PATH entry is
 * skipped rather than thrown, since one bad directory must not hide a binary in the next.
 *
 * Deliberately uncached. A handful of `stat` calls twice per process is not worth an answer that
 * outlives the PATH it was read from, and a cached hit makes one caller's probe decide another's.
 */
export function isBinaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	for (const dir of pathEntries(env)) {
		for (const suffix of executableSuffixes(env)) {
			try {
				fs.accessSync(path.join(dir, name + suffix), fs.constants.X_OK);
				return true;
			} catch {
				// Absent, or not executable by this user. Either way it is not this backend's CLI.
			}
		}
	}
	return false;
}

export function isAgentBackendInstalled(
	backend: AgentBackendDescriptor,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return isBinaryOnPath(backend.binaryName, env);
}
