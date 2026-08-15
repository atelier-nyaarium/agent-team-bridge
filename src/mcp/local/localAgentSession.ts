// The runtime owns the catalog, budget and answer shape; a session owns only its child's protocol.

////////////////////////////////
//  Interfaces & Types

/** The same three outcomes the daemon path reports. */
export type LocalTerminal =
	| { status: "completed"; finalResponse?: string }
	| { status: "failed"; error: string }
	| { status: "interrupted" };

/**
 * Its id now, its outcome later.
 *
 * Split because the backends learn the id at different moments: Codex answers `turn/start` with one,
 * while Copilot settles only at the end, so its id is minted locally.
 */
export interface LocalTurnHandle {
	turnId: string;
	/** Never rejects: a failure is a `failed` terminal, so racing it cannot lose the agent. */
	settled: Promise<LocalTerminal>;
}

export interface LocalBackendSession {
	/** The working directory is fixed here for the thread's life. */
	openThread(options: { cwd: string; model?: string }): Promise<string>;
	startTurn(threadId: string, prompt: string): Promise<LocalTurnHandle>;
	/** Absent on a backend with no steer, making "cannot follow up while working" a type-level fact. */
	steerTurn?(threadId: string, turnId: string, prompt: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** Text only: the runtime caps and numbers what it keeps. */
	onActivity(listener: (turnId: string, text: string) => void): void;
	/** Load-bearing: the runtime caches the session, so a dead child would stay cached forever. */
	onClosed(listener: () => void): void;
	close(): void;
}
