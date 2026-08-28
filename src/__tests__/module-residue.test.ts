import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lexiconScopeResidue } from "../../scripts/check-module-residue.js";

const ROOT = path.join(import.meta.dirname, "..", "..");

describe("lexicon module links", () => {
	it("contains only links into the lexicon submodule", () => {
		if (!existsSync(path.join(ROOT, "node_modules", "@nyaa-lexicon"))) return;
		expect(lexiconScopeResidue(ROOT)).toEqual([]);
	});
});
