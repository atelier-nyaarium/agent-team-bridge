import { describe, expect, it } from "vitest";
import { type BlobReference, formatBlobReference, parseBlobReference } from "../shared/blob-reference.js";

describe("blob references", () => {
	it("round-trips every reference kind", () => {
		const refs: BlobReference[] = [
			{ kind: "entry", entryId: "entry/one" },
			{ kind: "row", address: { kind: "gateway", domainId: "domain", gatewayId: "gateway" }, seq: 3 },
			{ kind: "scheduled", target: { domainId: "domain", gatewayId: "gateway", sessionId: "session" } },
		];
		for (const ref of refs) expect(parseBlobReference(formatBlobReference(ref))).toEqual(ref);
	});

	it("rejects malformed references", () => {
		for (const id of [
			"",
			"entry:",
			"entry:%",
			"row:bad:1",
			"row:gateway:0",
			"scheduled:domain/gateway",
			"unknown:value",
		])
			expect(parseBlobReference(id)).toBeNull();
	});
});
