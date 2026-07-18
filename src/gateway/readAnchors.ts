import { z } from "zod";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";

////////////////////////////////
//  Schemas

const ReadAnchorEntrySchema = z.object({
	epoch: z.number().int(),
	seq: z.number().int().nonnegative(),
	at: z.number().int().nonnegative(),
});
export type ReadAnchorEntry = z.infer<typeof ReadAnchorEntrySchema>;

const ReadAnchorsFileSchema = z.record(z.string(), z.record(z.string(), ReadAnchorEntrySchema));

////////////////////////////////
//  Functions & Helpers

/** Cap on distinct team keys tracked per owner - report_read's `team` is an unauthenticated,
 * free-form string never checked against a real session, so nothing else bounds how many an
 * abusive or buggy device could invent. Mirrors DeviceMailboxStore's own DEFAULT_MAX_DEVICES
 * (device-mailbox.ts) as this codebase's established order of magnitude for a per-owner cap - a
 * real owner's distinct teams over the store's whole retention window stay far below this. */
const MAX_TEAMS_PER_OWNER = 500;

/** The plane name a given owner's read-anchor sync rides under - one plane PER OWNER, never a
 * single Gateway-wide plane, so a bug in the wire-assembly step cannot leak one owner's read
 * positions (personal data - what they have and have not read) to a different owner sharing the
 * same Gateway process. Exported so consoleHandler.ts's poll case can name the exact plane a
 * given ownerId's own poll should present a version for and read a snapshot from. */
export function readAnchorsPlaneName(ownerId: string): string {
	return `read-anchors:${ownerId}`;
}

////////////////////////////////
//  Class

/**
 * Per-owner, per-team read-position sync: "how far has ANY of this owner's own devices read this
 * conversation", merged monotonically - a device reporting a STALE position (it was offline, or
 * simply has not scrolled as far yet) can never regress what another of the SAME owner's devices
 * already confirmed read. Mailbox epoch/seq numbering is meaningful across an owner's whole device
 * fleet because the mailbox itself is already shared per owner (device-mailbox.ts), not per
 * device, so no cross-device epoch reconciliation is needed - only within-epoch seq comparison,
 * and a newer epoch entirely (the mailbox was reset) always wins outright.
 *
 * Read anchors are LOW-STAKES data: losing a few seconds of sync on an unclean crash just means a
 * transient over-count on another device until its next report self-heals it, never a security or
 * correctness concern the way a lost trust link would be. So this is a plain in-memory store
 * persisted on the SAME periodic/shutdown cadence as sessions/jobs/mailboxes (via the caller's own
 * snapshot()/restore() calls into the shared durable-state file), not a write-through-every-
 * mutation store like CrossDomainPeers.
 */
export class ReadAnchors {
	private state: Record<string, Record<string, ReadAnchorEntry>> = {};
	private readonly planeRegistry: PlaneRegistry;
	private readonly restoredPlanes: Record<string, PlanePersistedState> | undefined;

	constructor(planeRegistry: PlaneRegistry, restoredPlanes: Record<string, PlanePersistedState> | undefined) {
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
	}

	/** Restore the raw per-owner data from a durable snapshot (the SAME atomic file
	 * sessionResumeDurable already persists sessions/planes into - see index.ts). A malformed or
	 * absent snapshot starts empty rather than failing boot. */
	restore(data: unknown): void {
		const parsed = ReadAnchorsFileSchema.safeParse(data);
		if (parsed.success) this.state = parsed.data;
	}

	/** The raw per-owner data, for the caller's own durable snapshot. */
	snapshot(): Record<string, Record<string, ReadAnchorEntry>> {
		return this.state;
	}

	/** Register this owner's plane if it is not already registered (lazy: there is no fixed set of
	 * owners known at boot the way there is exactly one presence plane). Idempotent - safe to call
	 * on every poll/report from an owner, only the first call per owner actually registers. Reads
	 * this owner's slice of a RESTORED durable snapshot (if any) so a gateway restart does not
	 * reset every owner's cross-device read-sync progress. The plane's own snapshot projects the
	 * internal team-keyed record into the wire's flat array shape (ReadAnchorWireEntrySchema - a
	 * map has no typed codegen representation outside the fixture gates), sorted by team so two
	 * calls with equivalent content always hash identically regardless of the record's own key
	 * insertion order (see PlaneRegistry.registerPlane's own canonical-ordering requirement). */
	ensureRegistered(ownerId: string): void {
		const name = readAnchorsPlaneName(ownerId);
		if (this.planeRegistry.hasPlane(name)) return;
		this.planeRegistry.registerPlane(
			{
				name,
				snapshot: () =>
					Object.entries(this.state[ownerId] ?? {})
						.map(([team, entry]) => ({ team, ...entry }))
						.sort((a, b) => a.team.localeCompare(b.team)),
				identityOf: (snapshot) => stableHash(snapshot),
			},
			this.restoredPlanes?.[name],
		);
	}

	/** Report one device's read position for a team. Monotonic: only accepted if strictly ahead of
	 * what is stored (a newer epoch entirely, or the same epoch with a higher seq) - a stale report
	 * from a device still catching up on an old position can never regress what another of the same
	 * owner's devices already confirmed read. Registers the owner's plane first (see
	 * ensureRegistered) if this is the very first thing ever reported or polled for them, so a
	 * caller can never forget the registration step and have this silently no-op. Returns true iff
	 * the stored anchor actually advanced (the caller's cue to markDirty the owner's plane). */
	report(ownerId: string, team: string, entry: ReadAnchorEntry): boolean {
		this.ensureRegistered(ownerId);
		if (!this.state[ownerId]) this.state[ownerId] = {};
		const owner = this.state[ownerId];
		const cur = owner[team];
		// A genuinely NEW team beyond the cap is refused outright (never stored) - an already-
		// tracked team's own updates are unaffected regardless of how many other teams this owner
		// has accumulated, since capping mid-conversation would be a real functional regression,
		// not a security boundary.
		if (!cur && Object.keys(owner).length >= MAX_TEAMS_PER_OWNER) return false;
		const advanced = !cur || entry.epoch > cur.epoch || (entry.epoch === cur.epoch && entry.seq > cur.seq);
		if (!advanced) return false;
		owner[team] = entry;
		return true;
	}
}
