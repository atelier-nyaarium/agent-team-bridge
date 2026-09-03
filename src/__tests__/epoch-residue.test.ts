import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, linesMatching } from "./helpers/residue.js";

const comparison = /(?:cursorEpoch|deliveryEpoch)\s*(?:<|>|<=|>=)/;
const successor = /(?:cursorEpoch|deliveryEpoch)[^\n]*\+\s*1/;

describe("epoch residue", () => {
	it("rejects ordering and counter minting in production", () => {
		expect(comparison.test("if (cursorEpoch > current) return;")).toBe(true);
		const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "android/app/src/main")];
		const offenders = roots
			.flatMap((root) => filesUnder(root, ".ts").concat(filesUnder(root, ".kt")))
			.filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
			.flatMap((file) => [...linesMatching(file, comparison), ...linesMatching(file, successor)]);
		expect(offenders).toEqual([]);
	});
});
