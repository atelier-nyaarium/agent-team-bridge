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
	/** Turns a host session's workdir HINT into a real directory. Injected because the rule lives in
	 * the host daemon, and a hint may be a console-picked path or a bare human label. */
	resolveHostCwd(hint: string | undefined): string;
	now?(): number;
}

/** Which agent a native turn belongs to. The App Server knows nothing of agents, so every event it
 * emits is correlated back through this. */
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
