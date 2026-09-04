////////////////////////////////
//  Interfaces & Types

/** One bump of the data directory's schema: the retired files it removes, run once. */
export interface SchemaStep {
	version: number;
	files: string[];
}

////////////////////////////////
//  Functions & Helpers

/**
 * The steps a boot at `current` still owes, in order. A step never repeats: the step to 2 removed
 * live delivery state that has since been rebuilt, so re-running it on a later bump would delete
 * the rebuilt files.
 */
export function dueSchemaSteps(current: number, steps: ReadonlyArray<SchemaStep>): SchemaStep[] {
	return steps.filter((step) => step.version > current);
}

/** The sentinel's number; a missing or unreadable sentinel is a fresh directory. */
export function schemaVersionOf(sentinel: string | null): number {
	const parsed = Number(sentinel?.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
