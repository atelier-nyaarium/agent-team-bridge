import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { buildRegisterMsg, initBridge } from "../mcp/bridge/helpers.js";

// The register message always carries the resume id and cwd label; the gateway decides durability at
// handshake-confirm, not from what the register reports. These shape tests guard that a registering
// session always hands the gateway enough to resume and label it once it confirms.

const BASE = { routerUrl: "http://localhost:20000", projectName: "host.abc123", agentType: "claude" };

afterEach(() => {
	delete process.env.CLAUDE_CODE_SESSION_ID;
	delete process.env.PROJECT_HOST_PATH;
});

describe("buildRegisterMsg", () => {
	it("reports the harness id so the gateway can resume the session later", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
		initBridge(BASE);
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

	it("omits the harness id when the env carries none", () => {
		initBridge(BASE);
		expect(buildRegisterMsg("sub1").claudeSessionId).toBeUndefined();
	});

	it("carries the cwd basename as the default session label", () => {
		initBridge(BASE);
		expect(buildRegisterMsg("sub1").cwdName).toBe(basename(process.cwd()));
	});
});
