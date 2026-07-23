import { z } from "zod";
import { type CrossDomainPresenceSession, CrossDomainPresenceSessionSchema } from "../../shared/federation-protocol.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../../shared/plane-registry.js";
import { sanitizeDescription, sanitizeLabel } from "../../shared/session-store.js";

////////////////////////////////
//  Interfaces & Types

/** What one linked Domain currently sees (or was last pushed) of this Gateway's sessions. */
export type PresenceForDomain = CrossDomainPresenceSession[];

////////////////////////////////
//  Schemas

const LandedEntrySchema = z.object({
	sessions: z.array(CrossDomainPresenceSessionSchema),
	lastPushedAt: z.number().int().nonnegative(),
});
type LandedEntry = z.infer<typeof LandedEntrySchema>;
const CrossDomainPresenceLandedFileSchema = z.record(z.string(), LandedEntrySchema);

////////////////////////////////
//  Functions & Helpers

/** Cap on distinct linked Domains this Gateway tracks a source-side (outbound) or consumer-side
 * (landed) presence plane for. Linking is owner-gated (a slow, deliberate, human-paced action via
 * the enroll ceremony) rather than attacker-forceable the way an unauthenticated input is, so this
 * is primarily a performance/sanity bound - mirrors readAnchors.ts's MAX_TEAMS_PER_OWNER as this
 * codebase's established order of magnitude for a per-relationship cap. A genuinely NEW Domain
 * beyond the cap is refused a plane outright; an already-tracked Domain's own updates are
 * unaffected regardless of how many others exist. */
const MAX_LINKED_DOMAINS_FOR_PRESENCE = 500;

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

export function crossDomainPresenceSourcePlaneName(domainId: string): string {
	return `presence:crossdomain-source:${domainId}`;
}

export function crossDomainPresencePlaneName(domainId: string): string {
	return `presence:crossdomain:${domainId}`;
}

function sortSessions(sessions: PresenceForDomain): PresenceForDomain {
	return [...sessions].sort((a, b) => a.team.localeCompare(b.team) || a.gatewayId.localeCompare(b.gatewayId));
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

////////////////////////////////
//  Per-destination outbound coalescing

type PendingPush = { sessions: PresenceForDomain; token: number };

export interface CoalescedPusher {
	push: (domainId: string, sessions: PresenceForDomain) => void;
	/** Drop any in-flight/pending payload for `domainId` without waiting for it to settle. This
	 * bumps that Domain's generation token (by removing its `pending` entry outright), so an
	 * ALREADY-in-flight attempt's eventual settle can tell it is stale - even if a fresh `push()`
	 * dispatches its own attempt for the same domainId before the stale one resolves. Without the
	 * token, the stale attempt's own "did a fresher payload supersede me" check (a plain `sessions`
	 * object-identity comparison) cannot distinguish that case from an in-place supersede, and would
	 * wrongly re-dispatch a second, redundant, concurrent send of whatever the fresh attempt already
	 * sent. Call when that Domain is being torn down, so a stale attempt can never coalesce away
	 * (or duplicate) a fresh cold-start push landing during a fast unlink-then-relink. */
	cancel: (domainId: string) => void;
}

/** At most one in-flight `presence_push` attempt per destination Domain; a new push arriving
 * while a prior attempt to the SAME destination is still retrying REPLACES that attempt's payload
 * rather than queuing a second one, so a stale retry can never land after a fresher one already
 * succeeded. Reuses `plans/cross-gateway-presence-exchange.md`'s already-specified coalescing
 * design (the parked same-Domain sibling feature) rather than re-inventing it. */
export function createCoalescedPresencePusher(
	sendOnce: (domainId: string, sessions: PresenceForDomain) => Promise<{ ok: boolean; error?: string }>,
): CoalescedPusher {
	const pending = new Map<string, PendingPush>();
	let nextToken = 0;

	// `token` identifies which `pending` GENERATION this specific attempt() call belongs to - not
	// merely which payload. `cancel()` removes the entry without assigning its token to anything, so
	// a later `push()` for the same domainId (with no entry to mutate in place) mints a brand-new
	// token. A stale attempt's continuation then correctly recognizes "the entry I'm looking at
	// belongs to a DIFFERENT generation than the one I was dispatched for" and stops, rather than
	// misreading a cancel-then-repush as an in-place supersede of its own payload.
	function attempt(domainId: string, attemptNum: number, token: number): void {
		const entry = pending.get(domainId);
		if (!entry || entry.token !== token) return;
		const sent = entry.sessions;
		// A rejection (sendOnce is expected to always resolve, never throw) folds into the SAME
		// {ok:false} shape .then() already handles below, so a superseded payload is retried
		// identically whether the in-flight attempt failed by resolving false or by throwing.
		void sendOnce(domainId, sent)
			.catch((err) => ({
				ok: false,
				error: `threw: ${err instanceof Error ? err.message : String(err)}`,
			}))
			.then((r) => {
				const cur = pending.get(domainId);
				if (!cur || cur.token !== token) return;
				if (cur.sessions !== sent) {
					// Same generation, but the payload was mutated in place (a push() arrived while I was
					// in flight, with no cancel() in between) - send it now as a fresh attempt (reset
					// backoff), regardless of whether the superseded one landed.
					attempt(domainId, 0, token);
					return;
				}
				if (r.ok) {
					pending.delete(domainId);
					return;
				}
				if (attemptNum >= 4) {
					console.error(`[cross-domain-presence] push to "${domainId}" failed after retries: ${r.error}`);
					pending.delete(domainId);
					return;
				}
				setTimeout(() => attempt(domainId, attemptNum + 1, token), Math.min(2000 * 2 ** attemptNum, 30_000));
			});
	}

	return {
		push: (domainId, sessions) => {
			const existing = pending.get(domainId);
			if (existing) {
				existing.sessions = sessions;
				return;
			}
			const token = nextToken++;
			pending.set(domainId, { sessions, token });
			attempt(domainId, 0, token);
		},
		cancel: (domainId) => {
			pending.delete(domainId);
		},
	};
}

////////////////////////////////
//  Source side (this Gateway, computing what a linked friend sees of it)

export interface CrossDomainPresenceSourceDeps {
	planeRegistry: PlaneRegistry;
	restoredPlanes: Record<string, PlanePersistedState> | undefined;
	/** What Domain `domainId` currently sees of this Gateway's own sessions - the exact filter
	 * `list_teams`'s cross-Domain leg already computes for pull, called fresh every time. */
	presenceForDomain: (domainId: string) => PresenceForDomain;
	/** Every currently linked-and-shared Domain id - enumerated fresh by the caller on every
	 * `recomputeAll()` call, never cached here. */
	linkedAndSharedDomainIds: () => string[];
	/** Force the next `presenceForDomain` read to recompute rather than reuse a same-tick cache
	 * (routes.ts's `invalidatePresenceSnapshotCache`). Called once at the top of every
	 * `recomputeDomain`/`recomputeAll` entry so two genuinely separate mutations landing in the SAME
	 * synchronous tick (e.g. a reconnect's evict-then-confirm) each see fresh state, while the
	 * per-Domain loop WITHIN one `recomputeAll()` call still shares a single computation. */
	invalidatePresenceCache: () => void;
	/** Push the given content toward `domainId`'s gateway (the caller owns retry/coalescing). */
	push: (domainId: string, sessions: PresenceForDomain) => void;
	/** Cancel any in-flight/pending push for `domainId` (a `CoalescedPusher.cancel`) - called from
	 * `teardown()` so a stale attempt cannot coalesce away a fresh cold-start push on a fast
	 * unlink-then-relink. */
	cancelPush: (domainId: string) => void;
}

export interface CrossDomainPresenceSource {
	/** Recompute (and, on a real change, push) presence for exactly this Domain - the precise
	 * path for a mutation that names a single affected Domain (a specific-Domain share/unshare,
	 * `dropDomain`, or an unlink/untrust). A Domain touched for the very first time is registered
	 * and its current content pushed unconditionally (see the module doc on cold start); every
	 * later call just marks its plane dirty and lets the registry's own hash gate decide. */
	recomputeDomain: (domainId: string) => void;
	/** `recomputeDomain` over EVERY currently linked-and-shared Domain - the fallback path for a
	 * mutation that cannot name a single affected Domain (an everyone-trusted share/unshare, or
	 * `CrossDomainPeers`' own argument-less onChange). */
	recomputeAll: () => void;
	/** Drop a Domain's change-detector plane. Call from `unlinkDomain`/`untrustOwner`'s existing
	 * cleanup, alongside the peer/share/job drops they already do. */
	teardown: (domainId: string) => void;
}

/**
 * The source-side outbound mechanism: one internal, never-polled change-detector plane per
 * linked-and-shared-to Domain, whose only consumer is its own `onBump` callback (a push, not
 * anything a poll response ever serves directly - see the plan's Source side section).
 *
 * Cold start: `Plane`'s constructor seeds its baseline hash from the snapshot computed AT
 * REGISTRATION TIME, so `recompute()` can never see a brand-new plane's very first content as
 * "changed" - nothing would ever reach the peer without an explicit bypass. A plane restored from
 * a CLEAN shutdown does NOT need this bypass: the registry's own `reconcileOnBoot()` (or, for a
 * Domain whose plane only gets touched well after boot, the periodic tripwire) already recomputes
 * against live state and fires `onBump` normally if anything actually drifted from what was last
 * persisted - firing the bypass unconditionally on every registration would spuriously re-push
 * unchanged content on every restart. A NON-clean restore (the common case: only a graceful
 * SIGTERM/SIGINT ever persists `cleanShutdown:true`, so a crash/OOM/`docker kill` leaves the last
 * regular tick's `false`) does NOT get this rescue: `Plane`'s constructor discards the persisted
 * hash entirely and reseeds the baseline from the CURRENT snapshot instead, exactly like a
 * brand-new plane - so it needs the SAME unconditional bypass, or nothing ever corrects whatever
 * the peer cached before the crash.
 */
export function createCrossDomainPresenceSource(deps: CrossDomainPresenceSourceDeps): CrossDomainPresenceSource {
	const {
		planeRegistry,
		restoredPlanes,
		presenceForDomain,
		linkedAndSharedDomainIds,
		invalidatePresenceCache,
		push,
		cancelPush,
	} = deps;
	const registered = new Set<string>();

	/** Shared body for recomputeDomain/recomputeAll below, taking the CURRENT linked-and-shared set
	 * as a parameter rather than re-deriving it - recomputeAll already has one (from its own single
	 * upfront call) and would otherwise pay for a fresh O(Domains * (peers + shares)) enumeration
	 * once per Domain in its own loop (an O(N) pass turning into O(N^2)), on a path wired to fire on
	 * essentially every local presence mutation. */
	function recomputeDomainIn(domainId: string, linked: ReadonlySet<string>): void {
		if (!linked.has(domainId)) {
			// Not linked-and-shared (any longer, or ever) - most commonly a same-tick side effect of
			// the very unlink/unshare/untrust that made it so (e.g. dropDomain's onChange firing this
			// before the caller's own teardown() call runs). Tear down rather than register or push a
			// plane for a Domain relationship that does not currently exist - registering one here
			// would resurrect a zombie plane right after (or instead of) a legitimate teardown.
			teardown(domainId);
			return;
		}
		const name = crossDomainPresenceSourcePlaneName(domainId);
		if (!registered.has(domainId)) {
			if (registered.size >= MAX_LINKED_DOMAINS_FOR_PRESENCE) {
				console.warn(
					`[cross-domain-presence] refusing a new source plane for "${domainId}" - at the ${MAX_LINKED_DOMAINS_FOR_PRESENCE}-Domain cap`,
				);
				return;
			}
			registered.add(domainId);
			const restored = restoredPlanes?.[name];
			planeRegistry.registerPlane(
				{
					name,
					snapshot: () => sortSessions(presenceForDomain(domainId)),
					identityOf: (snapshot) => stableHash(snapshot),
					onBump: () => push(domainId, sortSessions(presenceForDomain(domainId))),
				},
				restored,
			);
			// A plane restored from a CLEAN shutdown trusts its persisted hash as the comparison
			// baseline (Plane's own constructor), so a genuine drift is caught by reconcileOnBoot/the
			// tripwire like any other bump - no bypass needed. Anything else (nothing restored at
			// all, or restored but NOT a clean shutdown) reseeds the baseline from the CURRENT
			// snapshot instead (same Plane constructor), which can never see its own seed content as
			// "changed" - so both cases need this unconditional bypass, not just the brand-new one.
			if (!restored?.cleanShutdown) push(domainId, sortSessions(presenceForDomain(domainId)));
			return;
		}
		planeRegistry.markDirty(name);
	}

	function recomputeDomain(domainId: string): void {
		invalidatePresenceCache();
		recomputeDomainIn(domainId, new Set(linkedAndSharedDomainIds()));
	}

	function recomputeAll(): void {
		invalidatePresenceCache();
		const linked = new Set(linkedAndSharedDomainIds());
		for (const domainId of linked) recomputeDomainIn(domainId, linked);
	}

	function teardown(domainId: string): void {
		// Drop any in-flight/retrying push for this Domain FIRST - otherwise a fast unlink-then-
		// relink's fresh cold-start push (below) would silently coalesce behind the stale attempt
		// instead of sending, until that stale attempt eventually settles (up to the relay timeout).
		cancelPush(domainId);
		// A restoredPlanes entry only ever represents state as of THIS PROCESS'S boot. Once torn
		// down, any later re-registration (a same-process unlink then relink) is a genuinely fresh
		// grant, not a restart continuity - deleting the entry here stops recomputeDomain's clean-
		// shutdown check above from mistaking stale boot-time data for it.
		if (restoredPlanes) delete restoredPlanes[crossDomainPresenceSourcePlaneName(domainId)];
		if (registered.delete(domainId)) planeRegistry.unregisterPlane(crossDomainPresenceSourcePlaneName(domainId));
	}

	return { recomputeDomain, recomputeAll, teardown };
}

////////////////////////////////
//  Consumer side (this Gateway, storing what a linked friend pushed to it)

/**
 * The landed side of a linked friend's `presence_push`: one plane per Domain that has ever pushed
 * to this Gateway, lazily registered on first land (mirrors `ReadAnchors`'s own lazy, per-key
 * registration pattern). Plain in-memory state persisted on the same periodic/shutdown cadence as
 * sessions/jobs/mailboxes/read-anchors (via the caller's own `snapshot()`/`restore()` into the
 * shared durable-state file) - losing a few seconds of this on an unclean crash just means a
 * transient staleness until the next push or backstop pull, never a correctness concern.
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
	private readonly pendingLand = new Map<
		string,
		{ sessions: CrossDomainPresenceSession[]; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly minLandIntervalMs: number;

	/** `minLandIntervalMs` defaults to the production floor (`MIN_LAND_INTERVAL_MS`) - overridable
	 * (e.g. to 0) for a test that needs to land the same Domain repeatedly without waiting. */
	constructor(
		planeRegistry: PlaneRegistry,
		restoredPlanes: Record<string, PlanePersistedState> | undefined,
		minLandIntervalMs = MIN_LAND_INTERVAL_MS,
	) {
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
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
	 * must not write orphaned state for a Domain its own plane registration refused. */
	private ensureRegistered(domainId: string): boolean {
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
				// lastPushedAt is deliberately excluded from what gets hashed: it is a freshness
				// timestamp, not content, and a backstop-driven refresh that confirms unchanged
				// content must not spuriously bump the version (which would wake every polling
				// console over nothing). The stored value the poll response actually serves still
				// carries the up-to-date timestamp regardless - see snapshot() above.
				snapshot: () => this.state.get(domainId)?.sessions ?? [],
				identityOf: (snapshot) => stableHash(snapshot),
			},
			this.restoredPlanes?.[name],
		);
		return true;
	}

	/** Land a linked friend's `presence_push`: replace this Domain's stored content and bump its
	 * plane if the content actually changed. `srcDomainId` MUST be the sealer-VERIFIED sender,
	 * never a payload-supplied value - see the plan's "Trust boundary" section. Never re-fans-out
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
		const now = Date.now();
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
		const timer = setTimeout(() => {
			const pending = this.pendingLand.get(srcDomainId);
			this.pendingLand.delete(srcDomainId);
			if (pending) this.applyLand(srcDomainId, pending.sessions, Date.now());
		}, delayMs);
		this.pendingLand.set(srcDomainId, { sessions, timer });
	}

	/** The actual write: gate on the cap FIRST, so `lastLandedAt` (the rate-limit clock) is only
	 * ever set for a Domain that is genuinely being tracked - a Domain permanently refused at the
	 * cap must not accumulate an ever-growing, never-cleaned rate-limit entry of its own. */
	private applyLand(srcDomainId: string, sessions: CrossDomainPresenceSession[], now: number): void {
		if (!this.ensureRegistered(srcDomainId)) return;
		this.lastLandedAt.set(srcDomainId, now);
		this.state.set(srcDomainId, { sessions: sanitizeLandedSessions(sessions), lastPushedAt: now });
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
			clearTimeout(pending.timer);
			this.pendingLand.delete(domainId);
		}
		this.state.delete(domainId);
		this.registered.delete(domainId);
		this.planeRegistry.unregisterPlane(crossDomainPresencePlaneName(domainId));
	}
}
