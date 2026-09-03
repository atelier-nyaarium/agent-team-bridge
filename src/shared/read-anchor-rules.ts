/** Bounds unauthenticated team keys accepted per owner. */
export const MAX_TEAMS_PER_OWNER = 500;

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
	// Epochs are random tags and compare only for equality.
	// Sequence orders rows within an epoch. Across epochs, later report wins.
	// Receiver stamps `at`; reporter time never orders cross-epoch merges.
	// ReadAnchor.kt is the Kotlin twin and resolves by row position.
	const advanced = !cur || (entry.epoch === cur.epoch ? entry.seq > cur.seq : entry.at > cur.at);
	if (!advanced) return { state, advanced: false };
	return { state: { ...state, [ownerId]: { ...owner, [team]: entry } }, advanced: true };
}
