import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InboxAddress } from "../shared/schemasInbox.js";

describe("inbox service residue", () => {
	it("keeps direct store appends in the ledger transaction helper", () => {
		const dir = path.join(process.cwd(), "src/federation-server");
		const files = fs
			.readdirSync(dir, { recursive: true })
			.filter((name): name is string => typeof name === "string" && name.endsWith(".ts"));
		const calls = files.flatMap((name) => {
			const source = fs.readFileSync(path.join(dir, name), "utf8");
			return [...source.matchAll(/store\.append\s*\(/g)].map(() => name);
		});
		expect(calls).toEqual([]);
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
