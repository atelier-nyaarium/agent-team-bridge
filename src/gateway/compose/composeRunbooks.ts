import { openDurable } from "../../shared/durable-store.js";
import type { RunbookConsoleHandlers } from "../console/consoleTypes.js";
import { createRunbookStore } from "../runbooks/store.js";

export interface RunbookStageDeps {
	dataDir: string;
}

export interface RunbookStage {
	console: RunbookConsoleHandlers;
}

export function composeRunbooks(deps: RunbookStageDeps): RunbookStage {
	const store = openDurable(deps.dataDir, "runbooks", (durable) => createRunbookStore({ store: durable }));
	return {
		console: {
			get: (runbookId) => store.get(runbookId),
			list: () => ({ runbooks: store.list() }),
			put: (runbook) => store.put(runbook),
			remove: (runbookId) => store.remove(runbookId),
		},
	};
}
