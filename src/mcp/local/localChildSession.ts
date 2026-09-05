import type { LocalBackendSpec } from "./localAgentRuntime.js";
import type { LocalBackendSession } from "./localAgentSession.js";

////////////////////////////////
//  Interfaces & Types

export interface LocalChildHost {
	spec: LocalBackendSpec;
	now(): number;
	inFlight(): number;
	hasActiveTurn(): boolean;
	onActivity(turnId: string, text: string): void;
}

////////////////////////////////
//  Constants

/**
 * How long a local child may sit with nothing running before it is reaped.
 *
 * The child is otherwise released only when the MCP's stdin closes, so an agent that used it once
 * and then idled held ~155MB for the rest of a long session - measured, and the reason this exists.
 * Generous, because re-opening costs a process launch and a thread resume: this reclaims the memory
 * of agents nobody came back to, and is not meant to fire between turns of a working one.
 */
export const LOCAL_IDLE_REAP_MS = 10 * 60_000;

////////////////////////////////
//  Class

/** The one local child process. */
export class LocalChildSession {
	private session?: LocalBackendSession;
	private opening?: Promise<LocalBackendSession>;
	/** When the child last had work. Distinct from any agent's updatedAt: a reap is about the CHILD. */
	private lastUsedAt = 0;
	private idleTimer?: ReturnType<typeof setInterval>;

	constructor(private readonly host: LocalChildHost) {}

	/**
	 * Release the child if nothing has used it for [LOCAL_IDLE_REAP_MS] and no turn is in flight.
	 *
	 * Returns whether it reaped, so a test can drive this without a clock. Refuses on a backend whose
	 * threads do not survive (see the spec field), and refuses while ANY agent has an active turn -
	 * closing settles every pending turn as failed, which would turn working agents into errors to
	 * reclaim memory, the exact trade this must never make.
	 */
	reapIfIdle(): boolean {
		if (!this.session || !this.host.spec.threadsResumable) return false;
		if (this.host.inFlight() > 0) return false;
		if (this.host.now() - this.lastUsedAt < LOCAL_IDLE_REAP_MS) return false;
		if (this.host.hasActiveTurn()) return false;
		// The session's own onClosed clears this.session; clearing here too keeps the reap correct
		// even for a backend whose close does not fire it.
		this.session.close();
		this.session = undefined;
		this.opening = undefined;
		return true;
	}

	/** The child's idle clock. Every child operation ends here, so "idle" means the CHILD went quiet
	 * rather than that some record happened not to be written. */
	markUsed(at: number = this.host.now()): void {
		this.lastUsedAt = Math.max(this.lastUsedAt, at);
	}

	open(): Promise<LocalBackendSession> {
		if (this.session) return Promise.resolve(this.session);
		this.startIdleReaper();
		// Shared: two opens would give one child two stdout readers and two colliding id spaces.
		this.opening ??= this.host.spec
			.openSession()
			.then((session) => {
				this.session = session;
				session.onActivity((turnId, text) => this.host.onActivity(turnId, text));
				// A cached dead child sends every later call into a closed pipe. Identity-guarded, so a
				// late close cannot evict its successor.
				session.onClosed(() => {
					if (this.session === session) this.session = undefined;
				});
				return session;
			})
			.finally(() => {
				this.opening = undefined;
			});
		return this.opening;
	}

	/** Reap the child, so it does not outlive the session that started it. */
	shutdown(): void {
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.idleTimer = undefined;
		this.session?.close();
		this.session = undefined;
		this.opening = undefined;
	}

	/** One timer for the runtime's life. unref'd, so an idle child never holds the process open. */
	private startIdleReaper(): void {
		if (this.idleTimer || !this.host.spec.threadsResumable) return;
		this.idleTimer = setInterval(() => this.reapIfIdle(), LOCAL_IDLE_REAP_MS / 2);
		this.idleTimer.unref?.();
	}
}
