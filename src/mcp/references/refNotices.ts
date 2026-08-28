// The one renderer of why a ref was not resolved on the index: the wire `reason` a snapshot
// carries and the notice a reply prints, from one closed cause.

////////////////////////////////
//  Interfaces & Types

/** Only lexicon's absence degrades; everything an author can fix refuses instead. */
export type DegradeCause =
	| "notInstalled"
	| "incompatible"
	| "warming"
	| "daemonError"
	| "connectionLost"
	| "noWorkspace"
	| "indexRefused";

////////////////////////////////
//  Constants

/** The wire schema's cap on a snapshot's reason. */
export const WIRE_REASON_MAX = 256;

const SENTENCES: Record<DegradeCause, string> = {
	notInstalled: "lexicon is not installed, so refs were matched by text; install the lexicon plugin for exact refs",
	incompatible: "the installed lexicon cannot serve this client, so refs were matched by text",
	warming:
		"the index was still warming when the reply went out, so refs were matched by text; send again for exact refs",
	daemonError: "the lexicon daemon could not answer, so refs were matched by text",
	connectionLost: "the connection to the lexicon daemon was lost, so refs were matched by text",
	noWorkspace: "this workspace root is one the index will not serve, so refs were matched by text",
	indexRefused: "the index refused this file, so the ref was matched by text",
};

////////////////////////////////
//  Functions & Helpers

function clip(text: string): string {
	return text.length <= WIRE_REASON_MAX ? text : `${text.slice(0, WIRE_REASON_MAX - 3)}...`;
}

/** The snapshot's reason: the cause, the detail, and how the text tier landed. */
export function reasonFor(cause: DegradeCause, detail: string | undefined, landing: string): string {
	const why = detail === undefined || detail === "" ? SENTENCES[cause] : `${SENTENCES[cause]} (${detail})`;
	return clip(`${why}; ${landing}`);
}

/** The line a reply prints after its own success text. */
export function noticeFor(cause: DegradeCause, detail?: string): string {
	const why = detail === undefined || detail === "" ? SENTENCES[cause] : `${SENTENCES[cause]}: ${detail}`;
	return `refs: ${why}`;
}
