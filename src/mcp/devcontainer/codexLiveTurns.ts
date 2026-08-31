import type { TurnBinding } from "./codexDaemonTypes.js";

////////////////////////////////
//  Interfaces & Types

export interface OverdueTurn {
	turnId: string;
	binding: TurnBinding;
	/** The watchdog has already acted on this one, so the next answer is the last one it gets. */
	warned: boolean;
}

////////////////////////////////
//  Class

/**
 * The turns one generation holds, each with the clock and the strikes the watchdog measures it by.
 *
 * One record, so a clock cannot exist apart from the turn it belongs to. Keeping identity in one map
 * and liveness in another, both keyed by turn id alone, kept four mistakes expressible and shipped
 * three of them: another thread's frame refreshing this turn, a turn falling back to a clock its
 * neighbours refresh, a rebind wiping the strikes, and a turn whose thread nobody checked.
 */
export class CodexLiveTurns {
	private readonly held = new Map<string, { binding: TurnBinding; at: number; strikes: number }>();

	constructor(private readonly now: () => number) {}

	get size(): number {
		return this.held.size;
	}

	/** Rebinding keeps the strikes already earned: the gateway asking again is not the turn working. */
	bind(turnId: string, binding: TurnBinding): void {
		const known = this.held.get(turnId);
		if (known) {
			known.binding = binding;
			return;
		}
		this.held.set(turnId, { binding, at: this.now(), strikes: 0 });
	}

	has(turnId: string): boolean {
		return this.held.has(turnId);
	}

	forget(turnId: string): void {
		this.held.delete(turnId);
	}

	/** The binding only when its thread agrees: a turn id alone belongs to no thread in particular. */
	bindingOn(threadId: string, turnId: string): TurnBinding | undefined {
		const known = this.held.get(turnId);
		return known?.binding.threadId === threadId ? known.binding : undefined;
	}

	/** A frame from the turn's own thread, which is the only thing that counts as it working. */
	saw(threadId: string, turnId: string): void {
		const known = this.held.get(turnId);
		if (known?.binding.threadId !== threadId) return;
		known.at = this.now();
		known.strikes = 0;
	}

	/** Turns silent for `ms`, each saying whether the watchdog has already acted on it. */
	overdue(ms: number): OverdueTurn[] {
		const cutoff = this.now() - ms;
		const out: OverdueTurn[] = [];
		for (const [turnId, known] of this.held) {
			if (known.at <= cutoff) out.push({ turnId, binding: known.binding, warned: known.strikes > 0 });
		}
		return out;
	}

	/** The watchdog acted, so the turn owes its next answer from now. */
	warn(turnId: string): void {
		const known = this.held.get(turnId);
		if (!known) return;
		known.at = this.now();
		known.strikes += 1;
	}
}
