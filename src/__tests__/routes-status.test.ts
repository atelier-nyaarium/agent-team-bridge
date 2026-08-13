import { describe, expect, it } from "vitest";
import { EVIE_WS_MAX_PAYLOAD_BYTES } from "../gateway/evie/evieClient.js";
import { createRoutes, MAX_RESPONSE_FILE_BYTES } from "../gateway/routes.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES, MAX_RELAY_FRAME_BYTES } from "../shared/evie-protocol.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { SessionStore } from "../shared/session-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { makeCtx, makeRegistry } from "./helpers/routes.js";

describe("routes", () => {
	describe("/pending", () => {
		const anyCaller = () => new Request("http://localhost/pending");

		it("returns empty array when no jobs", async () => {
			const ctx = makeCtx();
			const { pending } = createRoutes(ctx);
			const res = pending(anyCaller());
			expect(await res.json()).toEqual([]);
		});

		it("returns session_id, from, to, state for each pending job", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			const ctx = makeCtx({ store });
			const { pending } = createRoutes(ctx);
			const res = pending(anyCaller());
			expect(await res.json()).toEqual([{ session_id: "sess-1", from: "a", to: "b", state: "waiting" }]);
		});

		// A session_id is the credential /poll and /respond accept, and a console-originated one
		// embeds the owner's mailbox key, so enumerating the list hands out the keys to both doors.
		it("refuses a caller that holds no session of this gateway's", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("conv.owner-1.alice.test-host.app.dev", "a", "b");
			const sessionStore = new SessionStore();
			const record = sessionStore.mint({ spawn: "app" });
			const token = sessionStore.ensureBindToken(record);
			sessionStore.activateBinding(record);
			const { pending } = createRoutes(makeCtx({ store, sessionStore }));

			const refused = pending(anyCaller());
			expect(refused.status).toBe(403);
			expect(await refused.json()).not.toContainEqual(expect.objectContaining({ session_id: expect.anything() }));

			const admitted = pending(
				new Request("http://localhost/pending", { headers: { "x-session-token": token } }),
			);
			expect(admitted.status).toBe(200);
			expect(await admitted.json()).toHaveLength(1);
		});
	});

	describe("/poll", () => {
		it("returns 400 when session_id missing", async () => {
			const ctx = makeCtx();
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), {});
			expect(res.status).toBe(400);
		});

		it("returns 404 when no pending job", async () => {
			const ctx = makeCtx();
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "nope" });
			expect(res.status).toBe(404);
		});

		// A session_id is computable from two non-secret values, so it names a job rather than
		// authorizing one. A persistent channel entry is not consumed on read either, so an id that
		// leaked once would otherwise keep paying out the answer forever.
		it("hands a job's answer only to the session that asked", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			const sessionStore = new SessionStore();
			const asker = sessionStore.mint({ spawn: "app" });
			const askerToken = sessionStore.ensureBindToken(asker);
			sessionStore.activateBinding(asker);
			const bystander = sessionStore.mint({ spawn: "other" });
			const bystanderToken = sessionStore.ensureBindToken(bystander);
			sessionStore.activateBinding(bystander);
			store.create("conv-1", sessionStore.teamOf(asker), "coolib.dev", { persistent: true });
			store.deliver("conv-1", { response: "the answer" } as ResponsePayload);
			const { poll } = createRoutes(makeCtx({ store, sessionStore }));

			const pollAs = (token?: string) =>
				poll(
					new Request("http://localhost/poll", {
						method: "POST",
						headers: token ? { "x-session-token": token } : {},
					}),
					{ session_id: "conv-1" },
				);

			expect(pollAs().status).toBe(403);
			expect(pollAs(bystanderToken).status).toBe(403);

			const mine = pollAs(askerToken);
			expect(mine.status).toBe(200);
			expect(await mine.json()).toMatchObject({ response: "the answer" });
		});

		it("returns running when job is timed out but no result yet", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			await store.waitForResult("sess-1", 1); // 1ms timeout
			await new Promise((r) => setTimeout(r, 10)); // let timeout fire

			const ctx = makeCtx({ store });
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-1" });
			const json = await res.json();
			expect(json.status).toBe("running");
		});

		it("returns stored result after late delivery", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			await store.waitForResult("sess-1", 1);
			await new Promise((r) => setTimeout(r, 10));

			store.deliver("sess-1", { session_id: "sess-1", status: "completed", response: "late answer" });

			const ctx = makeCtx({ store });
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-1" });
			const json = await res.json();
			expect(json.status).toBe("completed");
			expect(json.response).toBe("late answer");
		});
	});

	describe("/health", () => {
		it("returns ok with counts", async () => {
			const registry = makeRegistry({ a: { readyState: 1, data: { mode: "channel" } } });
			const store = new PendingJobStore<ResponsePayload>();
			store.create("s1", "a", "b");
			const ctx = makeCtx({ registry, store });
			const { health } = createRoutes(ctx);
			const res = health();
			expect(await res.json()).toEqual({ ok: true, teams: 1, pending_jobs: 1 });
		});
	});

	describe("constants", () => {
		it("derives the payload bucket from the one size limit rather than restating it", () => {
			// Assert the DERIVATION rather than a literal: an independent copy of this number can silently
			// drift from MAX_BLOB_BYTES, the size limit it must track, and the console would then refuse
			// exactly the large files the chunked transport was built to carry.
			expect(MAX_RESPONSE_FILE_BYTES).toBe(MAX_BLOB_BYTES);
		});

		it("a sealed chunk frame stays under the relay budget, which stays under the WS ceiling", () => {
			// The chunk constant is sized against the phone's heap; this pins the OTHER end of that
			// choice, that a chunk cannot grow into a frame the socket will refuse. An oversized
			// frame closes the gateway<->evie socket and drops every team's traffic, so the two
			// numbers must not be able to drift independently.
			const sealedChunk = BLOB_CHUNK_BYTES * 2;
			expect(sealedChunk).toBeLessThan(MAX_RELAY_FRAME_BYTES);
			expect(MAX_RELAY_FRAME_BYTES).toBeLessThan(EVIE_WS_MAX_PAYLOAD_BYTES);
		});

		it("lets an attachment be far larger than any single frame, which is the point of the plane", () => {
			// The inverse of what this file used to assert. The old rule was that a whole payload had
			// to fit inside one relay frame, which is why the size ceiling was pinned near the socket
			// limit. Bytes travel in chunks now, so a file is deliberately allowed to dwarf a frame,
			// and re-adding a "payload fits in a frame" assertion would quietly re-impose the cap the
			// blob plane exists to remove.
			expect(MAX_BLOB_BYTES).toBeGreaterThan(EVIE_WS_MAX_PAYLOAD_BYTES);
			// What must still hold is the per-CHUNK bound, asserted above.
			expect(BLOB_CHUNK_BYTES * 2).toBeLessThan(MAX_RELAY_FRAME_BYTES);
		});
	});
});
