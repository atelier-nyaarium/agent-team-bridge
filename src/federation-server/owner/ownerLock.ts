import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";

export class OwnerLockHeld extends Error {
	readonly name = "OwnerLockHeld";
}

type LockFile = { pid: number; generation: number; heartbeatAt: number };

function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class OwnerLock {
	readonly generation: number;
	private readonly file: string;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	private lost = false;
	private lastError: string | null = null;

	private constructor(file: string, generation: number, heartbeatMs: number) {
		this.file = file;
		this.generation = generation;
		this.timer = setInterval(() => this.refresh(), heartbeatMs);
		this.timer.unref?.();
	}

	static open(directory: string, heartbeatMs = 5000, staleMs = 30000): OwnerLock {
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, "owner.lock");
		let prior: LockFile | undefined;
		try {
			prior = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
		} catch {}
		if (prior && alive(prior.pid) && Date.now() - prior.heartbeatAt <= staleMs) throw new OwnerLockHeld();
		const generation = (prior?.generation ?? 0) + 1;
		const lock = new OwnerLock(file, generation, heartbeatMs);
		lock.write();
		return lock;
	}

	stillOwned(): boolean {
		if (this.lost) return false;
		try {
			const lock = JSON.parse(fs.readFileSync(this.file, "utf8")) as LockFile;
			return lock.pid === process.pid && lock.generation === this.generation;
		} catch {
			return false;
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.stillOwned()) fs.rmSync(this.file, { force: true });
	}

	/** Do not overwrite a successor lock. */
	private refresh(): void {
		if (this.stopped) return;
		if (!this.stillOwned()) {
			this.lost = true;
			this.stop();
			return;
		}
		try {
			this.write();
			this.lastError = null;
		} catch (error) {
			const message = String(error);
			if (message !== this.lastError) console.warn(`[owner-lock] heartbeat failed for ${this.file}: ${message}`);
			this.lastError = message;
		}
	}

	private write(): void {
		writeFileAtomic(
			this.file,
			JSON.stringify({ pid: process.pid, generation: this.generation, heartbeatAt: Date.now() }),
			{
				mode: 0o600,
				fsyncFile: true,
			},
		);
	}
}
