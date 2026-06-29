import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ownerKeyId } from "../shared/owner-id.js";

////////////////////////////////
//  ownerKeyId cross-runtime vectors
//
//  vectors.json is read by BOTH this suite and OwnerIdVectorsTest.kt, so the gateway
//  (shared/owner-id.ts) and the Kotlin twin (crypto/OwnerId.kt) cannot diverge: a
//  differing owner id would silently break the console self-address match (the owner
//  id is the spawn segment of the console's own address on both sides).

interface Vector {
	signPub: string;
	ownerKeyId: string;
}
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "../../tests/fixtures/owner-id/vectors.json"), "utf8"))
	.cases as Vector[];

describe("ownerKeyId vectors", () => {
	it("has vectors to check", () => {
		expect(vectors.length).toBeGreaterThan(0);
	});
	for (const v of vectors) {
		it(`hashes ${v.signPub.slice(0, 10)}... to ${v.ownerKeyId.slice(0, 10)}...`, () => {
			expect(ownerKeyId(v.signPub)).toBe(v.ownerKeyId);
		});
	}
});
