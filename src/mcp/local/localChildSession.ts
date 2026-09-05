import type { LocalBackendSpec } from "./localAgentRuntime.js";
import type { LocalBackendSession } from "./localAgentSession.js";

export interface LocalChildHost {
	spec: LocalBackendSpec;
	now(): number;
	inFlight(): number;
	hasActiveTurn(): boolean;
	onActivity(turnId: string, text: string): void;
}

/** Idle duration before local child reaping. */
export const LOCAL_IDLE_REAP_MS = 10 * 60_000;

export class LocalChildSession {
	private session?: LocalBackendSession;
	private opening?: Promise<LocalBackendSession>;
	/** Child activity clock, independent of agent timestamps. */
	private lastUsedAt = 0;
	private idleTimer?: ReturnType<typeof setInterval>;

	constructor(private readonly host: LocalChildHost) {}

	reapIfIdle(): boolean {
		if (!this.session || !this.host.spec.threadsResumable) return false;
		if (this.host.inFlight() > 0) return false;
		if (this.host.now() - this.lastUsedAt < LOCAL_IDLE_REAP_MS) return false;
		if (this.host.hasActiveTurn()) return false;
		// Clear locally even if close omits its callback.
		this.session.close();
		this.session = undefined;
		this.opening = undefined;
		return true;
	}

	markUsed(at: number = this.host.now()): void {
		this.lastUsedAt = Math.max(this.lastUsedAt, at);
	}

	open(): Promise<LocalBackendSession> {
		if (this.session) return Promise.resolve(this.session);
		this.startIdleReaper();
		// Share one child to avoid duplicate readers and ID spaces.
		this.opening ??= this.host.spec
			.openSession()
			.then((session) => {
				this.session = session;
				session.onActivity((turnId, text) => this.host.onActivity(turnId, text));
				// Identity-guard late closes from evicting successors.
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

	shutdown(): void {
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.idleTimer = undefined;
		this.session?.close();
		this.session = undefined;
		this.opening = undefined;
	}

	private startIdleReaper(): void {
		if (this.idleTimer || !this.host.spec.threadsResumable) return;
		this.idleTimer = setInterval(() => this.reapIfIdle(), LOCAL_IDLE_REAP_MS / 2);
		this.idleTimer.unref?.();
	}
}
