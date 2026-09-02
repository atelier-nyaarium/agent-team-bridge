import fs from "node:fs";

export class DomainQuota {
	private readonly usage = new Map<string, number>();
	private readonly reservations = new Map<string, number>();
	private readonly dir: string;
	private readonly limitBytes: number;
	private readonly reserveBytes: number;
	private readonly statfs: (dir: string) => { available: number };

	constructor(opts: {
		dir: string;
		limitBytes: number;
		reserveBytes?: number;
		statfs?: (dir: string) => { available: number };
	}) {
		this.dir = opts.dir;
		this.limitBytes = opts.limitBytes;
		this.reserveBytes = opts.reserveBytes ?? 64 * 1024 * 1024;
		this.statfs =
			opts.statfs ??
			((dir) => {
				const stats = fs.statfsSync(dir);
				return { available: Number(stats.bavail) * Number(stats.bsize) };
			});
	}

	settle(ownerDir: string, bytes: number): void {
		this.usage.set(ownerDir, Math.max(0, bytes));
		this.reservations.delete(ownerDir);
	}

	release(ownerDir: string, bytes: number): void {
		this.reservations.set(ownerDir, Math.max(0, (this.reservations.get(ownerDir) ?? 0) - bytes));
	}

	reserve(ownerDir: string, bytes: number): { ok: true } | { ok: false; reason: "quota" | "reserve" } {
		const used = [...this.usage.values()].reduce((sum, value) => sum + value, 0);
		const reserved = [...this.reservations.values()].reduce((sum, value) => sum + value, 0);
		if (used + reserved + bytes > this.limitBytes) return { ok: false, reason: "quota" };
		try {
			if (this.statfs(this.dir).available < this.reserveBytes + bytes) return { ok: false, reason: "reserve" };
		} catch {
			return { ok: false, reason: "reserve" };
		}
		this.reservations.set(ownerDir, (this.reservations.get(ownerDir) ?? 0) + bytes);
		return { ok: true };
	}
}
