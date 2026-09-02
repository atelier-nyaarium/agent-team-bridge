import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { type OwnerKey, OwnerStateStore } from "../federation-server/owner/ownerStateStore.js";
import { filesUnder } from "./helpers/residue.js";

const key: OwnerKey = { domainId: "domain", ownerSignPub: Buffer.alloc(32, 8).toString("base64") };

describe("owner state residue", () => {
	it("replays journal bytes after a copied directory", () => {
		const source = fs.mkdtempSync(path.join(os.tmpdir(), "owner-residue-"));
		const quota = new DomainQuota({
			dir: source,
			limitBytes: 1_000_000,
			reserveBytes: 0,
			statfs: () => ({ available: 10_000_000 }),
		});
		const store = OwnerStateStore.open({ dataDir: source, key, quota });
		store.put("share", "s", null, { clear: { x: 1 } });
		const copyParent = fs.mkdtempSync(path.join(os.tmpdir(), "owner-copy-"));
		const copy = path.join(copyParent, path.basename(source));
		store.close();
		fs.cpSync(source, copy, { recursive: true });
		const reopened = OwnerStateStore.open({
			dataDir: copy,
			key,
			quota: new DomainQuota({
				dir: copy,
				limitBytes: 1_000_000,
				reserveBytes: 0,
				statfs: () => ({ available: 10_000_000 }),
			}),
		});
		expect(reopened.get("share", "s")).toMatchObject({ clear: { x: 1 } });
		reopened.close();
		fs.rmSync(source, { recursive: true, force: true });
		fs.rmSync(copyParent, { recursive: true, force: true });
	});

	it("keeps file moves behind the atomic helper", () => {
		const files = filesUnder(`${import.meta.dirname}/../federation-server/owner`).filter((file) =>
			file.endsWith(".ts"),
		);
		const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
		expect(source).not.toMatch(/\bfs\.rename(?:Sync)?\s*\(/);
	});

	it("requires a domain id in OwnerKey", () => {
		// @ts-expect-error domainId is required
		const invalid: OwnerKey = { ownerSignPub: "x" };
		expect(invalid).toBeDefined();
	});
});
