// What the local runtime needs from a backend, and nothing else. The runtime owns the catalog, the
// wait budget and the answer shape; a session owns only the protocol it speaks to its own child.

////////////////////////////////
//  Interfaces & Types

/** How a turn ended. The same three outcomes the daemon path reports, so a local answer and a
 * coordinated one describe a finished turn identically. */
export type LocalTerminal =
	| { status: "completed"; finalResponse?: string }
	| { status: "failed"; error: string }
	| { status: "interrupted" };

/**
 * A dispatched turn: its id now, its outcome later.
 *
 * Split because the two backends learn the id at different moments. Codex answers `turn/start` with
 * one and reports the terminal over its event stream; Copilot's prompt call carries both and only
 * settles at the end, so its id is minted locally. Every caller wants the id before the outcome,
 * which is what makes this the shape rather than a single promise.
 */
export interface LocalTurnHandle {
	turnId: string;
	/** Never rejects. A backend failure is a `failed` terminal, so a caller racing this against the
	 * wait budget cannot lose the agent to an unhandled rejection. */
	settled: Promise<LocalTerminal>;
}

export interface LocalBackendSession {
	/** A conversation on this backend. Its working directory is fixed here for the thread's life. */
	openThread(options: { cwd: string; model?: string }): Promise<string>;
	startTurn(threadId: string, prompt: string): Promise<LocalTurnHandle>;
	/** Redirect a RUNNING turn, keeping its id. Absent on a backend with no steer operation, which is
	 * what makes "this backend cannot take a follow-up while working" a type-level fact rather than a
	 * runtime discovery. */
	steerTurn?(threadId: string, turnId: string, prompt: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** Narration as it arrives. Text only: the runtime caps and numbers what it keeps. */
	onActivity(listener: (turnId: string, text: string) => void): void;
	/**
	 * The child is gone and this session can serve nothing further.
	 *
	 * Load-bearing rather than informational: the runtime caches the open session, so without this a
	 * dead child stays cached forever and every later call is dispatched into a closed pipe.
	 */
	onClosed(listener: () => void): void;
	close(): void;
}
