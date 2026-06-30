import { describe, expect, it } from "vitest";
import { classifyPeekError, isReservedHostSession } from "../shared/host-op.js";

describe("isReservedHostSession", () => {
	it("reserves the daemon's supervisor session but not the conventional agent session", () => {
		expect(isReservedHostSession("host-daemon")).toBe(true);
		expect(isReservedHostSession("claude")).toBe(false);
		expect(isReservedHostSession("nyaadot")).toBe(false);
	});
});

describe("classifyPeekError", () => {
	it("classifies an absent session, pane, or container as absent", () => {
		expect(classifyPeekError("no server running on /tmp/tmux-1000/default")).toBe("absent");
		expect(classifyPeekError("can't find session: claude")).toBe("absent");
		expect(classifyPeekError("can't find pane: claude.0")).toBe("absent");
		expect(classifyPeekError("Error: No such container: foo_devcontainer-dev-1")).toBe("absent");
		expect(classifyPeekError("Error response from daemon: container is not running")).toBe("absent");
	});

	it("classifies a timeout or a non-zero exit as a real failure", () => {
		expect(classifyPeekError("tmux command timed out")).toBe("failure");
		expect(classifyPeekError("tmux command exited 1")).toBe("failure");
	});

	it("treats a timeout that also names an absent phrase as a failure (timeout wins)", () => {
		expect(classifyPeekError("tmux command timed out: no server running")).toBe("failure");
	});

	it("defaults an unrecognized error to failure", () => {
		expect(classifyPeekError("connection refused")).toBe("failure");
	});
});
