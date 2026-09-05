import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { type CrossDomainPresenceSession, CrossDomainPresenceSessionSchema } from "../../shared/federation-protocol.js";
import type { PlanePersistedState, PlaneRegistry } from "../../shared/plane-registry.js";
import { stableHash } from "../../shared/plane-registry.js";
import { sanitizeDescription, sanitizeLabel } from "../../shared/session-sanitize.js";
import { MAX_LINKED_DOMAINS_FOR_PRESENCE, type PresenceForDomain } from "./crossDomainPresenceSource.js";

const LandedEntrySchema = z.object({
	sessions: z.array(CrossDomainPresenceSessionSchema),
	lastRefreshedAt: z.number().int().nonnegative(),
});
type LandedEntry = z.infer<typeof LandedEntrySchema>;
const CrossDomainPresenceLandedFileSchema = z.record(z.string(), LandedEntrySchema);

const MIN_LAND_INTERVAL_MS = 1_000;

// Bucket freshness to limit hashing and wakeups.
const FRESHNESS_BUCKET_MS = 60_000;

export function crossDomainPresencePlaneName(domainId: string): string {
	return `presence:crossdomain:${domainId}`;
}

function sanitizeLandedIdentifier(raw: string): string {
	// Strip peer-controlled identifiers before durable storage.
	return sanitizeDescription(raw) ?? "unknown";
}

function sanitizeLandedSessions(sessions: readonly CrossDomainPresenceSession[]): PresenceForDomain {
	return sessions.map((s) => ({
		...s,
		team: sanitizeLandedIdentifier(s.team),
		gatewayId: sanitizeLandedIdentifier(s.gatewayId),
		sessionLabel: sanitizeLabel(s.sessionLabel) ?? undefined,
		description: sanitizeDescription(s.description) ?? undefined,
	}));
}

export class CrossDomainPresenceConsumer {
	// Map keys avoid prototype pollution.
	private state = new Map<string, LandedEntry>();
	private readonly planeRegistry: PlaneRegistry;
	private readonly restoredPlanes: Record<string, PlanePersistedState> | undefined;
	private readonly registered = new Set<string>();
	private readonly lastLandedAt = new Map<string, number>();
	private readonly pendingLand = new Map<string, { sessions: CrossDomainPresenceSession[]; timer: TimerHandle }>();
	private readonly minLandIntervalMs: number;
	private readonly ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;

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

	restore(data: unknown): void {
		const parsed = CrossDomainPresenceLandedFileSchema.safeParse(data);
		if (!parsed.success) return;
		this.state = new Map(Object.entries(parsed.data));
		// Re-register restored domains so the cap and teardown state stay aligned.
		for (const domainId of this.state.keys()) this.ensureRegistered(domainId);
	}

	snapshot(): Record<string, LandedEntry> {
		return Object.fromEntries(this.state);
	}

	ensureRegistered(domainId: string): boolean {
		// Register before first land so held polls can wake.
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
				// Bucket freshness so unchanged pulls do not wake every poll.
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

	land(srcDomainId: string, sessions: CrossDomainPresenceSession[]): void {
		// srcDomainId is sealer-verified, never payload-supplied.
		const now = this.ambient.now();
		const last = this.lastLandedAt.get(srcDomainId);
		if (last !== undefined && now - last < this.minLandIntervalMs) {
			this.schedulePendingLand(srcDomainId, sessions, this.minLandIntervalMs - (now - last));
			return;
		}
		this.applyLand(srcDomainId, sessions, now);
	}

	/** Coalesce rate-limited updates. */
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

	private applyLand(srcDomainId: string, sessions: CrossDomainPresenceSession[], now: number): void {
		// Gate registration before recording rate-limit state.
		if (!this.ensureRegistered(srcDomainId)) return;
		this.lastLandedAt.set(srcDomainId, now);
		this.state.set(srcDomainId, { sessions: sanitizeLandedSessions(sessions), lastRefreshedAt: now });
		this.planeRegistry.markDirty(crossDomainPresencePlaneName(srcDomainId));
	}

	teardown(domainId: string): void {
		// Discard boot-time state so relinking gets a fresh baseline.
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
