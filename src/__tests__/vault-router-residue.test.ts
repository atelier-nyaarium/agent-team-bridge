import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_OP_CATALOG } from "../federation-server/ownerOpRegistry.js";
import { VALUE_OP_KINDS } from "../shared/schemasConsoleOp.js";

const root = path.resolve(import.meta.dirname, "../..");
const vaultDir = path.join(root, "src/federation-server/vault");

describe("vault router residue", () => {
	it("the Router vault never opens a field", () => {
		for (const name of fs.readdirSync(vaultDir)) {
			const source = fs.readFileSync(path.join(vaultDir, name), "utf8");
			expect(source, name).not.toMatch(/openContent|deriveContentKey|unwrapContentKey|contentKey/);
		}
	});

	it("the Router sweep holds every Domain a migration window fences", () => {
		const source = fs.readFileSync(path.join(root, "src/federation-server/ownerServices.ts"), "utf8");
		const sweep = source.slice(source.indexOf("sweep(now"), source.indexOf("rearm()"));
		expect(sweep).toContain("readRouterMigrationWindow().fenced");
		expect(sweep).toContain("leases.ready(domainId)");
		for (const service of ["share.sweep", "board.sweepTrash", "capabilities.sweep", "vault.sweep"])
			expect(sweep).toMatch(new RegExp(`held\\(domainId\\) \\|\\| ${service.replace(".", "\\.")}`));
	});

	it("catalogues the vault kinds with the class the fence reads", () => {
		const classes = Object.fromEntries(OWNER_OP_CATALOG.map((entry) => [entry.kind, entry.mutation]));
		expect(classes).toMatchObject({ vault_list: "read", vault_put: "value", vault_delete: "value" });
		for (const kind of ["vault_answer", "vault_grants", "vault_revoke"])
			expect(VALUE_OP_KINDS.has(kind)).toBe(true);
	});
});
