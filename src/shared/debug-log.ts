import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Functions & Helpers

// Gateway writes to /app/log/debug.log, MCP host writes to volumes/gateway/debug.log
const LOG_PATH = existsSync("/.dockerenv")
	? process.env.LOG_PATH || "/app/log/debug.log"
	: path.join(process.env.HOME || "/home/nyaarium", "projects/switchboard/volumes/gateway/debug.log");

const RUN_ID_SUFFIX = `${process.pid}-${Date.now().toString(36)}`;

export function debugLog(
	hypothesisId: string,
	location: string,
	message: string,
	data: Record<string, unknown>,
	runIdPrefix = "debug",
): void {
	try {
		const dir = path.dirname(LOG_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({
			runId: `${runIdPrefix}-${RUN_ID_SUFFIX}`,
			hypothesisId,
			location,
			message,
			data,
			timestamp: new Date().toISOString(),
		});
		appendFileSync(LOG_PATH, `${line}\n`);
	} catch {
		// Silent
	}
}
