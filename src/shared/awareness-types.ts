import type { ActAxis } from "./types.js";

export interface Change<S> {
	/** First pre-state and last post-state since the previous drain. */
	identity: string;
	pre: S | undefined;
	post: S | undefined;
}

export interface AwarenessObservation<S> {
	sessionKey: string;
	identity: string;
	pre: S | undefined;
	post: S | undefined;
}

export interface AwarenessSubscriber<S> {
	readonly source: string;
	/** Decides whether a change arms a deadline and stamps its push. */
	act(sessionKey: string, pre: S | undefined, post: S | undefined): ActAxis;
	/** Empty output suppresses delivery. */
	render(sessionKey: string, changes: readonly Change<S>[]): string;
}
