// The last `devcontainer up` transcript per project, shown by the terminal view before a pane exists.
const MAX_TRANSCRIPT_CHARS = 16_384;

const transcripts = new Map<string, string>();

export function beginBuildTranscript(project: string): void {
	transcripts.set(project, "");
}

/** Keeps the tail once the cap is passed. */
export function appendBuildTranscript(project: string, chunk: string): void {
	const next = (transcripts.get(project) ?? "") + chunk;
	transcripts.set(project, next.length > MAX_TRANSCRIPT_CHARS ? next.slice(-MAX_TRANSCRIPT_CHARS) : next);
}

export function buildTranscript(project: string): string | undefined {
	return transcripts.get(project);
}
