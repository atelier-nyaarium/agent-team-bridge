import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { buildRegisterMsg, initBridge } from "../mcp/bridge/helpers.js";

// The register message is the sole durability signal: the gateway writes a resume record iff
// claudeSessionId arrives (and silently accepts either shape), so this shape test is the only guard
// against an ad-hoc session minting a durable record - the regression that strands phantom
// "available" cards on the board after every loose `claude` exit.

const BASE = { routerUrl: "http://localhost:20000", projectName: "host.abc123", agentType: "claude" };

afterEach(() => {
	delete process.env.CLAUDE_CODE_SESSION_ID;
	delete process.env.PROJECT_HOST_PATH;
});

describe("buildRegisterMsg", () => {
	it("a daemon-launched session reports its harness id for later resume", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
		initBridge({ ...BASE, adhoc: false });
		const msg = buildRegisterMsg("sub1");
		expect(msg).toMatchObject({
			type: "register",
			team: "host.abc123",
			mode: "channel",
			subId: "sub1",
			version: packageJson.version,
			claudeSessionId: "11111111-2222-3333-4444-555555555555",
		});
		expect(msg.conversationId).toBeTruthy();
	});

	it("an ad-hoc session omits the harness id so no durable resume record is written", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
		initBridge({ ...BASE, adhoc: true });
		const msg = buildRegisterMsg("sub1");
		expect(msg.claudeSessionId).toBeUndefined();
		// Everything else is unchanged: the session still registers as a live, addressable chat.
		expect(msg).toMatchObject({ type: "register", team: "host.abc123", mode: "channel" });
	});

	it("omits the harness id when the env carries none, regardless of provenance", () => {
		initBridge({ ...BASE, adhoc: false });
		expect(buildRegisterMsg("sub1").claudeSessionId).toBeUndefined();
	});
});
