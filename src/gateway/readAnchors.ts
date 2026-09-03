import { z } from "zod";
import { fenced } from "../shared/migration-fence.js";
import { type PlanePersistedState, type PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import { mergeReadAnchor, type ReadAnchorEntry, readAnchorsPlaneName } from "../shared/read-anchor-rules.js";

const ReadAnchorEntrySchema = z.object({
	epoch: z.number().int(),
	seq: z.number().int().nonnegative(),
	at: z.number().int().nonnegative(),
});

export type { ReadAnchorEntry } from "../shared/read-anchor-rules.js";
export { readAnchorsPlaneName } from "../shared/read-anchor-rules.js";

const ReadAnchorsFileSchema = z.record(z.string(), z.record(z.string(), ReadAnchorEntrySchema));

/** Seq monotonic. Epochs compare by equality only. */
export class ReadAnchors {
	private state: Record<string, Record<string, ReadAnchorEntry>> = {};
	private readonly planeRegistry: PlaneRegistry;
	private readonly restoredPlanes: Record<string, PlanePersistedState> | undefined;

	constructor(planeRegistry: PlaneRegistry, restoredPlanes: Record<string, PlanePersistedState> | undefined) {
		this.planeRegistry = planeRegistry;
		this.restoredPlanes = restoredPlanes;
	}

	/** Malformed snapshots start empty. */
	restore(data: unknown): void {
		const parsed = ReadAnchorsFileSchema.safeParse(data);
		if (parsed.success) this.state = parsed.data;
	}

	snapshot(): Record<string, Record<string, ReadAnchorEntry>> {
		return this.state;
	}

	/** Lazily registers the owner's canonical plane. */
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

	/** Reports an anchor and returns whether it advanced. */
	report(ownerId: string, team: string, entry: ReadAnchorEntry): boolean {
		// Never advanced under the fence, so the reporter tries again after the window.
		if (fenced()) return false;
		this.ensureRegistered(ownerId);
		const result = mergeReadAnchor(this.state, ownerId, team, entry);
		this.state = result.state;
		return result.advanced;
	}
}
