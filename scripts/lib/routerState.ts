import path from "node:path";
import { $ } from "bun";

////////////////////////////////
//  Constants
//
//  Host-side access to the Router's durable federation state. Every read and write goes through a
//  container: the Router runs as root and its data dir is 0600, so the host cannot touch the file
//  directly once it has booted once.

const IMAGE = "switchboard-federation-federation:latest";
const CONTAINER = "switchboard-federation";
const DATA_DIR = "volumes/federation-data";
const STATE_FILE = "federation.json";

////////////////////////////////
//  Functions & Helpers

export async function routerRunning(): Promise<boolean> {
	const out = await $`docker inspect -f '{{.State.Running}}' ${CONTAINER}`.quiet().nothrow().text();
	return out.trim() === "true";
}

// Bun's `$` does NOT treat a backslash-newline as a line continuation: the newline splits the
// argv and the stray backslash lands in it, so a wrapped template silently runs a different
// command. Every template in this file stays on one line for that reason.

/** Read the Router's state file, or "" when there is nothing to read. */
export async function readRouterFed(): Promise<string> {
	const mount = `${path.resolve(DATA_DIR)}:/data:ro`;
	const script = `cat /data/${STATE_FILE} 2>/dev/null || true`;
	const read = await $`docker run --rm -v ${mount} --entrypoint sh ${IMAGE} -c ${script}`.quiet().nothrow();
	return read.exitCode ? "" : read.stdout.toString();
}

/**
 * Replace the Router's state file. The caller MUST have stopped the Router first: the store is
 * single-writer and holds its own copy, so a write underneath a live one is overwritten silently.
 */
export async function writeRouterFed(json: string): Promise<void> {
	if (await routerRunning()) throw new Error("the Router is running and owns this file - stop it first");
	const body = Buffer.from(json);
	const mount = `${path.resolve(DATA_DIR)}:/data`;
	const script = `cat > /data/${STATE_FILE} && chmod 600 /data/${STATE_FILE}`;
	const write = await $`docker run --rm -i -v ${mount} --entrypoint sh ${IMAGE} -c ${script} < ${body}`
		.quiet()
		.nothrow();
	if (write.exitCode) throw new Error(`could not write the Router state: ${write.stderr.toString().trim()}`);
}
