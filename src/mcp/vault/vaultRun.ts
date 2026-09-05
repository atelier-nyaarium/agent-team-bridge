// A child run with a vault value injected, and its output scrubbed of the value's bytes.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubChildEnv } from "../devcontainer/codexTargets.js";

export const OUTPUT_CAP_CHARS = 64 * 1024;
/** Bytes held raw until the scrub, so a value never straddles the cap. */
const RAW_CEILING_BYTES = 1024 * 1024;
export const SCRUB_MARK = "[vault]";
export const DEFAULT_ENV_NAME = "VAULT_VALUE";
export const FILE_ENV_NAME = "VAULT_FILE";
const TMPFS = "/dev/shm";
const KILL_GRACE_MS = 2_000;

export type VaultShape = "env" | "stdin" | "file";

export interface VaultRunInput {
	command: string;
	cwd?: string;
	shape: VaultShape;
	envName?: string;
	/** Absent for a capture-only run. */
	value?: string;
	/** Keeps the unscrubbed stdout for a capture; it never reaches an answer. */
	keepRawStdout?: boolean;
}

export interface VaultRunResult {
	exitCode: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	rawStdout?: string;
}

export interface VaultRunHandle {
	done: Promise<VaultRunResult>;
	kill: () => void;
}

/** The value's raw bytes never reach a result. */
export function scrubOutput(text: string, value: string | undefined): string {
	if (!value) return text;
	return text.split(value).join(SCRUB_MARK);
}

/** A 0600 file on tmpfs when it takes one, else the temp directory; the caller unlinks it. */
function writeValueFile(value: string): string {
	const name = `switchboard-vault-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	for (const dir of [TMPFS, os.tmpdir()]) {
		const file = path.join(dir, name);
		try {
			fs.writeFileSync(file, value, { mode: 0o600, flag: "wx" });
			return file;
		} catch {}
	}
	throw new Error("no directory takes the value file");
}

/** Bounded raw capture; a cut at the ceiling drops a window a value could straddle. */
function collector(valueLength: number) {
	const chunks: Buffer[] = [];
	let size = 0;
	let cut = false;
	return {
		push(chunk: Buffer) {
			if (cut) return;
			const room = RAW_CEILING_BYTES - size;
			if (chunk.length >= room) cut = true;
			chunks.push(chunk.subarray(0, room));
			size += Math.min(chunk.length, room);
		},
		raw(): string {
			const text = Buffer.concat(chunks).toString("utf8");
			return cut ? text.slice(0, Math.max(0, text.length - valueLength)) : text;
		},
		cut: () => cut,
	};
}

/** Scrubbed first, then capped, so the cap can only cut the mark. */
function bounded(text: string): { text: string; truncated: boolean } {
	return text.length > OUTPUT_CAP_CHARS
		? { text: text.slice(0, OUTPUT_CAP_CHARS), truncated: true }
		: { text, truncated: false };
}

/** Runs `sh -c command` with the value in the chosen shape and its own process group. */
export function runWithValue(input: VaultRunInput, baseEnv: NodeJS.ProcessEnv = process.env): VaultRunHandle {
	const env = scrubChildEnv(baseEnv);
	let valueFile: string | null = null;
	if (input.value !== undefined) {
		if (input.shape === "env") env[input.envName || DEFAULT_ENV_NAME] = input.value;
		if (input.shape === "file") {
			valueFile = writeValueFile(input.value);
			env[FILE_ENV_NAME] = valueFile;
		}
	}
	const unlink = () => {
		if (valueFile) fs.rmSync(valueFile, { force: true });
		valueFile = null;
	};
	let child: ChildProcess;
	try {
		child = spawn("sh", ["-c", input.command], {
			cwd: input.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
	} catch (error) {
		unlink();
		throw error;
	}
	const stdout = collector(input.value?.length ?? 0);
	const stderr = collector(input.value?.length ?? 0);
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stdin?.on("error", () => undefined);
	if (input.value !== undefined && input.shape === "stdin") child.stdin?.write(`${input.value}\n`);
	child.stdin?.end();

	const done = new Promise<VaultRunResult>((resolve) => {
		const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			unlink();
			const out = bounded(scrubOutput(stdout.raw(), input.value));
			const err = bounded(scrubOutput(stderr.raw(), input.value));
			resolve({
				exitCode,
				signal,
				stdout: out.text,
				stderr: err.text,
				truncated: out.truncated || err.truncated || stdout.cut() || stderr.cut(),
				...(input.keepRawStdout ? { rawStdout: stdout.raw() } : {}),
			});
		};
		child.on("close", finish);
		child.on("error", (error) => {
			stderr.push(Buffer.from(error.message));
			finish(null, null);
		});
	});
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			if (child.pid) process.kill(-child.pid, signal);
		} catch {}
	};
	const kill = () => {
		signalGroup("SIGTERM");
		setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
	};
	return { done, kill };
}
