// Cross-Domain presence, consumer side: this Gateway storing what a linked friend pushed to it.

import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { type CrossDomainPresenceSession, CrossDomainPresenceSessionSchema } from "../../shared/federation-protocol.js";
import type { PlanePersistedState, PlaneRegistry } from "../../shared/plane-registry.js";
import { stableHash } from "../../shared/plane-registry.js";
import { sanitizeDescription, sanitizeLabel } from "../../shared/session-sanitize.js";
import { MAX_LINKED_DOMAINS_FOR_PRESENCE, type PresenceForDomain } from "./crossDomainPresenceSource.js";

const LandedEntrySchema = z.object({
	sessions: z.array(CrossDomainPresenceSessionSchema),
	// Refreshed on EITHER a landed push or a successful backstop pull (createCrossDomainPresenceReconciler
	// below) - a client-side staleness display timestamp, never a gateway-side boolean.
	lastRefreshedAt: z.number().int().nonnegative(),
});
type LandedEntry = z.infer<typeof LandedEntrySchema>;
const CrossDomainPresenceLandedFileSchema = z.record(z.string(), LandedEntrySchema);

/** Floor on how often a landed `presence_push` from the SAME Domain is actually PROCESSED (the
 * expensive part: a full `stableHash` over up to `MAX_CROSSDOMAIN_PRESENCE_SESSIONS` entries).
 * Unlike an authenticity check, this is not about who may push - a linked peer's identity is
 * already sealer-verified before land() ever runs - it bounds how much CPU one admitted-but-
 * hostile-or-buggy peer can force by resending (each `seal()` mints a fresh nonce, so the replay
 * guard cannot reject a resend, identical payload or not). A legitimate sender CAN genuinely push
 * faster than this (its own source side fires on every local presence mutation, undebounced) -
 * `land()` does not drop a call arriving inside the window, it coalesces and defers it (see
 * `land`'s own doc comment), so this floor bounds cost without ever losing the latest content. */
const MIN_LAND_INTERVAL_MS = 1_000;

/** Granularity `CrossDomainPresenceConsumer`'s per-Domain plane buckets `lastRefreshedAt` into for
 * hashing (see `ensureRegistered`'s plane definition). A reconfirmation within the same bucket as
 * the last one never bumps the version (no spurious wake for every 10s backstop tick); crossing
 * into a new bucket does, carrying a fresher timestamp to any console holding a stale one. */
const FRESHNESS_BUCKET_MS = 60_000;

export function crossDomainPresencePlaneName(domainId: string): string {
	return `presence:crossdomain:${domainId}`;
}

/** Strip control/bidi-override/invisible characters from a REQUIRED landed identifier field
 * (`team`/`gatewayId`) - unlike sessionLabel/description these can never come out empty (the
 * schema requires a non-empty string), so a reject-outright sanitizer (`sanitizeLabel`) is the
 * wrong tool; strip-and-keep (`sanitizeDescription`) is, with a fixed fallback for the
 * pathological case where nothing printable survives stripping. */
function sanitizeLandedIdentifier(raw: string): string {
	return sanitizeDescription(raw) ?? "unknown";
}

/** Strip control/bidi-override/invisible characters from a LANDED session's free-text fields -
 * the zod schema only length-caps them (federation-protocol.ts), so a linked peer's sessionLabel/
 * description/team/gatewayId otherwise reach this Gateway's durable state and its console
 * verbatim. Reuses the exact sanitizeLabel/sanitizeDescription this codebase already applies to
 * the same field names (session-store.ts) for the identical risk ("make a label unrenderable or
 * spoofable"), which a landed push - stickier than the ephemeral pull it replaces - needs just as
 * much. */
function sanitizeLandedSessions(sessions: readonly CrossDomainPresenceSession[]): PresenceForDomain {
	return sessions.map((s) => ({
		...s,
		team: sanitizeLandedIdentifier(s.team),
		gatewayId: sanitizeLandedIdentifier(s.gatewayId),
		sessionLabel: sanitizeLabel(s.sessionLabel) ?? undefined,
		description: sanitizeDescription(s.description) ?? undefined,
	}));
}

/**
 * The landed side of a linked friend's `presence_push`: one plane per Domain that has ever pushed
 * to this Gateway, lazily registered on first land (mirrors `ReadAnchors`'s own lazy, per-key
 * registration pattern). Plain in-memory state persisted on the same periodic/shutdown cadence as
 * sessions/jobs/mailboxes/read-anchors (via the caller's own `snapshot()`/`restore()` into the
 * shared durable-state file) - losing a few seconds of this on an unclean crash is corrected by the
 * source Domain's NEXT push, or by the independent backstop pull (`createCrossDomainPresenceReconciler`
 * below), which lands through this same `land()` entry point on its own cadence - so a push that is
 * dropped (rate-limited, relayed but never received) or exhausts its retry budget with no FOLLOWING
 * source-side change is still eventually corrected.
 */
export class CrossDomainPresenceConsumer {
	// A Map, not a plain object: srcDomainId is a linked peer's OWN self-reported string, never
	// charset-validated upstream (the cross-Domain handshake's domainId field is `z.string().min(1)`
	// only) - a bracket-assigned "__proto__" key on a plain object literal would hijack its
	// prototype chain. A Map's keys are never property lookups, so this class of hazard cannot
	// reach it regardless of what a peer reports.
	private state = new Map<string, LandedEntry>();
	private readonly planeRegistry: PlaneRegistry;
	private readonly restoredPlanes: Record<string, PlanePersistedState> | undefined;
	private readonly registered = new Set<string>();
	private readonly lastLandedAt = new Map<string, number>();
	private readonly pendingLand = new Map<string, { sessions: CrossDomainPresenceSession[]; timer: TimerHandle }>();
	private readonly minLandIntervalMs: number;
	private readonly ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;

	/** `minLandIntervalMs` defaults to the production floor (`MIN_LAND_INTERVAL_MS`) - overridable
	 * (e.g. to 0) for a test that needs to land the same Domain repeatedly without waiting. */
	constructor(
		planeRegistry: PlaneRegistry,
		restoredPlanes: Record<string, PlanePersistedState> | undefined,
		ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">,
		minLandIntervalMs = MIN_LAND_INTERVAL_MS,
	) {
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
		this.ambient = ambient;
		this.minLandIntervalMs = minLandIntervalMs;
	}

	/** Restore the raw per-Domain data from a durable snapshot (the same atomic file the caller's
	 * other durable state persists into). A malformed or absent snapshot starts empty. Every
	 * restored Domain is re-registered immediately (not lazily, on its next land()): `registered`
	 * otherwise starts this process at 0 regardless of how many Domains `state` already holds,
	 * which would both under-count the cap (letting brand-new Domains land past it until each
	 * restored one happens to re-push) and leave a restored Domain's plane unregistered - so a
	 * `teardown()` for it before its first fresh land() would find nothing in `registered` to key
	 * off. Mirrors the source side's own cold-start handling: a restored Domain already past the
	 * cap (only possible from a pre-fix durable-state file) is refused going forward, same as any
	 * other over-cap Domain. */
	restore(data: unknown): void {
		const parsed = CrossDomainPresenceLandedFileSchema.safeParse(data);
		if (!parsed.success) return;
		this.state = new Map(Object.entries(parsed.data));
		for (const domainId of this.state.keys()) this.ensureRegistered(domainId);
	}

	/** The raw per-Domain data as a plain object, for the caller's own durable (JSON) snapshot. */
	snapshot(): Record<string, LandedEntry> {
		return Object.fromEntries(this.state);
	}

	/** Whether `domainId` is safe to write into `state` - already tracked, or freshly registered
	 * within the cap. False ONLY when a genuinely new Domain is refused at the cap - the caller
	 * must not write orphaned state for a Domain its own plane registration refused. Public so the
	 * poll path (consoleHandler.ts) can eagerly register every currently-linked Domain's plane
	 * BEFORE racing `waitForBump` - a plane that does not exist yet cannot wake an in-flight held
	 * poll on its first-ever bump (see `PlaneRegistry.wake`'s own membership-gated dispatch), so a
	 * linked Domain must have a plane in place before that Domain's first land()/pull ever lands. */
	ensureRegistered(domainId: string): boolean {
		if (this.registered.has(domainId)) return true;
		if (this.registered.size >= MAX_LINKED_DOMAINS_FOR_PRESENCE) {
			console.warn(
				`[cross-domain-presence] refusing a new consumer plane for "${domainId}" - at the ${MAX_LINKED_DOMAINS_FOR_PRESENCE}-Domain cap`,
			);
			return false;
		}
		this.registered.add(domainId);
		const name = crossDomainPresencePlaneName(domainId);
		this.planeRegistry.registerPlane(
			{
				name,
				// lastRefreshedAt rides in its own COARSE bucket (see FRESHNESS_BUCKET_MS), not raw -
				// a backstop pull that reconfirms unchanged content must not bump (and wake every
				// polling console over) the version on every single reconfirmation, but a freshness
				// signal that NEVER bumps would never reach any console once content stops changing,
				// which defeats the entire point of a backstop pull (confirming continued freshness,
				// not just correcting drift). Bucketing gives both: cheap, rare version bumps that
				// still periodically carry a fresher timestamp to whoever is holding a stale one.
				snapshot: () => {
					const entry = this.state.get(domainId);
					return {
						sessions: entry?.sessions ?? [],
						freshnessBucket: entry ? Math.floor(entry.lastRefreshedAt / FRESHNESS_BUCKET_MS) : 0,
					};
				},
				identityOf: (snapshot) => stableHash(snapshot),
			},
			this.restoredPlanes?.[name],
		);
		return true;
	}

	/** Land a linked friend's `presence_push`: replace this Domain's stored content and bump its
	 * plane if the content actually changed. `srcDomainId` MUST be the sealer-VERIFIED sender,
	 * never a payload-supplied value. Never re-fans-out
	 * (the same origin-only invariant `console_push`'s landing side already follows). A Domain
	 * refused at the cap is dropped outright - never written, never counted against the plane the
	 * cap exists to bound, and never marked as landed either (see `applyLand` - a permanently
	 * cap-refused Domain must not grow `lastLandedAt` forever).
	 *
	 * A call arriving within `MIN_LAND_INTERVAL_MS` of the last one THIS Domain landed is not
	 * dropped outright - identity is already verified by this point, but a fresh `seal()` mints a
	 * new nonce every call, so the replay guard alone cannot bound how often an admitted peer
	 * resends, and this floor bounds the expensive part (a full `stableHash`). Instead the LATEST
	 * payload is coalesced behind a single timer (mirroring the outbound side's own per-destination
	 * `CoalescedPusher`) and applied once the window actually elapses - a legitimate fast burst of
	 * real changes is delayed, never silently and permanently lost. */
	land(srcDomainId: string, sessions: CrossDomainPresenceSession[]): void {
		const now = this.ambient.now();
		const last = this.lastLandedAt.get(srcDomainId);
		if (last !== undefined && now - last < this.minLandIntervalMs) {
			this.schedulePendingLand(srcDomainId, sessions, this.minLandIntervalMs - (now - last));
			return;
		}
		this.applyLand(srcDomainId, sessions, now);
	}

	/** Coalesce a rate-limited land() behind a single timer per Domain - a second deferred call for
	 * the SAME Domain before the first one fires replaces its payload in place rather than
	 * scheduling a second timer, exactly like the outbound `CoalescedPusher`. */
	private schedulePendingLand(srcDomainId: string, sessions: CrossDomainPresenceSession[], delayMs: number): void {
		const existing = this.pendingLand.get(srcDomainId);
		if (existing) {
			existing.sessions = sessions;
			return;
		}
		const timer = this.ambient.setTimer(() => {
			const pending = this.pendingLand.get(srcDomainId);
			this.pendingLand.delete(srcDomainId);
			if (pending) this.applyLand(srcDomainId, pending.sessions, this.ambient.now());
		}, delayMs);
		this.pendingLand.set(srcDomainId, { sessions, timer });
	}

	/** The actual write: gate on the cap FIRST, so `lastLandedAt` (the rate-limit clock) is only
	 * ever set for a Domain that is genuinely being tracked - a Domain permanently refused at the
	 * cap must not accumulate an ever-growing, never-cleaned rate-limit entry of its own. */
	private applyLand(srcDomainId: string, sessions: CrossDomainPresenceSession[], now: number): void {
		if (!this.ensureRegistered(srcDomainId)) return;
		this.lastLandedAt.set(srcDomainId, now);
		this.state.set(srcDomainId, { sessions: sanitizeLandedSessions(sessions), lastRefreshedAt: now });
		this.planeRegistry.markDirty(crossDomainPresencePlaneName(srcDomainId));
	}

	/** Drop a Domain's landed state and plane entirely. Call from `unlinkDomain`/`untrustOwner`'s
	 * existing cleanup, alongside the peer/share/job drops they already do. Every cleanup below runs
	 * UNCONDITIONALLY, never gated on `registered.has(domainId)`: `state` and `registered` are meant
	 * to stay in lockstep (see `restore()`/`ensureRegistered()`), but this method must not silently
	 * skip cleanup and leave an orphaned, un-teardownable `state` entry if they ever don't.
	 * `planeRegistry.unregisterPlane` is documented as a safe no-op when the name is not currently
	 * registered, so calling it unconditionally costs nothing. */
	teardown(domainId: string): void {
		// A restoredPlanes entry only ever represents state as of THIS PROCESS'S boot - stale after
		// a teardown, so a later same-process re-link's own fresh land() must not inherit it.
		if (this.restoredPlanes) delete this.restoredPlanes[crossDomainPresencePlaneName(domainId)];
		this.lastLandedAt.delete(domainId);
		const pending = this.pendingLand.get(domainId);
		if (pending) {
			this.ambient.clearTimer(pending.timer);
			this.pendingLand.delete(domainId);
		}
		this.state.delete(domainId);
		this.registered.delete(domainId);
		this.planeRegistry.unregisterPlane(crossDomainPresencePlaneName(domainId));
	}
}
