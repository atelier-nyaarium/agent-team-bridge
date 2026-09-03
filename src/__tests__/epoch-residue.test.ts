import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, linesMatching } from "./helpers/residue.js";

const comparison = /(?:cursorEpoch|deliveryEpoch)\s*(?:<|>|<=|>=)/;
const successor = /(?:cursorEpoch|deliveryEpoch)[^\n]*\+\s*1/;
const derivedMint = /\bepoch\s*:\s*(?:1\s*\+\s*Math\.random|Math\.random|Math\.floor|now\s*\()/;

describe("epoch residue", () => {
	it("rejects ordering and counter minting in production", () => {
		expect(comparison.test("if (cursorEpoch > current) return;")).toBe(true);
		const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "android/app/src/main")];
		const offenders = roots
			.flatMap((root) => filesUnder(root, ".ts").concat(filesUnder(root, ".kt")))
			.filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
			.filter((file) => !file.endsWith(`${path.sep}shared${path.sep}epoch.ts`))
			.flatMap((file) => [
				...linesMatching(file, comparison),
				...linesMatching(file, successor),
				...linesMatching(file, derivedMint),
			]);
		expect(offenders).toEqual([]);
	});
});
