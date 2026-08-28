// What a working-directory hint MEANS, and what happens when it names nothing.
//
// Two resolvers answered this differently and neither said which it had used. `cwd: "recipe-app"`
// was a LABEL on the daemon path, searched under the configured project roots and landing in
// ~/projects/recipe-app; on the daemonless path it was a RELATIVE PATH from the session's own
// directory, landing somewhere that usually did not exist. An unresolvable hint fell back to HOME on
// one and to the session's own directory on the other. Both silently.
//
// Which resolver serves a call is decided by REACHABILITY, not configuration: a session takes the
// daemon's backend when one is declared and runs the child itself otherwise. So the same string
// meant two directories depending on something the caller cannot see and did not choose.
//
// Resolving on the daemon's MACHINE is a real reason for different roots. It was never a reason for
// a different grammar or a different fallback, and this owns both.

import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/**
 * Where a hint came from, which decides whether a bare word is a label at all.
 *
 * Not a boolean. The first shape of this was `allowLabels`, which describes an implementation detail
 * rather than the source, and would have let a caller's working directory quietly acquire the
 * meaning a session label has. These are different things that happen to share a resolver:
 *
 * - `sessionWorkdirHint` is what a session carries. The console sets one from a picked path OR from
 *   the session's display label, deliberately, so a bare word IS meaningful there.
 * - `agentCwd` is what a delegated agent's caller passed. The tool describes it as a working
 *   directory, and a bare word is a project name only because the daemon has always read it that way.
 */
export type WorkdirSource = "sessionWorkdirHint" | "agentCwd";

/** What a hint turns out to be, decided by shape alone. Pure: no filesystem, no machine. */
export type WorkdirShape =
	| { kind: "blank" }
	/** Absolute or `~`-rooted, already expanded against the home it was given. */
	| { kind: "path"; value: string }
	/** A bare word, resolvable only against roots. */
	| { kind: "label"; value: string }
	/** Refused before it reaches a filesystem or a shell. */
	| { kind: "unsafe"; value: string; reason: WorkdirRefusal };

export type WorkdirRefusal =
	/** Nothing was named. */
	| "blank"
	/** Longer than any path this system carries. Its own reason rather than folded into the character
	 * one, which would report a clean but overlong path as holding a forbidden character. */
	| "too-long"
	/** Characters that break out of the shell nesting a launch command is composed through. */
	| "forbidden-characters"
	/** A relative path, which names a different directory depending on where the resolver stands -
	 * the exact ambiguity this module exists to remove. */
	| "relative"
	/** A path that resolved to nothing, or to something that is not a directory. */
	| "no-such-directory"
	/** A bare word that matched no root. */
	| "no-such-project";

export type WorkdirOutcome =
	| { kind: "resolved"; path: string }
	/** The caller is told WHY as well as where it landed. Both resolvers used to answer with a
	 * directory and nothing else, so an agent asked to work in one place quietly started writing in
	 * another - and which wrong place depended on which backend happened to serve the call. */
	| { kind: "unresolved"; reason: WorkdirRefusal; fallback: string };

export interface WorkdirContext {
	/** Where a bare label is looked up. The one thing that legitimately differs per machine, since a
	 * daemon resolves on ITS filesystem. Empty means no label can resolve here. */
	roots: readonly string[];
	home: string;
	/** Overridable so a test drives this without touching a disk. */
	isDirectory?: (candidate: string) => boolean;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Characters refused in any path that reaches a launch command.
 *
 * The same set `isWorkdirPath` enforces on owner-sealed console input, which the agent path did not
 * go through: it checked only that a cwd belonged to a host session, so a control character reached
 * the resolver where the console's own picker refused one. Kept identical rather than restated,
 * because two path-safety grammars is how this class of defect starts.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}'"`$\\]/u;

/** Longest hint accepted, matching the console's own bound and both agent wire schemas. */
export const WORKDIR_MAX_LEN = 512;

/**
 * What this hint is, by shape alone.
 *
 * A LABEL is a bare word with no separator. Anything rooted at `/` or `~` is a path. Anything else
 * relative - including `.` and `..` - is refused rather than resolved, because a relative path means
 * a different directory on the daemon's machine than in the session's process, which is precisely
 * the divergence this replaces.
 */
export function classifyWorkdir(hint: string | undefined, source: WorkdirSource, home: string): WorkdirShape {
	const value = (hint ?? "").trim();
	if (value === "") return { kind: "blank" };
	// Code POINTS, matching `isWorkdirPath`'s own count. `value.length` is UTF-16 code units, so a
	// path of astral characters would be refused here at half the length the console accepts it at.
	if ([...value].length > WORKDIR_MAX_LEN) return { kind: "unsafe", value, reason: "too-long" };
	if (FORBIDDEN.test(value)) return { kind: "unsafe", value, reason: "forbidden-characters" };
	if (value === "~") return { kind: "path", value: home };
	if (value.startsWith("~/")) return { kind: "path", value: path.join(home, value.slice(2)) };
	if (value.startsWith("/")) return { kind: "path", value };
	if (value.includes("/") || value.includes("\\")) return { kind: "unsafe", value, reason: "relative" };
	// Separator-free but still relative, and the ONE pair a label check based on separators alone
	// lets through. `.` under a root resolves to the root itself, so treating it as a label would
	// silently hand back the projects directory as a working directory.
	if (value === "." || value === "..") return { kind: "unsafe", value, reason: "relative" };
	// A bare word. Both sources read one the same way; the source is carried so a future rule can
	// separate them without a caller having to learn a new spelling.
	void source;
	return { kind: "label", value };
}

/**
 * Resolve a hint against one machine's roots, or say why it could not be.
 *
 * A hint that names nothing usable falls back to HOME, on every path. It used to be HOME on the
 * daemon and the session's own directory in-process, so an agent handed an unusable hint started
 * work in a different tree depending on which backend served it.
 *
 * That is about a hint that was GIVEN and could not be used. A caller who names no directory at all
 * never reaches here: both paths default that to the session's own directory, the gateway through
 * `hostWorkdirHint` and the daemonless side through `defaultCwd`. Those already agree, and the
 * distinction is worth keeping - "work where this session works" is a better default than home, and
 * a different question from "the place you named does not exist".
 */
export function resolveWorkdir(
	hint: string | undefined,
	source: WorkdirSource,
	context: WorkdirContext,
): WorkdirOutcome {
	const isDirectory =
		context.isDirectory ??
		((candidate: string) => {
			try {
				return fs.statSync(candidate).isDirectory();
			} catch {
				return false;
			}
		});
	const shape = classifyWorkdir(hint, source, context.home);
	const unresolved = (reason: WorkdirRefusal): WorkdirOutcome => ({
		kind: "unresolved",
		reason,
		fallback: context.home,
	});
	switch (shape.kind) {
		case "blank":
			return unresolved("blank");
		case "unsafe":
			return unresolved(shape.reason);
		case "path":
			// Checked again after expansion: a clean `~/work` becomes an unclean path when HOME itself
			// holds one of these characters, and the hint-level check cannot see that.
			if (FORBIDDEN.test(shape.value)) return unresolved("forbidden-characters");
			return isDirectory(shape.value) ? { kind: "resolved", path: shape.value } : unresolved("no-such-directory");
		case "label": {
			for (const root of context.roots) {
				const base = path.isAbsolute(root) ? root : path.join(context.home, root);
				const candidate = path.join(base, shape.value);
				if (!isDirectory(candidate)) continue;
				// A clean label under an unclean ROOT still yields an unclean path, and that is the hole
				// the daemon's own resolver had: it guarded the picked-path branch and let the label
				// branch return whatever joining produced. The launcher receives the RESOLVED path, so
				// the resolved path is what has to be safe.
				return FORBIDDEN.test(candidate)
					? unresolved("forbidden-characters")
					: { kind: "resolved", path: candidate };
			}
			return unresolved("no-such-project");
		}
	}
}

/** The directory to use, whatever happened. The shape both historical resolvers had, kept for the
 * call sites that cannot yet report a refusal to their caller - see the entry's rollout note: the
 * daemon's rejected-receipt path can carry a reason, and turning the silence into an error is a
 * change to a DOCUMENTED contract, so it ships after this. */
export function workdirOrFallback(outcome: WorkdirOutcome): string {
	return outcome.kind === "resolved" ? outcome.path : outcome.fallback;
}
