import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultDecisions, operationShape } from "../gateway/vault/decisions.js";
import { VAULT_SESSION_GRANT_CAP_MS, VAULT_WINDOW_MS } from "../shared/schemasVault.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-decisions-"));
	roots.push(root);
	return root;
};
let ids = 0;
const ambient = { newId: () => `grant-${++ids}` };
const scope = (shape: string, sessionTarget = "host.alice", entryId = "deploy") => ({ entryId, shape, sessionTarget });

describe("vault decisions", () => {
	it("derives the shape from the program and its first non-flag argument", () => {
		expect(operationShape("ssh deploy@prod uptime -v")).toBe("ssh deploy@prod");
		expect(operationShape("/usr/bin/docker login registry")).toBe("docker login");
		expect(operationShape("  curl  ")).toBe("curl");
		// Flags before targets use the full shape.
		expect(operationShape("ssh -p 22 victim.example")).toBe("ssh -p 22 victim.example");
		expect(operationShape("ssh -p 22 victim.example")).not.toBe(operationShape("ssh -p 22 attacker.example"));
	});

	it("a window covers its shape until it expires; once covers nothing; session covers every shape", () => {
		const decisions = createVaultDecisions({ dataDir: fresh(), ambient });
		expect(decisions.grant("once", scope("ssh deploy@prod"), 1_000)).toBeNull();
		expect(decisions.covers(scope("ssh deploy@prod"), 1_000)).toBeUndefined();

		const window = decisions.grant("window", scope("ssh deploy@prod"), 1_000);
		expect(window).toEqual({
			grantId: expect.any(String),
			tier: "window",
			entryId: "deploy",
			shape: "ssh deploy@prod",
			sessionTarget: "host.alice",
			expiresAt: 1_000 + VAULT_WINDOW_MS,
		});
		expect(decisions.covers(scope("ssh deploy@prod"), 2_000)?.grantId).toBe(window?.grantId);
		expect(decisions.covers(scope("curl attacker"), 2_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod", "host.carol"), 2_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod", "host.alice", "other"), 2_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod"), 1_000 + VAULT_WINDOW_MS)).toBeUndefined();

		const session = decisions.grant("session", scope("ssh deploy@prod", "host.carol"), 5_000);
		expect(session).toEqual({
			grantId: expect.any(String),
			tier: "session",
			entryId: "deploy",
			sessionTarget: "host.carol",
			expiresAt: 5_000 + VAULT_SESSION_GRANT_CAP_MS,
		});
		expect(decisions.covers(scope("curl anywhere", "host.carol"), 6_000)?.grantId).toBe(session?.grantId);
		decisions.sessionEnded("host.carol");
		expect(decisions.covers(scope("curl anywhere", "host.carol"), 6_000)).toBeUndefined();
	});

	it("grants survive a reopen, and a revoke or an expiry drops them from the list", () => {
		const dataDir = fresh();
		const first = createVaultDecisions({ dataDir, ambient });
		const window = first.grant("window", scope("ssh deploy@prod"), 1_000);
		first.grant("session", scope("ssh deploy@prod", "host.carol"), 1_000);

		const reopened = createVaultDecisions({ dataDir, ambient });
		expect(
			reopened
				.list(2_000)
				.map((grant) => grant.tier)
				.sort(),
		).toEqual(["session", "window"]);
		expect(reopened.revoke(window?.grantId ?? "")).toBe(true);
		expect(reopened.revoke("missing")).toBe(false);
		expect(reopened.list(1_000 + VAULT_SESSION_GRANT_CAP_MS)).toEqual([]);
		expect(createVaultDecisions({ dataDir, ambient }).list(2_000)).toEqual([]);
	});
});
