// A child run with a vault value injected, and its output scrubbed of the value's bytes.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubChildEnv } from "../devcontainer/codexTargets.js";

export const OUTPUT_CAP_CHARS = 64 * 1024;
const RAW_CEILING_BYTES = 1024 * 1024;
export const SCRUB_MARK = "[vault]";
export const WITHHELD = "[vault: output withheld]";
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
}

export interface VaultRunResult {
	exitCode: number | null;
	signal: string | null;
	/** Scrubbed and capped. The value's bytes are gone. */
	stdout: string;
	stderr: string;
	/** The ceiling dropped bytes, so what is here may be a piece of something. */
	stdoutCut: boolean;
	stderrCut: boolean;
	/** The display cap trimmed the scrubbed text. */
	stdoutCapped: boolean;
	stderrCapped: boolean;
	/** Unscrubbed stdout, for a capture. Never an answer. */
	rawStdout: () => string;
}

export interface VaultRunHandle {
	done: Promise<VaultRunResult>;
	kill: () => void;
}

/** The value's raw bytes never reach a tool answer. */
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

/**
 * One stream: collect raw bytes to a ceiling, scrub, then cap.
 *
 * A cut drops the value's byte length from the tail, so a value straddling it cannot survive as a
 * piece. Scrubbing before the cap leaves the cap able to cut only the mark.
 */
function capture(value: string | undefined) {
	const valueBytes = value === undefined ? 0 : Buffer.byteLength(value, "utf8");
	const chunks: Buffer[] = [];
	let size = 0;
	let cut = false;

	const raw = (): string => {
		const bytes = Buffer.concat(chunks);
		const kept = cut ? bytes.subarray(0, Math.max(0, bytes.length - valueBytes)) : bytes;
		return kept.toString("utf8");
	};

	return {
		push(chunk: Buffer) {
			if (cut) return;
			const room = RAW_CEILING_BYTES - size;
			if (chunk.length > room) cut = true;
			chunks.push(chunk.subarray(0, room));
			size += Math.min(chunk.length, room);
		},
		raw,
		collect() {
			const scrubbed = scrubOutput(raw(), value);
			// A value short enough to sit inside the mark would survive the scrub; withhold instead.
			const safe = value && scrubbed.includes(value) ? WITHHELD : scrubbed;
			const capped = safe.length > OUTPUT_CAP_CHARS;
			return { text: capped ? safe.slice(0, OUTPUT_CAP_CHARS) : safe, cut, capped };
		},
	};
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
	const stdout = capture(input.value);
	const stderr = capture(input.value);
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stdin?.on("error", () => undefined);
	if (input.value !== undefined && input.shape === "stdin") child.stdin?.write(`${input.value}\n`);
	child.stdin?.end();

	const done = new Promise<VaultRunResult>((resolve) => {
		const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			unlink();
			const out = stdout.collect();
			const err = stderr.collect();
			resolve({
				exitCode,
				signal,
				stdout: out.text,
				stderr: err.text,
				stdoutCut: out.cut,
				stderrCut: err.cut,
				stdoutCapped: out.capped,
				stderrCapped: err.capped,
				rawStdout: stdout.raw,
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
