import { describe, expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import type { CodexPersistedAgent } from "../shared/codex-agent.js";
import { type CodexCatalogWriter, type SessionRecord, SessionStore } from "../shared/session-store.js";
import { AGENT_ID, OPERATION_ID, requestedAgent } from "./helpers/codex-agent.js";

function setup(opts: { persistChecked?: (sessionStore: SessionStore) => void } = {}) {
	let sessionStore!: SessionStore;
	let catalogWriter: CodexCatalogWriter | undefined;
	sessionStore = new SessionStore({
		codexCatalogPersistence: {
			persistChecked: () => opts.persistChecked?.(sessionStore),
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
	const offlineCatalog = new Map<string, string>();
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({ auth, sessionStore, offlineCatalog, catalogWriter });
	const writer = catalogWriter;
	const setAgents = (owner: SessionRecord, agents: CodexPersistedAgent[]) =>
		writer.commit(owner, sessionStore.codexCatalog(owner)?.revision ?? 0, agents);
	return { auth, sessionStore, offlineCatalog, service, setAgents };
}

function confirmManaged(sessionStore: SessionStore, spawn: string) {
	const record = sessionStore.mint({ spawn, sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(record);
	sessionStore.activateBinding(record);
	sessionStore.confirm(sessionStore.teamOf(record));
	return { record, token };
}

describe("Codex session ownership and target resolution", () => {
	it("returns the exact bound session and ignores all caller-supplied identity", () => {
		const { sessionStore, service } = setup();
		const { record, token } = confirmManaged(sessionStore, "recipe-app");
		const req = new Request("http://gateway/codex?session=host.other", {
			headers: { "x-session-token": token },
		});

		expect(service.resolveOwner(req)).toBe(record);
		expect(service.resolveOwner(new Request("http://gateway/codex"))).toBeNull();
	});

	it("resolves devcontainers only from the authenticated offline catalog", () => {
		const { sessionStore, offlineCatalog, service } = setup();
		const { record } = confirmManaged(sessionStore, "recipe-app");

		expect(service.resolveExecutionTarget(record)).toBeNull();
		offlineCatalog.set("recipe-app", "/trusted/recipe-app");
		expect(service.resolveExecutionTarget(record)).toEqual({
			kind: "devcontainer",
			project: "recipe-app",
			hostProjectPath: "/trusted/recipe-app",
		});
		offlineCatalog.set("recipe-app", "../other-project");
		expect(service.resolveExecutionTarget(record)).toBeNull();
		offlineCatalog.set("recipe-app", "");
		expect(service.resolveExecutionTarget(record)).toBeNull();
	});

	it("uses the session store's frozen host workdir precedence", () => {
		const { sessionStore, service } = setup();
		const record = sessionStore.mint({
			spawn: "host",
			sessionLabel: "Renamed",
			workdirHint: "Original",
			workdirPath: "/projects/chosen",
		});

		expect(service.resolveExecutionTarget(record)).toEqual({
			kind: "host",
			workdirHint: "/projects/chosen",
		});
	});

	it("lets a caller's cwd override the session's own workdir for a host agent", () => {
		const { sessionStore, service } = setup();
		const record = sessionStore.mint({ spawn: "host", sessionLabel: "Work", workdirPath: "/projects/chosen" });

		expect(service.resolveExecutionTarget(record, "/projects/elsewhere")).toEqual({
			kind: "host",
			workdirHint: "/projects/elsewhere",
		});
		// Absent means the session's own, never a guess: an agent with no cwd lands where its session is.
		expect(service.resolveExecutionTarget(record)).toEqual({
			kind: "host",
			workdirHint: "/projects/chosen",
		});
	});

	it("looks up agents and operations only inside the confirmed owner's catalog", () => {
		const { sessionStore, service, setAgents } = setup();
		const mine = confirmManaged(sessionStore, "recipe-app");
		const foreign = confirmManaged(sessionStore, "other-app");
		const foreignAgent = requestedAgent();
		setAgents(foreign.record, [foreignAgent]);
		const mineRequest = new Request("http://gateway/codex", {
			headers: { "x-session-token": mine.token },
		});
		const foreignRequest = new Request("http://gateway/codex", {
			headers: { "x-session-token": foreign.token },
		});

		expect(service.resolveOwnedAgent(mineRequest, AGENT_ID)).toBeNull();
		expect(service.resolveOwnedAgent(mineRequest, "codex_ffffffffffffffffffffffffffffffff")).toBeNull();
		expect(service.resolveOwnedAgent(foreignRequest, AGENT_ID)).toEqual({
			owner: foreign.record,
			agent: foreignAgent,
		});
		expect(service.resolveOwnedOperation(mineRequest, AGENT_ID, OPERATION_ID)).toBeNull();
		expect(service.resolveOwnedOperation(foreignRequest, AGENT_ID, OPERATION_ID)).toEqual({
			owner: foreign.record,
			agent: foreignAgent,
			operation: foreignAgent.operations[0],
		});
	});
});
