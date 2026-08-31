import type { LifecycleHooks } from "./codexAppServer.js";
import type { AppServerSession } from "./codexAppServerSession.js";
import type { CodexChild, TargetSupervisor } from "./codexTargets.js";
import type { CodexTurnTracker } from "./codexTurnTracker.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexDaemonDeps {
	targets: TargetSupervisor;
	daemonInstanceId: string;
	send(message: Record<string, unknown>): void;
	openClient?(child: CodexChild, model: string, hooks: LifecycleHooks): Promise<AppServerSession>;
	/** A hint may be a picked path or a bare label; the rule lives in the host daemon. */
	resolveHostCwd(hint: string | undefined): string;
	/** The one clock the deadline, the watchdog and the reaper read. */
	now?(): number;
	/** Test seam for the held-terminal deadline. */
	setTimer?(run: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimer?(handle: ReturnType<typeof setTimeout>): void;
	setSweep?(run: () => void, ms: number): ReturnType<typeof setInterval>;
	clearSweep?(handle: ReturnType<typeof setInterval>): void;
}

/** The App Server knows nothing of agents, so every event correlates back through this. */
export interface TurnBinding {
	ownerKey: string;
	agentId: string;
	threadId: string;
}

export interface TargetSession {
	targetId: string;
	generation: number;
	client: AppServerSession;
	tracker: CodexTurnTracker;
	nextEventId: number;
	turns: Map<string, TurnBinding>;
	threads: Map<string, TurnBinding>;
	/** A terminal the tracker holds for its final item, and the deadline that settles it regardless. */
	held: Map<string, ReturnType<typeof setTimeout>>;
	/** Per turn: when it last made progress, and how many times the watchdog has acted on it. */
	watch: Map<string, { at: number; strikes: number }>;
	/** Stamped on a command and on a server event, which is what the reaper's quiet period measures. */
	usedAt: number;
}
