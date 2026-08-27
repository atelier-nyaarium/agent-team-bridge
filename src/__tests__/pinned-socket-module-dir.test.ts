import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { moduleDir, realWebSocket } from "../gateway/router/pinnedSocket.js";

/**
 * How `realWebSocket` finds the `ws` package on disk.
 *
 * It walks up from its own module directory looking for `node_modules/ws/lib/websocket.js`, by
 * resolved path, because bun rewrites the bare `ws` specifier to a substitute that cannot pin. If the
 * directory it starts from is not a real filesystem path, every candidate it builds is unopenable,
 * the walk runs to the root, and the gateway throws on its first Router dial.
 *
 * That is what `new URL(import.meta.url).pathname` did. It is not a Windows-only defect, which is why
 * this can be tested here at all: `pathname` stays percent-encoded, so a checkout under a path with a
 * space fails identically on Linux. The Windows half (a leading slash before the drive letter) is
 * asserted the same way, against a `file:///C:/...` URL, since the derivation is pure.
 */
describe("moduleDir: the ws walk starts from a real path", () => {
	it("decodes a percent-encoded segment, which pathname leaves encoded", () => {
		const url = "file:///home/nyaarium/my%20projects/switchboard/src/gateway/router/pinnedSocket.ts";
		expect(moduleDir(url)).toBe("/home/nyaarium/my projects/switchboard/src/gateway/router");
		// The bug, stated as the thing that must not come back.
		expect(moduleDir(url)).not.toContain("%20");
		expect(new URL(url).pathname).toContain("%20");
	});

	it("leaves a plain posix path alone", () => {
		const url = "file:///home/nyaarium/projects/switchboard/src/gateway/router/pinnedSocket.ts";
		expect(moduleDir(url)).toBe("/home/nyaarium/projects/switchboard/src/gateway/router");
	});

	it("strips the leading slash before a drive letter, the defect that broke the Windows gateway", () => {
		// Provable on this posix runner because fileURLToPath takes an explicit `windows` option, so the
		// win32 semantics are exercised rather than reasoned about. `moduleDir` itself is platform-native
		// by design; what is asserted here is the DIFFERENCE that made `.pathname` wrong.
		const win = "file:///B:/switchboard/src/gateway/router/pinnedSocket.ts";
		const broken = new URL(win).pathname;
		const correct = fileURLToPath(win, { windows: true });

		expect(broken).toBe("/B:/switchboard/src/gateway/router/pinnedSocket.ts");
		expect(correct).toBe("B:\\switchboard\\src\\gateway\\router\\pinnedSocket.ts");

		// The candidate each one builds. The first opens nothing, so the walk ran to the root and threw
		// on the gateway's first Router dial; fail-closed, but never connected.
		expect(path.win32.join(path.win32.dirname(broken), "node_modules", "ws")).toBe(
			"\\B:\\switchboard\\src\\gateway\\router\\node_modules\\ws",
		);
		expect(path.win32.join(path.win32.dirname(correct), "node_modules", "ws")).toBe(
			"B:\\switchboard\\src\\gateway\\router\\node_modules\\ws",
		);
	});

	it("actually resolves the real ws package from this checkout", () => {
		// The end the derivation exists for. Passes on node and bun alike; what it CANNOT prove is the
		// runtime substitution, which is check-pinning-runtime.ts's job under bun.
		const ws = realWebSocket();
		expect(typeof ws).toBe("function");
		// And the module dir it starts from is this repo, reached without any encoded segment.
		const here = moduleDir(import.meta.url);
		expect(path.isAbsolute(here)).toBe(true);
		expect(here).not.toContain("%");
	});
});
