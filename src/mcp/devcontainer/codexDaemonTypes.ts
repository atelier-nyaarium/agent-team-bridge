import type { AppServerSession } from "./codexAppServerSession.js";
import type { CodexChild, TargetSupervisor } from "./codexTargets.js";
import type { CodexTurnTracker } from "./codexTurnTracker.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexDaemonDeps {
	targets: TargetSupervisor;
	daemonInstanceId: string;
	send(message: Record<string, unknown>): void;
	openClient?(child: CodexChild, model: string): Promise<AppServerSession>;
	/** A hint may be a picked path or a bare label; the rule lives in the host daemon. */
	resolveHostCwd(hint: string | undefined): string;
	now?(): number;
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
}
