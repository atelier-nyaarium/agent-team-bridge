import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerStateStore } from "../federation-server/owner/ownerStateStore.js";
import { processAmbient } from "../shared/ambient.js";

const roots: string[] = [];
const key = { domainId: "domain", ownerSignPub: Buffer.alloc(32, 8).toString("base64") };

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DomainQuota", () => {
	it("reserves 64 MB by default", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domain-quota-"));
		roots.push(dir);
		const quota = new DomainQuota({ dir, limitBytes: 100, statfs: () => ({ available: 64 * 1024 * 1024 - 1 }) });
		expect(quota.reserve(path.join(dir, "owner"), 1)).toEqual({ ok: false, reason: "reserve" });
	});

	it("protects the reserve while federation metadata remains writable", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domain-quota-"));
		roots.push(dir);
		const available = 64 * 1024 * 1024 - 1;
		const quota = new DomainQuota({ dir, limitBytes: 100_000_000, statfs: () => ({ available }) });
		const owner = OwnerStateStore.open({
			dataDir: dir,
			key,
			quota,
			ambient: processAmbient(),
			heartbeatMs: 10,
			staleMs: 100,
		});
		expect(owner.put("share", "s", null, { clear: { value: 1 } })).toMatchObject({
			kind: "durability_failure",
			reason: "reserve",
		});
		owner.close();

		const federation = new FileSecretStore(dir);
		await federation.init();
		federation.saveDomain("domain", {
			ownerSignPub: key.ownerSignPub,
			ownerBoxPub: null,
			admissions: [],
			revocations: [],
		});
		await expect(federation.flushDomain("domain")).resolves.toBeUndefined();
	});
});
