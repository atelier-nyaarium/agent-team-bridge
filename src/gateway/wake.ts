////////////////////////////////
//  Interfaces & Types

interface WakeWaiter {
	resolve: (success: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

////////////////////////////////
//  Class

export class WakeCoordinator {
	private waiters = new Map<string, WakeWaiter[]>();

	waitFor(team: string, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.removeWaiter(team, entry);
				resolve(false);
			}, timeoutMs);
			const entry: WakeWaiter = { resolve, timer };
			if (!this.waiters.has(team)) this.waiters.set(team, []);
			this.waiters.get(team)!.push(entry);
		});
	}

	notify(team: string, success = true): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		for (const entry of entries) {
			clearTimeout(entry.timer);
			entry.resolve(success);
		}
		this.waiters.delete(team);
	}

	private removeWaiter(team: string, target: WakeWaiter): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const idx = entries.indexOf(target);
		if (idx >= 0) entries.splice(idx, 1);
		if (entries.length === 0) this.waiters.delete(team);
	}
}
