// The daemon's half of the `windows` spawn point: whether this machine can offer one, and how a
// path reaches PowerShell.
//
// Daemon-side rather than in `host-spawn.ts` because only the machine running the daemon can probe
// itself, and because both halves shell out. The registry stays a pure leaf the gateway can read.
//
// Every rule here is measured on a WSL box, not reasoned.

import { execFileSync } from "node:child_process";
import { isSpawnWorkdirPath } from "../../shared/host-op.js";
import { isUncPath, WINDOWS_SPAWN } from "../../shared/host-spawn.js";

////////////////////////////////
//  Interfaces & Types

export interface WindowsSpawnAvailability {
	available: boolean;
	/** `$env:USERPROFILE`, the Windows-side default working directory. A Windows session must never
	 * fall back to the WSL home, which translates to a UNC path. */
	userProfile?: string;
	/** Why it is unavailable, for the log. Never surfaced to a caller as a target. */
	reason?: string;
}

////////////////////////////////
//  Functions & Helpers

const PROBE_TIMEOUT_MS = 20_000;

function run(file: string, args: string[]): string | null {
	try {
		return execFileSync(file, args, {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/**
 * Whether this machine can offer a `windows` spawn point.
 *
 * Probes for the AGENT, not just the shell. Finding `powershell.exe` proves an interpreter exists
 * and says nothing about whether an agent can run in it; offering the target without that produces a
 * guaranteed failed wake AFTER tmux state already exists, which is the worst moment to find out.
 *
 * `claude.exe` by full name, deliberately: bare `claude` and `claude.cmd` do not resolve from
 * Windows PowerShell, so a probe for the bare name reports the feature impossible on a machine where
 * it works.
 *
 * One PowerShell invocation for both facts, since its startup is what costs (~0.36s measured) rather
 * than the work. `-NoProfile` so a user's profile cannot change the answer.
 */
export function probeWindowsSpawn(): WindowsSpawnAvailability {
	const out = run("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		'$c = Get-Command claude.exe -ErrorAction SilentlyContinue; if ($c) { Write-Output "claude=$($c.Source)" }; Write-Output "profile=$env:USERPROFILE"',
	]);
	if (out == null) return { available: false, reason: `powershell.exe did not run` };
	const claude = /^claude=(.+)$/m.exec(out)?.[1]?.trim();
	if (!claude) return { available: false, reason: `claude.exe is not on the Windows PATH` };
	const userProfile = /^profile=(.+)$/m.exec(out)?.[1]?.trim();
	if (!userProfile || isUncPath(userProfile)) {
		return { available: false, reason: `unusable Windows home ${userProfile ?? "(none)"}` };
	}
	return { available: true, userProfile };
}

/**
 * A Windows working directory for a `windows` session, or null with a reason.
 *
 * REFUSES rather than translating a Linux path, and that is the whole point. `wslpath -w` happily
 * turns `~` into `\\wsl.localhost\Ubuntu\home\user`, which PowerShell accepts as a provider path, so
 * a naive translation looks like it worked. But Windows PowerShell cannot hand a UNC cwd to a legacy
 * console app: a subprocess silently gets C:\Windows instead, and cmd.exe refuses UNC outright. It
 * works in a probe and dies confusingly weeks later.
 *
 * So a hint that lands on a UNC is a category error for a Windows session and is reported, naming
 * the shape that works. No hint at all takes the Windows home, never the WSL one.
 */
export function resolveWindowsWorkdir(
	hint: string | undefined,
	userProfile: string,
): { workdir: string } | { error: string } {
	// A hint is not necessarily a PATH. `SessionStore.hostWorkdirHint` falls back to the session
	// LABEL, so a session created without picking a directory arrives here carrying its own name.
	// That is deliberate for the host spawn point, where `resolveHostWorkdir` looks a bare label up
	// against the project roots. A label means nothing to Windows, and handing one to `wslpath -w`
	// either fails or translates something nobody asked for, so it falls back the same as no hint at
	// all. Without this the documented "blank picker means the Windows home" is unreachable, because
	// blank never actually arrives.
	if (!hint || !isPathShaped(hint)) return { workdir: userProfile };
	// Either shape is accepted, because both reach here legitimately. The directory browser walks
	// Windows and yields `C:/...`, while a caller may still name a `/mnt/c/...` path. Feeding an
	// already-Windows path back through `wslpath -w` is not reliably a no-op, so a drive-letter path
	// is recognised and passed through instead.
	const translated = WINDOWS_DRIVE_PATH.test(hint) ? hint : run("wslpath", ["-w", hint])?.trim();
	if (!translated) return { error: `"${hint}" could not be translated to a Windows path` };
	if (isUncPath(translated)) {
		return {
			error: `"${hint}" is on the Linux side of this machine (${translated}). A windows session needs a Windows directory, such as /mnt/c/Users/you/project.`,
		};
	}
	// Same guard the bash builder applies: either quote would break out of the nesting, and here it
	// would break out of the PowerShell single-quoted Set-Location argument.
	if (translated.includes("'") || translated.includes('"')) {
		return { error: `"${hint}" translates to a path containing a quote, which cannot be launched` };
	}
	return { workdir: translated };
}

/** The spawn ids this machine offers beyond the always-available ones. */
export function detectedHostSpawns(probe: WindowsSpawnAvailability): string[] {
	return probe.available ? [WINDOWS_SPAWN] : [];
}

/** A wire bound, matching listHostDirs'. */
const MAX_DIR_ENTRIES = 5000;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** Whether a workdir hint names a PATH rather than a label. Mirrors `resolveHostWorkdir`'s own
 * label-versus-path test, which is shape-based for the same reason: a label carries no separator. */
function isPathShaped(hint: string): boolean {
	return WINDOWS_DRIVE_PATH.test(hint) || hint.startsWith("/") || hint === "~" || hint.startsWith("~/");
}

/**
 * Immediate subdirectories of a WINDOWS directory, listed by Windows itself.
 *
 * Browsing `/mnt/c` from the Linux side was the cheap alternative and is wrong: the picker would
 * happily offer `/home/you/...`, which the launch then refuses, so it presents choices that cannot
 * work. It also cannot see a network drive, since only auto-mounted fixed drives appear under /mnt.
 * Listing through PowerShell costs one interpreter start (~0.36s) and removes both.
 *
 * `-Force` includes hidden and system directories, which is what a file picker should show on a
 * platform where plenty of real working directories are hidden. `-ErrorAction SilentlyContinue`
 * because an unreadable subdirectory is a normal condition, not a reason to fail the listing.
 *
 * Empty rather than throwing, matching listHostDirs: this feeds a type-ahead, which has no use for
 * the reason.
 */
/**
 * The wire spelling for "list this machine's drives".
 *
 * A Windows session has no home the picker can imply, so an EMPTY field browses the drives and every
 * listing below one is drive-rooted, which is the only shape `resolveWindowsWorkdir` accepts. The
 * op's path cannot be empty, and no real path names the drive list, so `/` carries it: on the windows
 * spawn it is already a POSIX shape that would otherwise list whichever drive happens to be current.
 */
export const WINDOWS_DRIVE_ROOT = "/";

/** Drive letters as `C:`, so the tap that appends "/" yields a rooted `C:/`. */
export function parseWindowsDriveNames(out: string): string[] {
	return out
		.split("\n")
		.map((line) => line.replace(/\r$/, "").trim())
		.filter((line) => /^[A-Za-z]$/.test(line))
		.map((line) => `${line.toUpperCase()}:`)
		.sort();
}

function listWindowsDrives(): { entries: string[] } {
	const out = run("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		"Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name }",
	]);
	return { entries: out == null ? [] : parseWindowsDriveNames(out) };
}

export function listWindowsDirs(rawPath: string): { entries: string[]; truncated?: boolean } {
	if (rawPath === WINDOWS_DRIVE_ROOT) return listWindowsDrives();
	// The daemon re-guards with the SAME rule the gateway boundary applied, rather than a narrower
	// hand-rolled quote check: the convention here is that a path is gateway-validated and the daemon
	// re-guards, and two different rules for one question is what this whole change spent the day
	// removing. It rejects quotes, control characters and the rest of WORKDIR_PATH_FORBIDDEN.
	//
	// PowerShell single quotes do not interpolate, so `$(...)`, backtick and `$var` inside them are
	// already literal, and `-LiteralPath` stops the remainder being read as a wildcard pattern. The
	// one character that WOULD end the string early is `'`, which the shared rule forbids. No shell is
	// involved on this side: execFile passes argv directly, never through sh.
	if (!isSpawnWorkdirPath(WINDOWS_SPAWN, rawPath)) return { entries: [] };
	const out = run("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		`Get-ChildItem -LiteralPath '${rawPath}' -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }`,
	]);
	if (out == null) return { entries: [] };
	const entries = out
		// Only the line ending is stripped, never leading whitespace: a directory may legitimately
		// begin with a space on Windows, and trimming both ends would hand back a name that does not
		// exist. `listHostDirs` does not trim at all, and this is as close to that as a line-oriented
		// reader can get.
		.split("\n")
		.map((line) => line.replace(/\r$/, "").replace(/\s+$/, ""))
		.filter((line) => line.length > 0)
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
	if (entries.length > MAX_DIR_ENTRIES) return { entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: true };
	return { entries };
}
