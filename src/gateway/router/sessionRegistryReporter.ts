import type { SessionRecord, SessionStore } from "../../shared/session-store.js";

export interface SessionRegistryReporterDeps {
	sessionStore: SessionStore;
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	incarnation: () => number | null;
	localGatewayId: string;
}

export function createSessionRegistryReporter(deps: SessionRegistryReporterDeps) {
	const known = new Set<string>();
	const pendingTombstones = new Set<string>();
	const sessionIdOf = (record: SessionRecord) => `${record.spawn}.${record.id}`;

	function upsert(record: SessionRecord): void {
		const sessionId = sessionIdOf(record);
		pendingTombstones.delete(sessionId);
		known.add(sessionId);
		const incarnation = deps.incarnation();
		if (incarnation === null) return;
		void deps.send("session_upsert", {
			sessionId,
			kind: "session",
			label: record.sessionLabel,
			recordExists: true,
			incarnation,
		});
	}

	function forget(record: SessionRecord): void {
		const sessionId = sessionIdOf(record);
		known.delete(sessionId);
		const incarnation = deps.incarnation();
		if (incarnation === null) {
			pendingTombstones.add(sessionId);
			return;
		}
		void sendForget(sessionId, incarnation);
	}

	async function sendForget(sessionId: string, incarnation: number): Promise<void> {
		try {
			const result = (await deps.send("session_forget", { sessionId, incarnation })) as
				| { error?: unknown; result?: { ok?: boolean } }
				| undefined;
			if (!result?.error && result?.result?.ok === true) pendingTombstones.delete(sessionId);
		} catch {
			return;
		}
	}

	let restore: (() => void) | null = null;

	function attach(): void {
		const store = deps.sessionStore as unknown as {
			create: (id: string, opts: Parameters<SessionStore["mint"]>[0]) => SessionRecord;
			forget: SessionStore["forget"];
			sweep: SessionStore["sweep"];
		};
		const create = store.create;
		const forgetRecord = store.forget;
		const sweep = store.sweep;
		restore = () => {
			store.create = create;
			store.forget = forgetRecord;
			store.sweep = sweep;
		};
		store.create = (id, opts) => {
			const record = create.call(deps.sessionStore, id, opts);
			upsert(record);
			return record;
		};
		store.forget = (team) => {
			const record = deps.sessionStore.getByTeam(team);
			const removed = forgetRecord.call(deps.sessionStore, team);
			if (removed && record) forget(record);
			return removed;
		};
		store.sweep = (ttlMs, cap) => {
			const records = new Map(
				deps.sessionStore.list().map((record) => [deps.sessionStore.teamOf(record), record]),
			);
			const removed = sweep.call(deps.sessionStore, ttlMs, cap);
			for (const team of removed) {
				const record = records.get(team);
				if (record) forget(record);
			}
			return removed;
		};
	}

	function detach(): void {
		restore?.();
		restore = null;
	}

	function reconcile(): void {
		const current = new Set<string>();
		for (const record of deps.sessionStore.list()) {
			const sessionId = sessionIdOf(record);
			current.add(sessionId);
			upsert(record);
		}
		const incarnation = deps.incarnation();
		if (incarnation !== null) {
			for (const sessionId of pendingTombstones) void sendForget(sessionId, incarnation);
			for (const sessionId of known) {
				if (current.has(sessionId)) continue;
				void sendForget(sessionId, incarnation);
			}
		}
		known.clear();
		for (const sessionId of current) known.add(sessionId);
	}

	return { attach, detach, upsert, reconcile };
}
