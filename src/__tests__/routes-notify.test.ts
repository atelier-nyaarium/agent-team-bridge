import { describe, expect, it } from "vitest";
import { createRoutes, MAX_RESPONSE_FILE_BYTES, type RoutesDeps } from "../gateway/routes.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { SessionStore } from "../shared/session-store.js";
import { makeCtx, TEST_REQ } from "./helpers/routes.js";

describe("routes", () => {
	describe("/human/notify", () => {
		function makeStoreForOwner(owner = "owner-1"): {
			ctx: RoutesDeps;
			mailboxStore: DeviceMailboxStore;
		} {
			// Deliberately NOT pre-`ensure()`-ing the owner's mailbox: this is the ordinary shape
			// for a Gateway no console has ever registered against (a multi-gateway Domain's
			// non-home Gateway), which is exactly the case humanNotify must not silently drop.
			const mailboxStore = new DeviceMailboxStore();
			const ctx = { ...makeCtx({ mailboxStore, ownerId: () => owner }) };
			return { ctx, mailboxStore };
		}

		it("delivers a notice into the owner's mailbox, threaded under the sender, even with zero pre-registered devices", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			const res = humanNotify(TEST_REQ, {
				from: "recipe-app",
				title: "cycle done",
				summary: "All phases shipped. Nothing is blocked.",
				full: "# report\n\nall good",
			});
			expect((await res.json()).delivered).toBe(true);
			const snap = mailboxStore.get("owner-1")!.drain();
			expect(snap.entries).toHaveLength(1);
			expect(snap.entries[0]).toMatchObject({
				kind: "notice",
				session_id: "notice.alice.test-host.recipe-app.claude",
				from: "recipe-app",
				title: "cycle done",
				summary: "All phases shipped. Nothing is blocked.",
				body: "# report\n\nall good",
			});
			// Embeds its own dedupeKey (matching mirrorPeer's convention) so a relayed
			// console_push convergence copy on a sibling Gateway dedupes against the same value.
			expect(typeof snap.entries[0].dedupeKey).toBe("string");
		});

		it("accepts the title key and rejects a notice carrying no title", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			humanNotify(TEST_REQ, { from: "recipe-app", title: "via title", summary: "s", full: "body" });
			expect(mailboxStore.get("owner-1")!.drain().entries[0]).toMatchObject({ title: "via title" });
			expect(humanNotify(TEST_REQ, { from: "t", summary: "s", full: "body" }).status).toBe(400);
		});

		it("stamps fullSpoken onto the notice entry, and still accepts a notice WITHOUT it", async () => {
			// Optional here despite being required on the tool schema: the strict gateway schema
			// would otherwise 400 every notice from a not-yet-reloaded plugin in a deploy window.
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			const withSpoken = await humanNotify(TEST_REQ, {
				from: "recipe-app",
				title: "t",
				summary: "s",
				full: "# body",
				fullSpoken: "Spoken body.",
			}).json();
			expect(withSpoken.delivered).toBe(true);
			const without = await humanNotify(TEST_REQ, {
				from: "recipe-app",
				title: "t2",
				summary: "s2",
				full: "b2",
			}).json();
			expect(without.delivered).toBe(true);
			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries[0]).toMatchObject({ fullSpoken: "Spoken body." });
			expect(entries[1].fullSpoken).toBeUndefined();
		});

		it("requires title, summary, and full (no ghost pings) and wakes a held poll", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			// Notices missing summary/full are rejected outright, before any mailbox is even ensured.
			expect(humanNotify(TEST_REQ, { from: "t", title: "ping" }).status).toBe(400);
			expect(humanNotify(TEST_REQ, { from: "t", title: "ping", summary: "s" }).status).toBe(400);
			expect(mailboxStore.get("owner-1")).toBeUndefined();
			const start = Date.now();
			const held = mailboxStore.ensure("owner-1").waitForAppend(10_000);
			humanNotify(TEST_REQ, { from: "t", title: "ping", summary: "s", full: "body" });
			await held;
			expect(Date.now() - start).toBeLessThan(2_000);
			expect(mailboxStore.get("owner-1")!.drain().entries[0].body).toBe("body");
		});

		it("rejects oversized attachments with 413, missing store with 503, and no owner (pre-enrollment) with 503", async () => {
			const { ctx } = makeStoreForOwner();
			const { humanNotify } = createRoutes(ctx);
			// A declared size alone (no base64) is enough to cross the cap, and avoids
			// actually allocating a 500+ MB string in the test process.
			const res = humanNotify(TEST_REQ, {
				from: "t",
				title: "big",
				summary: "s",
				full: "body",
				files: [
					{
						filename: "b.bin",
						mime: "application/octet-stream",
						size: MAX_RESPONSE_FILE_BYTES + 1,
						descriptiveKey: "b",
						role: "attachment",
					},
				],
			});
			expect(res.status).toBe(413);

			const { humanNotify: noStore } = createRoutes(makeCtx());
			expect(noStore(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" }).status).toBe(503);

			const { humanNotify: noOwner } = createRoutes(makeCtx({ mailboxStore: new DeviceMailboxStore() }));
			expect(noOwner(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" }).status).toBe(503);
		});

		it("returns a clean 500 instead of throwing when the underlying append fails", () => {
			const throwingStore = {
				ensure: () => ({
					append: () => {
						throw new Error("boom");
					},
				}),
			};
			const ctx = makeCtx({ mailboxStore: throwingStore as never, ownerId: () => "owner-1" });
			const { humanNotify } = createRoutes(ctx);

			expect(() => humanNotify(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" })).not.toThrow();
			expect(humanNotify(TEST_REQ, { from: "t", title: "x", summary: "s", full: "body" }).status).toBe(500);
		});
	});

	describe("/plugin-action", () => {
		function makeStoreForOwner(owner = "owner-1"): {
			ctx: RoutesDeps;
			mailboxStore: DeviceMailboxStore;
		} {
			const mailboxStore = new DeviceMailboxStore();
			const ctx = { ...makeCtx({ mailboxStore, ownerId: () => owner }) };
			return { ctx, mailboxStore };
		}

		it("delivers a plugin_action into the owner's mailbox, threaded under the caller's own address", async () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			const res = pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "editor-form.html" },
			});
			expect((await res.json()).delivered).toBe(true);
			const snap = mailboxStore.get("owner-1")!.drain();
			expect(snap.entries).toHaveLength(1);
			expect(snap.entries[0]).toMatchObject({
				kind: "plugin_action",
				session_id: "conv.owner-1.alice.test-host.recipe-app.claude",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "editor-form.html" },
			});
			expect(typeof snap.entries[0].dedupeKey).toBe("string");
		});

		it("cannot be made to target any address other than the caller's own resolved identity", async () => {
			// The schema is strict: there is no "to"/"target"/"team" field at all, so a caller
			// cannot smuggle a different destination through the request body - only `from` (the
			// caller's own name) ever decides the target.
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			const res = pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x.html", to: "someone-elses-team", team: "someone-elses-team" },
				to: "someone-elses-team",
				target: "someone-elses-team",
			} as Record<string, unknown>);
			expect(res.status).toBe(400);
			// Even a same-shaped call with no stray top-level fields (a lookalike key buried only
			// inside the opaque payload, which the composer never reads for addressing) still
			// resolves to the caller's own address, not the lookalike value.
			pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x.html", to: "someone-elses-team", team: "someone-elses-team" },
			});
			const entries = mailboxStore.get("owner-1")!.drain().entries;
			expect(entries).toHaveLength(1);
			expect(entries[0].session_id).toBe("conv.owner-1.alice.test-host.recipe-app.claude");
		});

		it("requires from, pluginId, and actionType", async () => {
			const { ctx } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			expect(pluginAction(TEST_REQ, { pluginId: "designer", actionType: "delete-card" }).status).toBe(400);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", actionType: "delete-card" }).status).toBe(400);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer" }).status).toBe(400);
		});

		it("rejects an invalid `from` session name with 400 rather than throwing", () => {
			const { ctx } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			expect(() =>
				pluginAction(TEST_REQ, { from: "Not A Valid Slug!", pluginId: "designer", actionType: "delete-card" }),
			).not.toThrow();
			expect(
				pluginAction(TEST_REQ, { from: "Not A Valid Slug!", pluginId: "designer", actionType: "delete-card" })
					.status,
			).toBe(400);
		});

		it("missing store returns 503, no owner (pre-enrollment) returns 503", () => {
			const { pluginAction: noStore } = createRoutes(makeCtx());
			expect(
				noStore(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }).status,
			).toBe(503);

			const { pluginAction: noOwner } = createRoutes(makeCtx({ mailboxStore: new DeviceMailboxStore() }));
			expect(
				noOwner(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }).status,
			).toBe(503);
		});

		it("rejects a pluginId or actionType containing a colon, so two distinct pairs can never collide onto the same composite claim key", () => {
			const { ctx } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "a:b", actionType: "c" }).status).toBe(400);
			expect(pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "a", actionType: "b:c" }).status).toBe(400);
			expect(
				pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "Designer", actionType: "delete-card" }).status,
			).toBe(400);
		});

		it("rejects a payload over the size cap, so an oversized entry can never reach the mailbox", () => {
			const { ctx, mailboxStore } = makeStoreForOwner();
			const { pluginAction } = createRoutes(ctx);
			const res = pluginAction(TEST_REQ, {
				from: "recipe-app",
				pluginId: "designer",
				actionType: "delete-card",
				payload: { fileName: "x".repeat(40_000) },
			});
			expect(res.status).toBe(400);
			expect(mailboxStore.get("owner-1")).toBeUndefined();
		});

		it("returns a clean 500 instead of throwing when the underlying append fails", () => {
			const throwingStore = {
				ensure: () => ({
					append: () => {
						throw new Error("boom");
					},
				}),
			};
			const ctx = makeCtx({ mailboxStore: throwingStore as never, ownerId: () => "owner-1" });
			const { pluginAction } = createRoutes(ctx);

			expect(() =>
				pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }),
			).not.toThrow();
			expect(
				pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" }).status,
			).toBe(500);
		});
	});
});

// The HTTP routes are the other half of the identity gate: a name whose binding is active belongs to
// one session, so naming it in `from` requires proving you are it. Absence of the header must be a
// refusal rather than a fallback, or dropping it would be all impersonation ever took.
describe("HTTP sender ownership", () => {
	function boundCtx() {
		const sessionStore = new SessionStore();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const token = sessionStore.ensureBindToken(record);
		sessionStore.activateBinding(record);
		const team = sessionStore.teamOf(record);
		const mailboxStore = new DeviceMailboxStore();
		mailboxStore.ensure("owner-1");
		return { ctx: makeCtx({ sessionStore, mailboxStore, ownerId: () => "owner-1" }), team, token };
	}

	function reqWith(token?: string): Request {
		return new Request("http://gateway/x", { headers: token ? { "x-session-token": token } : {} });
	}

	it("refuses a notice claiming a bound session when no binding is presented at all", async () => {
		const { ctx, team } = boundCtx();
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(reqWith(), { from: team, title: "t", summary: "s", full: "b" });

		expect(res.status).toBe(403);
	});

	it("refuses a notice presenting some other session's binding", async () => {
		const { ctx, team } = boundCtx();
		const other = ctx.sessionStore!.mint({ spawn: "other-app" });
		const otherToken = ctx.sessionStore!.ensureBindToken(other);
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(reqWith(otherToken), { from: team, title: "t", summary: "s", full: "b" });

		expect(res.status).toBe(403);
	});

	it("accepts the session that holds the binding", async () => {
		const { ctx, team, token } = boundCtx();
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(reqWith(token), { from: team, title: "t", summary: "s", full: "b" });

		expect(res.status).toBe(200);
	});

	it("leaves an unbound name open, so a hand-launched session still speaks for itself", async () => {
		const sessionStore = new SessionStore();
		const record = sessionStore.mint({ spawn: "recipe-app" });
		const mailboxStore = new DeviceMailboxStore();
		mailboxStore.ensure("owner-1");
		const { humanNotify } = createRoutes(makeCtx({ sessionStore, mailboxStore, ownerId: () => "owner-1" }));

		const res = humanNotify(reqWith(), {
			from: sessionStore.teamOf(record),
			title: "t",
			summary: "s",
			full: "b",
		});

		expect(res.status).toBe(200);
	});

	it("refuses a plugin action claiming a bound session without its binding", async () => {
		const { ctx, team } = boundCtx();
		const { pluginAction } = createRoutes(ctx);

		const res = pluginAction(reqWith(), { from: team, pluginId: "designer", actionType: "delete-card" });

		expect(res.status).toBe(403);
	});
});
