// The phone is every runbook's sole author, so revision is the only concurrency control.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { RUNBOOKS_MAX, type Runbook, RunbookSchema, runbookRefusal } from "../../shared/schemasRunbook.js";

export interface RunbookStoreDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
}

export interface RunbookPutResult {
	stored: boolean;
	revision: number;
	reason?: string;
}

const RunbooksSchema = z.array(RunbookSchema);

/** A frozen copy, so neither a reader nor the caller that pushed it can edit what the store holds. */
function frozen(runbook: Runbook): Runbook {
	const parameters = runbook.parameters.map((parameter) => {
		const copy = { ...parameter };
		if (copy.options) {
			copy.options = [...copy.options];
			Object.freeze(copy.options);
		}
		return Object.freeze(copy);
	});
	Object.freeze(parameters);
	return Object.freeze({ ...runbook, parameters });
}

/** Two records the owner would call the same. Compared field by field, never by key order. */
function sameContent(a: Runbook, b: Runbook): boolean {
	return (
		a.name === b.name &&
		a.body === b.body &&
		a.parameters.length === b.parameters.length &&
		a.parameters.every((parameter, i) => {
			const other = b.parameters[i] as (typeof b.parameters)[number];
			return (
				parameter.name === other.name &&
				parameter.label === other.label &&
				parameter.kind === other.kind &&
				parameter.default === other.default &&
				(parameter.options ?? []).length === (other.options ?? []).length &&
				(parameter.options ?? []).every((option, j) => option === (other.options ?? [])[j])
			);
		})
	);
}

export function createRunbookStore(deps: RunbookStoreDeps) {
	const { store } = deps;
	// Restore keeps whatever the schema accepts. `put` is the only writer, so the semantic rules ran
	// before anything landed, and discarding a record here would erase it on the next write.
	let runbooks: Runbook[] = RunbooksSchema.parse(store.load() ?? []).map(frozen);

	/** A write the phone is told landed is on disk first. */
	const commit = (next: Runbook[]): boolean => {
		const previous = runbooks;
		runbooks = next;
		try {
			store.saveChecked(runbooks);
			return true;
		} catch (error) {
			// An installed snapshot is what a reopen reads.
			if (error instanceof DurableStoreInstalledError) return true;
			runbooks = previous;
			console.warn(`[runbook] write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const held = (id: string): Runbook | undefined => runbooks.find((runbook) => runbook.id === id);

	/** A shared name still gives one order. */
	const list = (): Runbook[] =>
		[...runbooks].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): Runbook | null => held(id) ?? null;

	const put = (incoming: Runbook): RunbookPutResult => {
		const runbook = frozen(incoming);
		const current = held(runbook.id);
		const refusal = runbookRefusal(runbook);
		if (refusal) return { stored: false, revision: current?.revision ?? 0, reason: refusal };
		if (current && runbook.revision === current.revision) {
			// An unchanged re-push is a retry; a changed one at that revision is a lost update.
			if (sameContent(runbook, current)) return { stored: true, revision: current.revision };
			return {
				stored: false,
				revision: current.revision,
				reason: `a different edit is already stored as revision ${current.revision}; edit that one`,
			};
		}
		if (current && runbook.revision < current.revision) {
			return { stored: false, revision: current.revision, reason: "a newer revision is already stored" };
		}
		if (!current && runbooks.length >= RUNBOOKS_MAX) {
			return {
				stored: false,
				revision: 0,
				reason: `this gateway already holds ${RUNBOOKS_MAX} runbooks; delete one first`,
			};
		}
		const next = current
			? runbooks.map((existing) => (existing.id === runbook.id ? runbook : existing))
			: [...runbooks, runbook];
		if (!commit(next)) return { stored: false, revision: current?.revision ?? 0, reason: "could not be written" };
		return { stored: true, revision: runbook.revision };
	};

	const remove = (id: string): { deleted: boolean } => {
		const kept = runbooks.filter((runbook) => runbook.id !== id);
		if (kept.length === runbooks.length) return { deleted: false };
		return { deleted: commit(kept) };
	};

	return { list, get, put, remove };
}

export type RunbookStore = ReturnType<typeof createRunbookStore>;
