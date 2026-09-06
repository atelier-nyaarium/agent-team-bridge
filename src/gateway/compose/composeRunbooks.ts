import { openDurable } from "../../shared/durable-store.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { RunbookConsoleHandlers } from "../console/consoleTypes.js";
import { createRunbookStore } from "../runbooks/store.js";

export interface RunbookStageDeps {
	dataDir: string;
}

export interface RunbookStage {
	console: RunbookConsoleHandlers;
	/** The fire reads by id, which no console op does. */
	get: (runbookId: string) => Runbook | null;
}

export function composeRunbooks(deps: RunbookStageDeps): RunbookStage {
	const store = openDurable(deps.dataDir, "runbooks", (durable) => createRunbookStore({ store: durable }));
	return {
		get: (runbookId) => store.get(runbookId),
		console: {
			list: () => ({ runbooks: store.list() }),
			put: (runbook) => store.put(runbook),
			remove: (runbookId) => store.remove(runbookId),
		},
	};
}
