import { CodexAppServerClient, createJsonlTransport } from "./codexAppServer.js";
import type { CodexChild } from "./codexTargets.js";

////////////////////////////////
//  Interfaces & Types

/** The App Server calls this service makes. Named separately from the client class so a test can
 * stand in for a child process without one. */
export interface AppServerSession {
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	startThread(settings: { cwd: string; model?: string }): Promise<string>;
	resumeThread(threadId: string): Promise<void>;
	readThread(threadId: string): Promise<unknown>;
	startTurn(threadId: string, text: string): Promise<string>;
	steerTurn(threadId: string, turnId: string, text: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

export async function defaultOpenClient(child: CodexChild, model: string): Promise<CodexAppServerClient> {
	return CodexAppServerClient.open(createJsonlTransport(child), model);
}
