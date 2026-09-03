import { describe, expect, it } from "vitest";
import { BlobFetchRoute } from "../federation-server/inbox/blobFetchRoute.js";

describe("blob transfer", () => {
	it("forwards a fetch with the destination incarnation", async () => {
		const frames: Record<string, unknown>[] = [];
		const cache = { stat: () => ({ kind: "miss" as const }) };
		const route = new BlobFetchRoute(cache as never, () => ({
			connId: "origin",
			incarnation: 3,
			send: (frame) => frames.push(frame),
		}));
		const pending = route.fetch("requester", {
			opId: "fetch",
			blobId: `sha256-${"a".repeat(64)}`,
			origin: { domainId: "origin", gatewayId: "gateway" },
			incarnation: 1,
		});
		expect(frames).toEqual([
			{
				type: "blob_fetch",
				opId: "fetch",
				blobId: `sha256-${"a".repeat(64)}`,
				range: undefined,
				incarnation: 3,
			},
		]);
		expect(route.settle("origin", { opId: "fetch", outcome: "absent", sealed: false, incarnation: 3 })).toBe(true);
		expect(await pending).toEqual({ outcome: "absent" });
	});
});
