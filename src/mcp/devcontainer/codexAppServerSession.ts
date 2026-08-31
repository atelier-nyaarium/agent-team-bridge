import { CodexAppServerClient, createJsonlTransport, type LifecycleHooks } from "./codexAppServer.js";
import type { CodexChild } from "./codexTargets.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

/** Separate from the client class so a test can stand in without a child process. */
export interface AppServerSession {
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	startThread(settings: { cwd: string; model?: string }): Promise<string>;
	resumeThread(threadId: string): Promise<void>;
	readThread(threadId: string): Promise<unknown>;
	startTurn(threadId: string, text: string): Promise<string>;
	steerTurn(threadId: string, turnId: string, text: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** The one entry for a terminal, whichever observer saw it; the thread parks behind it. */
	settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome): Promise<void>;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

export async function defaultOpenClient(
	child: CodexChild,
	model: string,
	hooks: LifecycleHooks = {},
): Promise<CodexAppServerClient> {
	return CodexAppServerClient.open(createJsonlTransport(child), model, hooks);
}
