import { describe, expect, it } from "vitest";
import { createRoutes } from "../gateway/routes.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { fakeRouter, makeCtx, sealerB } from "./helpers/federation.js";

////////////////////////////////
//  Per-session un-share enforced on the destination reply forward (response_push)
//
//  The leak: B shares lib to Domain A; A sends to B/lib (accepted, B creates a destination
//  job bound to A, returnRoute to the origin, dstDomainId A); B un-shares lib from A; B's agent's
//  in-flight reply must NOT still forward to the origin, because the share is gone. routes.respond
//  re-reads the share on the cross-Domain reply forward and DROPS it when no longer shared.

describe("destination reply forward re-checks the per-session share (cross-Domain)", () => {
	const SRC_SESSION = "conv.c1.alice.hostb.lib.dev"; // B's own gateway id in the origin-set key
	const RETURN_ROUTE = { srcGateway: "hosta", srcConversationId: "c1", srcSession: SRC_SESSION };

	/** Seed a DESTINATION job on B exactly as the cross-Domain inbound send path does: id is
	 * the origin-set canonical session key, `to` the bare local name, with the verified friend
	 * Domain + return-route pinned. */
	function seedDestJob(store: PendingJobStore<ResponsePayload>): void {
		store.create(SRC_SESSION, "alice.alice-gw.app.dev", "lib.dev", {
			persistent: true,
			fromConversationId: "c1",
			returnRoute: RETURN_ROUTE,
			dstDomainId: "alice",
		});
	}

	function respondOnB(isShared: boolean) {
		// Records gateway_relay so we can assert the response_push DID or did NOT forward.
		const router = fakeRouter({ onCall: () => ({ ok: true }) });
		const ctx = makeCtx("hostb", {
			routerClient: router.client,
			sealer: sealerB,
			isSharedToForReply: (sessionTarget, domainId) =>
				isShared && sessionTarget === "alice.hostb.lib.dev" && domainId === "alice",
		});
		seedDestJob(ctx.store);
		const routes = createRoutes(ctx);
		return { routes, router };
	}

	it("DROPS the response_push for a session that was un-shared (does not forward to the origin)", async () => {
		const { routes, router } = respondOnB(false);
		const res = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: SRC_SESSION,
			status: "completed",
			response: "leaked?",
		});
		const json = await res.json();
		expect(json).toEqual({ delivered: false, dropped: "unshared" });
		// Let any (erroneous) background relay attempt flush, then assert NONE happened.
		await new Promise((r) => setTimeout(r, 0));
		expect(router.calls.find((c) => c.action === "gateway_relay")).toBeUndefined();
	});

	it("FORWARDS the response_push normally for a session that is still shared", async () => {
		const { routes, router } = respondOnB(true);
		const res = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: SRC_SESSION,
			status: "completed",
			response: "all good",
		});
		expect((await res.json()).federated).toBe(true);
		// The forward is fire-and-forget; let it run, then assert it relayed to the origin.
		await new Promise((r) => setTimeout(r, 0));
		expect(router.calls.find((c) => c.action === "gateway_relay")).toBeDefined();
	});

	it("a SAME-DOMAIN federated reply (dstDomainId null) is never gated, even with no share", async () => {
		// The reply gate fires only on a cross-Domain job (dstDomainId set). A same-Domain
		// federated job has a returnRoute but null Domain binding, so it forwards unchanged.
		const router = fakeRouter({ onCall: () => ({ ok: true }) });
		const ctx = makeCtx("hostb", {
			routerClient: router.client,
			sealer: sealerB,
			isSharedToForReply: () => false, // would drop IF consulted
		});
		ctx.store.create(SRC_SESSION, "alice.peer.app.dev", "lib.dev", {
			persistent: true,
			fromConversationId: "c1",
			returnRoute: RETURN_ROUTE,
			// no dstDomainId -> same-Domain federated
		});
		const routes = createRoutes(ctx);
		const res = routes.respond(new Request("http://gateway/respond", { method: "POST" }), {
			session_id: SRC_SESSION,
			status: "completed",
			response: "all good",
		});
		expect((await res.json()).federated).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(router.calls.find((c) => c.action === "gateway_relay")).toBeDefined();
	});
});
