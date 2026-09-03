import fs from "node:fs";
import path from "node:path";
import { renameFileSync } from "../../shared/atomic-write.js";

export class OwnerLockHeld extends Error {
	readonly name = "OwnerLockHeld";
	constructor(readonly pid?: number) {
		super("owner lock held");
	}
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
	private readonly fd: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	private lost = false;
	private fdClosed = false;
	private lastError: string | null = null;

	private constructor(file: string, fd: number, generation: number, heartbeatMs: number) {
		this.file = file;
		this.fd = fd;
		this.generation = generation;
		this.timer = setInterval(() => this.refresh(), heartbeatMs);
		this.timer.unref?.();
	}

	static open(directory: string, heartbeatMs = 5000, staleMs = 30000): OwnerLock {
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, "owner.lock");
		let prior: LockFile | undefined;
		let priorIno: number | undefined;
		try {
			priorIno = fs.statSync(file).ino;
			prior = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
		} catch {}
		if (prior && alive(prior.pid) && Date.now() - prior.heartbeatAt <= staleMs) throw new OwnerLockHeld(prior.pid);
		const generation = (prior?.generation ?? 0) + 1;
		// Move aside only the inspected lock.
		if (priorIno !== undefined) {
			const aside = `${file}.stale.${process.pid}`;
			try {
				renameFileSync(file, aside);
			} catch {}
			let movedIno: number | undefined;
			try {
				movedIno = fs.statSync(aside).ino;
			} catch {}
			if (movedIno !== undefined && movedIno !== priorIno) {
				try {
					renameFileSync(aside, file);
				} catch {}
				throw new OwnerLockHeld();
			}
			fs.rmSync(aside, { force: true });
		}
		try {
			const fd = createLockFile(file, generation);
			return new OwnerLock(file, fd, generation, heartbeatMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new OwnerLockHeld();
			throw error;
		}
	}

	stillOwned(): boolean {
		if (this.lost) return false;
		try {
			const pathStat = fs.statSync(this.file);
			const fdStat = fs.fstatSync(this.fd);
			if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) return false;
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
		if (!this.fdClosed) {
			fs.closeSync(this.fd);
			this.fdClosed = true;
		}
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
		const bytes = Buffer.from(
			JSON.stringify({ pid: process.pid, generation: this.generation, heartbeatAt: Date.now() }),
		);
		fs.ftruncateSync(this.fd, 0);
		fs.writeSync(this.fd, bytes, 0, bytes.length, 0);
		fs.fsyncSync(this.fd);
	}
}

function createLockFile(file: string, generation: number): number {
	const fd = fs.openSync(file, "wx", 0o600);
	const bytes = Buffer.from(JSON.stringify({ pid: process.pid, generation, heartbeatAt: Date.now() }));
	fs.writeSync(fd, bytes, 0, bytes.length, 0);
	fs.fsyncSync(fd);
	return fd;
}
