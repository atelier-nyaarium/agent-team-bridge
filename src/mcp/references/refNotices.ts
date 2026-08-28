// The one owner of what the agent reads about a ref that was not resolved on the index: the
// refusal that stops a send, the wire `reason` a degraded snapshot carries, and the notice a reply
// prints, each rendered from a closed value.

////////////////////////////////
//  Interfaces & Types

/** Only lexicon being unable to answer degrades; everything an author can fix refuses instead. */
export type DegradeCause =
	| "notInstalled"
	| "incompatible"
	| "warming"
	| "daemonError"
	| "connectionLost"
	| "noWorkspace"
	| "indexRefused";

/** Why a send stops, with what the author needs to fix it; `textForm` is always a ref that would go. */
export type Refusal =
	| { kind: "file"; detail: string }
	| { kind: "matcher"; detail: string; scope?: { chain: string; startLine: number; endLine: number } }
	| { kind: "outsideChain"; root: string; textForm: string }
	| { kind: "vanished"; path: string }
	| { kind: "unclaimed"; path: string; detail?: string; textForm: string }
	| { kind: "parseFailed"; path: string; detail?: string; textForm: string }
	| { kind: "disagree"; path: string; textForm: string }
	| { kind: "ambiguous"; chain: string; count: number; offers: string[]; textForm: string }
	| {
			kind: "noMatch";
			failing: string;
			where: string;
			count: number;
			available: string[];
			availableTotal: number;
			textForm: string;
	  };

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

/** The sentence a refusal shows the agent; the fix to paste is in it. */
export function renderRefusal(refusal: Refusal): string {
	switch (refusal.kind) {
		case "file":
			return refusal.detail;
		case "matcher":
			return refusal.scope === undefined
				? refusal.detail
				: `${refusal.detail} inside ${refusal.scope.chain} (lines ${refusal.scope.startLine}-${refusal.scope.endLine})`;
		case "outsideChain":
			return `a scope chain needs a file inside the workspace root ${refusal.root}; for this file write ${refusal.textForm}`;
		case "vanished":
			return `${refusal.path} disappeared while the reply was being prepared`;
		case "unclaimed":
			return `no provider indexes ${refusal.path}${refusal.detail ? ` (${refusal.detail})` : ""}; write ${refusal.textForm}`;
		case "parseFailed":
			return `the index could not parse ${refusal.path}${refusal.detail ? `: ${refusal.detail}` : ""}; write ${refusal.textForm}`;
		case "disagree":
			return `the index and the file disagree about ${refusal.path}; send again, or use ${refusal.textForm}`;
		case "ambiguous":
			return `${refusal.count} declarations match ${refusal.chain}; pick one: ${refusal.offers.length > 0 ? refusal.offers.join(", ") : refusal.textForm}`;
		case "noMatch": {
			const count =
				refusal.count > 0 ? ` (${refusal.count} named ${JSON.stringify(refusal.failing)} at other depths)` : "";
			const unlisted = refusal.availableTotal - refusal.available.length;
			const listed =
				refusal.available.length === 0
					? refusal.availableTotal === 0
						? "nothing is declared there"
						: `${refusal.availableTotal} declarations there, none listed`
					: `declared there: ${refusal.available.join(", ")}${unlisted > 0 ? ` and ${unlisted} more` : ""}`;
			return `no declaration named ${JSON.stringify(refusal.failing)} ${refusal.where}${count}; ${listed}; or write ${refusal.textForm}`;
		}
	}
}
