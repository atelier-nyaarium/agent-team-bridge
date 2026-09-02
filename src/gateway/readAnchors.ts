import { z } from "zod";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { mergeReadAnchor, type ReadAnchorEntry, readAnchorsPlaneName } from "../shared/read-anchor-rules.js";

////////////////////////////////
//  Schemas

const ReadAnchorEntrySchema = z.object({
	epoch: z.number().int(),
	seq: z.number().int().nonnegative(),
	at: z.number().int().nonnegative(),
});

export type { ReadAnchorEntry } from "../shared/read-anchor-rules.js";
export { readAnchorsPlaneName } from "../shared/read-anchor-rules.js";

const ReadAnchorsFileSchema = z.record(z.string(), z.record(z.string(), ReadAnchorEntrySchema));

////////////////////////////////
//  Functions & Helpers

////////////////////////////////
//  Class

/**
 * Per-owner, per-team read-position sync: "how far has ANY of this owner's own devices read this
 * conversation", merged monotonically - a device reporting a STALE position (it was offline, or
 * simply has not scrolled as far yet) can never regress what another of the SAME owner's devices
 * already confirmed read. Seq numbering is meaningful across an owner's whole device fleet because
 * the mailbox itself is already shared per owner (device-mailbox.ts), not per device. The epoch is
 * a random per-instance tag rather than a counter, so it compares for equality only and a re-minted
 * mailbox is ordered by report time instead.
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

	/** Report one device's read position for a team. Within one mailbox instance this is monotonic:
	 * a higher seq only, so a device still catching up can never regress what another of the same
	 * owner's devices confirmed read. Across a re-mint the epochs are unordered and the later report
	 * wins instead (see mergeReadAnchor). Registers the owner's plane first (see
	 * ensureRegistered) if this is the very first thing ever reported or polled for them, so a
	 * caller can never forget the registration step and have this silently no-op. Returns true iff
	 * the stored anchor actually advanced (the caller's cue to markDirty the owner's plane). */
	report(ownerId: string, team: string, entry: ReadAnchorEntry): boolean {
		this.ensureRegistered(ownerId);
		const result = mergeReadAnchor(this.state, ownerId, team, entry);
		this.state = result.state;
		return result.advanced;
	}
}
