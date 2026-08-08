import { CodexAgentService } from "../../gateway/codexAgentService.js";
import { createSessionAuthority } from "../../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../../gateway/websocket.js";
import { DurableStoreInstalledError } from "../../shared/durable-store.js";
import { type CodexCatalogWriter, SessionStore } from "../../shared/session-store.js";

////////////////////////////////
//  Functions & Helpers

export function setup(opts: { failSave?: (saveNumber: number) => boolean; installedFailure?: boolean } = {}) {
	let sessionStore!: SessionStore;
	let catalogWriter: CodexCatalogWriter | undefined;
	let saves = 0;
	const savedSnapshots: unknown[] = [];
	const persistChecked = () => {
		saves++;
		if (opts.failSave?.(saves)) {
			const cause = new Error("disk unavailable");
			throw opts.installedFailure ? new DurableStoreInstalledError(cause) : cause;
		}
		savedSnapshots.push(sessionStore.snapshot());
	};
	sessionStore = new SessionStore({
		codexCatalogPersistence: {
			persistChecked,
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	const offlineCatalog = new Map([["recipe-app", "/trusted/recipe-app"]]);
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({ auth, sessionStore, offlineCatalog, catalogWriter });
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	const request = new Request("http://gateway/codex", { headers: { "x-session-token": token } });
	return {
		request,
		owner,
		service,
		sessionStore,
		offlineCatalog,
		catalogWriter,
		savedSnapshots,
		saves: () => saves,
	};
}
