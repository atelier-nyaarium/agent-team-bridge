import { expect } from "vitest";

////////////////////////////////
//  Canonical signing-bytes assertion
//
//  A cross-runtime signing vector pins its canonical preimage in three encodings
//  (utf8 / hex / base64) so the Kotlin twin is held byte-exact against node:crypto
//  from whichever encoding it reproduces. Asserting all three per op is the same
//  three lines repeated; this helper folds them into one call. Not a `.test.ts`
//  file, so vitest does not collect it as a suite (tsc still type-checks it).

/** The triple-encoded canonical preimage a cross-runtime signing vector records. */
export interface CanonicalBytesVec {
	signingBytes: string;
	signingBytesHex: string;
	signingBytesBase64: string;
}

/** Assert `actual` reproduces the vector's canonical signing bytes in all three
 * recorded encodings (utf8, hex, base64). */
export function assertCanonicalBytes(actual: Buffer, vec: CanonicalBytesVec): void {
	expect(actual.toString("utf8")).toBe(vec.signingBytes);
	expect(actual.toString("hex")).toBe(vec.signingBytesHex);
	expect(actual.toString("base64")).toBe(vec.signingBytesBase64);
}
