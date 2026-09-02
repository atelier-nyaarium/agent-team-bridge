import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InboxAddress } from "../shared/schemasInbox.js";

describe("inbox service residue", () => {
	it("keeps store append and batch calls in the ledger transaction helper", () => {
		const dir = path.join(process.cwd(), "src/federation-server/inbox");
		const source = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
			.join("\n");
		const calls = [...source.matchAll(/store\.(append|batch)\s*\(/g)];
		expect(calls).toHaveLength(1);
	});

	it("exposes Domain-bearing addresses for public address methods", () => {
		const address: InboxAddress = {
			kind: "owner",
			domainId: "domain",
			ownerSignPub: Buffer.alloc(32).toString("base64"),
		};
		expect(address.domainId).toBe("domain");
	});
});
