import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Signing-vector corpus inventory
//
//  _signing-vectors-manifest.json is the single inventory of the cross-runtime
//  signing-vector corpora (each a directory holding a vectors.json read by both a
//  vitest suite and a Kotlin twin). This suite asserts the manifest equals the set
//  of tests/fixtures/*/vectors.json directories on disk, so a new op's fixture
//  directory cannot be added without registering it here. SigningVectorsManifestTest.kt
//  reads the SAME manifest and forces every listed directory through Kotlin, so a
//  registered corpus can never be read by TS alone (ci.yml does not run the Android
//  unit tests, which is exactly the gap this closes). The protocol corpus is governed
//  by its own tests/fixtures/protocol/_manifest.json and has no vectors.json, so it is
//  outside this inventory by construction.

const FIXTURES = path.join(__dirname, "../../tests/fixtures");

const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, "_signing-vectors-manifest.json"), "utf8")) as {
	directories: string[];
};

function dirsWithVectorsOnDisk(): string[] {
	return fs
		.readdirSync(FIXTURES, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(FIXTURES, entry.name, "vectors.json")))
		.map((entry) => entry.name)
		.sort();
}

describe("signing-vector manifest", () => {
	it("lists exactly the vectors.json directories on disk", () => {
		const listed = [...manifest.directories].sort();
		expect(listed).toEqual(dirsWithVectorsOnDisk());
	});

	it("every listed directory holds a parseable vectors.json", () => {
		for (const dir of manifest.directories) {
			const file = path.join(FIXTURES, dir, "vectors.json");
			expect(fs.existsSync(file), `${dir}/vectors.json must exist`).toBe(true);
			expect(() => JSON.parse(fs.readFileSync(file, "utf8")), `${dir}/vectors.json must parse`).not.toThrow();
		}
	});
});
