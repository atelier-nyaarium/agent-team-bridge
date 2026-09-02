/** Bounds unauthenticated team keys accepted per owner. */
export const MAX_TEAMS_PER_OWNER = 500;

/** Per-owner plane prevents read positions crossing owner boundaries. */
export function readAnchorsPlaneName(ownerId: string): string {
	return `read-anchors:${ownerId}`;
}

export interface ReadAnchorEntry {
	epoch: number;
	seq: number;
	at: number;
}

export function mergeReadAnchor(
	state: Record<string, Record<string, ReadAnchorEntry>>,
	ownerId: string,
	team: string,
	entry: ReadAnchorEntry,
): { state: Record<string, Record<string, ReadAnchorEntry>>; advanced: boolean } {
	const owner = state[ownerId] ?? {};
	const cur = owner[team];
	if (!cur && Object.keys(owner).length >= MAX_TEAMS_PER_OWNER) return { state, advanced: false };
	// Mailbox epochs are random per instance and never ordered, so they compare for equality only.
	// Same epoch, the seq decides. A different epoch means the reporter is reading a live mailbox and
	// the stored anchor names a dead instance, so the later report wins on its own timestamp.
	const advanced = !cur || (entry.epoch === cur.epoch ? entry.seq > cur.seq : entry.at > cur.at);
	if (!advanced) return { state, advanced: false };
	return { state: { ...state, [ownerId]: { ...owner, [team]: entry } }, advanced: true };
}
