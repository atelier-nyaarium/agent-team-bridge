import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";

export interface SessionRegistryReporterDeps {
	sessionStore: SessionStore;
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	incarnation: () => number | null;
	localGatewayId: string;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
}

/** A write the Router did not take waits this long before the next attempt. */
export const SESSION_REGISTRY_RETRY_MS = 10_000;

export function createSessionRegistryReporter(deps: SessionRegistryReporterDeps) {
	const known = new Set<string>();
	const pendingUpserts = new Map<string, SessionRecord>();
	const pendingTombstones = new Set<string>();
	let retry: TimerHandle | null = null;
	const sessionIdOf = (record: SessionRecord) => `${record.spawn}.${record.id}`;

	const landed = (answer: unknown): boolean => {
		const reply = answer as { error?: unknown; result?: { ok?: boolean } } | undefined;
		return !reply?.error && reply?.result?.ok === true;
	};

	function scheduleRetry(): void {
		if (retry !== null) return;
		retry = deps.ambient.setTimer(() => {
			retry = null;
			flush();
		}, SESSION_REGISTRY_RETRY_MS);
	}

	async function sendUpsert(record: SessionRecord, incarnation: number): Promise<void> {
		const sessionId = sessionIdOf(record);
		let taken = false;
		try {
			taken = landed(
				await deps.send("session_upsert", {
					sessionId,
					kind: "session",
					label: record.sessionLabel,
					recordExists: true,
					incarnation,
				}),
			);
		} catch {
			taken = false;
		}
		if (taken) {
			if (pendingUpserts.get(sessionId) === record) pendingUpserts.delete(sessionId);
			return;
		}
		if (known.has(sessionId)) {
			pendingUpserts.set(sessionId, record);
			scheduleRetry();
		}
	}

	async function sendForget(sessionId: string, incarnation: number): Promise<void> {
		let taken = false;
		try {
			taken = landed(await deps.send("session_forget", { sessionId, incarnation }));
		} catch {
			taken = false;
		}
		if (taken) pendingTombstones.delete(sessionId);
		else if (pendingTombstones.has(sessionId)) scheduleRetry();
	}

	function upsert(record: SessionRecord): void {
		const sessionId = sessionIdOf(record);
		pendingTombstones.delete(sessionId);
		known.add(sessionId);
		pendingUpserts.set(sessionId, record);
		const incarnation = deps.incarnation();
		if (incarnation === null) return;
		void sendUpsert(record, incarnation);
	}

	function forget(record: SessionRecord): void {
		const sessionId = sessionIdOf(record);
		known.delete(sessionId);
		pendingUpserts.delete(sessionId);
		pendingTombstones.add(sessionId);
		const incarnation = deps.incarnation();
		if (incarnation === null) return;
		void sendForget(sessionId, incarnation);
	}

	/** Re-sends what the Router has not taken yet. */
	function flush(): void {
		const incarnation = deps.incarnation();
		if (incarnation === null) return;
		for (const record of pendingUpserts.values()) void sendUpsert(record, incarnation);
		for (const sessionId of pendingTombstones) void sendForget(sessionId, incarnation);
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
		if (retry !== null) deps.ambient.clearTimer(retry);
		retry = null;
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
				pendingTombstones.add(sessionId);
				void sendForget(sessionId, incarnation);
			}
		}
		known.clear();
		for (const sessionId of current) known.add(sessionId);
	}

	return { attach, detach, upsert, reconcile };
}
