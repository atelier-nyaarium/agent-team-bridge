import { describe, expect, it } from "vitest";
import { buildLaunchCommand } from "../mcp/devcontainer/hostDaemon.js";

const dc = { kind: "devcontainer" as const, name: "recipe-app", sessionName: "scratch" };

describe("buildLaunchCommand", () => {
	it("overrides PROJECT_NAME to the composite, cds to the workspace, and execs claude (no resume)", () => {
		const cmd = buildLaunchCommand(dc);
		expect(cmd).toContain("export PROJECT_NAME=recipe-app.scratch");
		expect(cmd).toContain("cd /workspace/recipe-app");
		expect(cmd).toContain("exec claude");
		expect(cmd).not.toContain("--resume");
		// The override runs after sourcing bashrc so it wins over the image ENV.
		expect(cmd.indexOf("source ~/.bashrc")).toBeLessThan(cmd.indexOf("export PROJECT_NAME"));
	});

	it("appends --resume for a uuid-shaped session id", () => {
		const cmd = buildLaunchCommand(dc, { resumeSessionId: "12345678-1234-1234-1234-123456789abc" });
		expect(cmd).toContain("--resume 12345678-1234-1234-1234-123456789abc");
	});

	it("ignores a malformed resume id (no --resume injected)", () => {
		const cmd = buildLaunchCommand(dc, { resumeSessionId: "x'; rm -rf /" });
		expect(cmd).not.toContain("--resume");
	});

	it("keeps a host session's pane alive with exec bash and does not cd into a workspace", () => {
		const cmd = buildLaunchCommand({ kind: "host", name: "host", sessionName: "foo" });
		expect(cmd).toContain("export PROJECT_NAME=host.foo");
		expect(cmd).toContain("; exec bash");
		expect(cmd).not.toContain("cd /workspace");
	});
});
