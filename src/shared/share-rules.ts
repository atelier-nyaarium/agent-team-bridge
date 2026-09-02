import { z } from "zod";
import { CrossDomainShareTargetSchema } from "./schemas.js";

export type CrossDomainShareTarget = z.infer<typeof CrossDomainShareTargetSchema>;

/** Local session offer keyed by session and audience. The console seal authenticates it. */
const ShareRecordSchema = z.object({
	sessionTarget: z.string().min(1),
	target: CrossDomainShareTargetSchema,
	lastSeenAt: z.number().int(),
});
export type ShareRecord = z.infer<typeof ShareRecordSchema>;

export function targetKey(target: CrossDomainShareTarget): string {
	return target.kind === "domain" ? `domain:${target.domainId}` : "everyone_trusted";
}

export type ShareState = { shares: ShareRecord[] };

/** Re-sharing refreshes `lastSeenAt` without duplicating. */
export function share(
	state: ShareState,
	sessionTarget: string,
	target: CrossDomainShareTarget,
	now: number,
): ShareState {
	const shares = state.shares.map((record) => ({ ...record, target: { ...record.target } }));
	const key = targetKey(target);
	const existing = shares.find((s) => s.sessionTarget === sessionTarget && targetKey(s.target) === key);
	if (existing) existing.lastSeenAt = now;
	else shares.push({ sessionTarget, target, lastSeenAt: now });
	return { shares };
}

export function unshare(
	state: ShareState,
	sessionTarget: string,
	target: CrossDomainShareTarget,
): { state: ShareState; removed: boolean } {
	const key = targetKey(target);
	const shares = state.shares.filter((s) => !(s.sessionTarget === sessionTarget && targetKey(s.target) === key));
	return { state: { shares }, removed: shares.length !== state.shares.length };
}

/** Specific shares match one Domain; trusted shares require a linked Domain. */
export function isSharedTo(
	state: ShareState,
	sessionTarget: string,
	toDomainId: string,
	isLinked: (domainId: string) => boolean,
): boolean {
	return state.shares.some(
		(s) =>
			s.sessionTarget === sessionTarget &&
			(s.target.kind === "domain" ? s.target.domainId === toDomainId : isLinked(toDomainId)),
	);
}

export function sharesFor(state: ShareState, toDomainId: string, isLinked: (domainId: string) => boolean): string[] {
	const linked = isLinked(toDomainId);
	return [
		...new Set(
			state.shares
				.filter((s) => (s.target.kind === "domain" ? s.target.domainId === toDomainId : linked))
				.map((s) => s.sessionTarget),
		),
	];
}

/** Refreshes presence time and prevents absence expiry. */
export function touch(state: ShareState, sessionTarget: string, now: number): ShareState {
	return {
		shares: state.shares.map((s) => (s.sessionTarget === sessionTarget ? { ...s, lastSeenAt: now } : { ...s })),
	};
}

/** Removes all shares for an unlinked Domain. */
export function dropDomain(state: ShareState, toDomainId: string): { state: ShareState; removed: number } {
	const shares = state.shares.filter((s) => !(s.target.kind === "domain" && s.target.domainId === toDomainId));
	return { state: { shares }, removed: state.shares.length - shares.length };
}

export function all(state: ShareState): ShareRecord[] {
	return [...state.shares];
}

/** Expires unseen shares unless a live cross-Domain thread keeps them alive. */
export function sweep(
	state: ShareState,
	now: number,
	ttlMs: number,
	isLive: (sessionTarget: string) => boolean,
): { state: ShareState; removed: number } {
	const shares = state.shares.filter((s) => now - s.lastSeenAt <= ttlMs || isLive(s.sessionTarget));
	return { state: { shares }, removed: state.shares.length - shares.length };
}
