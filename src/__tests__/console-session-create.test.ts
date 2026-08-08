import { describe, expect, it } from "vitest";
import type { WakeResult } from "../gateway/wake.js";
import { SessionStore } from "../shared/session-store.js";
import { frame, makeTerminalHarness, scriptedIds } from "./helpers/console.js";

describe("console terminal ops: create_session", () => {
	it("create_session relays a createSession host op carrying the new session name and workdir hint", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c1"),
		);
		expect(reply.result).toMatchObject({ created: true, id: "scratch" });
		expect(h.hostOps[0]).toEqual({
			kind: "createSession",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "scratch" },
			workdirHint: "scratch",
			dedupKey: "conv-pixel:c1",
		});
	});

	it("a retried create_session with the same opId launches once (idempotent)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "create_session", target: "host", sessionName: "scratch" }, "cdup");
		const [r1, r2] = await Promise.all([h.handler.handleFrame(f), h.handler.handleFrame(f)]);
		expect(r1.ok && r2.ok).toBe(true);
		expect(h.hostOps).toHaveLength(1);
	});

	it("create_session with a displayLabel mints an opaque id, records it, and launches under it", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "cv2"),
		);
		const res = reply.result as { created: boolean; id: string; sessionLabel: string; labelSanitized?: boolean };
		expect(res.created).toBe(true);
		expect(res.id).toMatch(/^[0-9a-f]{6}$/);
		expect(res.sessionLabel).toBe("My Work");
		expect(res.labelSanitized).toBeFalsy();
		expect(h.hostOps[0]).toMatchObject({
			kind: "createSession",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: res.id },
		});
		expect(store.getByTeam(`recipe-app.${res.id}`)?.sessionLabel).toBe("My Work");
	});

	it("create_session flags labelSanitized when the displayLabel is rejected outright, falling back to the id", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", displayLabel: "\u200b" }, "cv-unsanitary"),
		);
		const res = reply.result as { id: string; sessionLabel: string; labelSanitized?: boolean };
		expect(res.labelSanitized).toBe(true);
		expect(res.sessionLabel).toBe(res.id);
	});

	it("create_session on the sessionName path never flags labelSanitized, even though sessionLabel legitimately equals id there", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "cv-name-only"),
		);
		const res = reply.result as { id: string; sessionLabel: string; labelSanitized?: boolean };
		// No displayLabel was ever sent, so sessionLabel defaulting to the id is expected, unrelated
		// behavior - never the sanitize-fallback signal.
		expect(res.sessionLabel).toBe(res.id);
		expect(res.labelSanitized).toBeFalsy();
	});

	it("create_session sends the un-deduped workdir hint when a display label collides", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const r1 = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", displayLabel: "app" }, "cwd1"),
		);
		const r2 = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", displayLabel: "app" }, "cwd2"),
		);
		// The board label dedups, but the workdir intent does not: both sessions open ~/projects/app,
		// so the host op must carry the workdirHint field ("app"), not the deduped sessionLabel ("app-2").
		expect((r1.result as { sessionLabel: string }).sessionLabel).toBe("app");
		expect((r2.result as { sessionLabel: string }).sessionLabel).toBe("app-2");
		expect((h.hostOps[1] as { workdirHint?: string }).workdirHint).toBe("app");
	});

	it("create_session with a picked workdir stores it on the record and the host op carries it over the label hint", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", displayLabel: "deep", workdir: "~/some/deep/dir" }, "cwp1"),
		);
		const res = reply.result as { id: string };
		expect(store.getByTeam(`host.${res.id}`)?.workdirPath).toBe("~/some/deep/dir");
		expect((h.hostOps[0] as { workdirHint?: string }).workdirHint).toBe("~/some/deep/dir");
	});

	it("create_session rejects a malformed workdir before any record or launch side effect", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", displayLabel: "bad", workdir: "relative/dir" }, "cwp2"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("workdir");
		expect(h.hostOps).toHaveLength(0);
		expect(store.size).toBe(0);
	});

	it("create_session on a devcontainer target wakes it instead of relaying a raw createSession host op", async () => {
		const woken: string[] = [];
		const h = makeTerminalHarness(undefined, undefined, {
			tryWakeTeam: async (team) => {
				woken.push(team);
				return { ok: true };
			},
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c1"),
		);
		expect(reply.result).toMatchObject({ created: true, id: "scratch" });
		expect(woken).toEqual(["recipe-app.scratch"]);
		expect(h.hostOps).toHaveLength(0);
	});

	it("create_session on a host target still relays through relayToHost, ignoring tryWakeTeam", async () => {
		const woken: string[] = [];
		const h = makeTerminalHarness(undefined, undefined, {
			tryWakeTeam: async (team) => {
				woken.push(team);
				return { ok: true };
			},
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", sessionName: "scratch" }, "c1"),
		);
		expect(reply.result).toMatchObject({ created: true, id: "scratch" });
		expect(woken).toEqual([]);
		expect(h.hostOps).toHaveLength(1);
	});

	it("create_session reattaching an existing host record threads its saved claudeSessionId as resumeSessionId, so a Close Tab -> reopen resumes instead of starting fresh", async () => {
		const store = new SessionStore();
		store.adoptById("cef9ae", {
			spawn: "host",
			sessionLabel: "Palworld",
			claudeSessionId: "12345678-1234-1234-1234-123456789abc",
		});
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", sessionName: "cef9ae" }, "reopen1"),
		);
		expect(reply.result).toMatchObject({ id: "cef9ae", sessionLabel: "Palworld" });
		expect(h.hostOps[0]).toMatchObject({
			kind: "createSession",
			target: { kind: "host", name: "host", sessionName: "cef9ae" },
			resumeSessionId: "12345678-1234-1234-1234-123456789abc",
		});
	});

	it("create_session minting a brand-new session carries no resumeSessionId (nothing to resume yet)", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		await h.handler.handleFrame(frame({ kind: "create_session", target: "host", sessionName: "fresh" }, "new1"));
		expect(h.hostOps[0]).toMatchObject({ kind: "createSession" });
		expect((h.hostOps[0] as { resumeSessionId?: string }).resumeSessionId).toBeUndefined();
	});

	it("create_session on a host target keeps the launch marked in-flight until awaitRegister resolves, not just the tmux-spawn ack", async () => {
		const releases: string[] = [];
		let resolveRegister: ((r: WakeResult) => void) | undefined;
		const h = makeTerminalHarness(undefined, undefined, {
			markCreateInFlight: (team) => () => releases.push(team),
			awaitRegister: () =>
				new Promise<WakeResult>((resolve) => {
					resolveRegister = resolve;
				}),
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "host", sessionName: "scratch" }, "c1"),
		);
		expect(reply.result).toMatchObject({ created: true, id: "scratch" });
		// relayToHost's own createSession op already settled (the reply came back), but the
		// in-flight marker must still be held pending the real MCP registration.
		expect(releases).toEqual([]);

		resolveRegister?.({ ok: true });
		await new Promise((r) => setTimeout(r, 10));
		expect(releases).toEqual(["host.scratch"]);
	});

	it("create_session on a devcontainer target releases in-flight as soon as tryWakeTeam settles, without waiting on awaitRegister", async () => {
		const releases: string[] = [];
		let awaitRegisterCalled = false;
		const h = makeTerminalHarness(undefined, undefined, {
			tryWakeTeam: async () => ({ ok: true }),
			markCreateInFlight: (team) => () => releases.push(team),
			awaitRegister: () => {
				awaitRegisterCalled = true;
				return new Promise<WakeResult>(() => {});
			},
		});
		await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c1"),
		);
		expect(releases).toEqual(["recipe-app.scratch"]);
		expect(awaitRegisterCalled).toBe(false);
	});

	it("create_session on a host target releases in-flight at the tmux-spawn ack when no awaitRegister is wired", async () => {
		const releases: string[] = [];
		const h = makeTerminalHarness(undefined, undefined, {
			markCreateInFlight: (team) => () => releases.push(team),
		});
		await h.handler.handleFrame(frame({ kind: "create_session", target: "host", sessionName: "scratch" }, "c1"));
		expect(releases).toEqual(["host.scratch"]);
	});

	it("a devcontainer create past the bound returns a pending status and settles once the wake resolves", async () => {
		const store = new SessionStore();
		let resolveWake: ((r: WakeResult) => void) | undefined;
		const h = makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			createSessionBoundMs: 20,
			tryWakeTeam: () =>
				new Promise<WakeResult>((resolve) => {
					resolveWake = resolve;
				}),
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c1"),
		);
		expect(reply.result).toEqual({
			created: true,
			id: "scratch",
			sessionLabel: "scratch",
			labelSanitized: false,
			status: "pending",
		});
		// The record is already adopted (visible to teams()) while the wake is still in flight.
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();

		resolveWake?.({ ok: true });
		await new Promise((r) => setTimeout(r, 10));
		// A successful backgrounded wake leaves the record in place.
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();
	});

	it("a devcontainer create's backgrounded wake failure rolls back the record it created", async () => {
		const store = new SessionStore();
		let resolveWake: ((r: WakeResult) => void) | undefined;
		const h = makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			createSessionBoundMs: 20,
			tryWakeTeam: () =>
				new Promise<WakeResult>((resolve) => {
					resolveWake = resolve;
				}),
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c1"),
		);
		expect(reply.result).toMatchObject({ status: "pending" });
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();

		// A DEFINITIVE failure (no errorKind), unlike the ambiguous-timeout/disconnect cases below.
		resolveWake?.({ ok: false });
		await new Promise((r) => setTimeout(r, 10));
		// The failed backgrounded wake rolls back the record this op created, same as a fast failure.
		expect(store.getByTeam("recipe-app.scratch")).toBeUndefined();
	});

	it("a devcontainer create whose wake fails within the bound throws and rolls back synchronously", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			tryWakeTeam: async () => ({ ok: false }),
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("scratch");
		expect(store.getByTeam("recipe-app.scratch")).toBeUndefined();
	});

	it("a re-dispatched displayLabel create reattaches its record instead of minting a phantom (restart-safe)", async () => {
		const store = new SessionStore();
		const f = frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "cvrestart");
		// A fresh handler (cold op-cache, shared store) stands in for a gateway restart re-running the op.
		const r1 = await makeTerminalHarness(undefined, undefined, { sessionStore: store }).handler.handleFrame(f);
		const r2 = await makeTerminalHarness(undefined, undefined, { sessionStore: store }).handler.handleFrame(f);
		expect((r1.result as { id: string }).id).toBe((r2.result as { id: string }).id);
		expect(store.size).toBe(1);
	});

	it("a snapshot/restore round trip into a fresh store instance still reattaches", async () => {
		const store1 = new SessionStore();
		const f = frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "cv-restore");
		const r1 = await makeTerminalHarness(undefined, undefined, { sessionStore: store1 }).handler.handleFrame(f);

		const store2 = new SessionStore();
		store2.restore(store1.snapshot());
		const r2 = await makeTerminalHarness(undefined, undefined, { sessionStore: store2 }).handler.handleFrame(f);

		expect((r1.result as { id: string }).id).toBe((r2.result as { id: string }).id);
		expect(store2.size).toBe(1);
	});

	it("a genuine collision with an unrelated record re-rolls to a fresh id, leaving the stranger untouched", async () => {
		const store = new SessionStore({ idGen: scriptedIds("taken1", "fresh2") });
		store.adoptById("taken1", { spawn: "recipe-app", sessionLabel: "Stranger", mintedFrom: "conv-other:op-other" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "c-collide"),
		);
		const res = reply.result as { id: string };
		expect(res.id).toBe("fresh2");
		expect(store.size).toBe(2);
		expect(store.getByTeam("recipe-app.taken1")?.sessionLabel).toBe("Stranger");
	});

	it("retrying after a collision's winning record is forgotten mints a fresh id, not the stranger's", async () => {
		const store = new SessionStore({ idGen: scriptedIds("taken1", "won2") });
		store.adoptById("taken1", { spawn: "recipe-app", sessionLabel: "Stranger", mintedFrom: "conv-other:op-other" });
		const f = frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "c-churn");
		const r1 = await makeTerminalHarness(undefined, undefined, { sessionStore: store }).handler.handleFrame(f);
		const firstId = (r1.result as { id: string }).id;
		expect(firstId).toBe("won2");
		store.forget(`recipe-app.${firstId}`);

		const r2 = await makeTerminalHarness(undefined, undefined, { sessionStore: store }).handler.handleFrame(f);
		expect(r2.ok).toBe(true);
		const secondId = (r2.result as { id: string }).id;
		expect(secondId).not.toBe(firstId);
		expect(store.getByTeam(`recipe-app.${secondId}`)?.sessionLabel).toBe("My Work");
		expect(store.getByTeam("recipe-app.taken1")?.sessionLabel).toBe("Stranger");
	});

	it("a sessionName-provided create ignores a coincidentally-matching mint-path mintedFrom", async () => {
		const store = new SessionStore();
		store.adoptById("minted-elsewhere", {
			spawn: "recipe-app",
			sessionLabel: "Other",
			mintedFrom: "conv-pixel:c-scope",
		});
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "explicit-name" }, "c-scope"),
		);
		expect(reply.result).toMatchObject({ created: true, id: "explicit-name" });
		expect(store.getByTeam("recipe-app.explicit-name")).toBeDefined();
		expect(store.getByTeam("recipe-app.minted-elsewhere")?.sessionLabel).toBe("Other");
	});

	it("two different create_session dispatches racing on the same first-choice id both still land distinctly", async () => {
		// Both draw "shared-slot" as their first attempt; whichever mint() runs first claims it, the
		// other must fall through to its own second draw rather than reattach to the winner's record.
		const store = new SessionStore({ idGen: scriptedIds("shared-slot", "shared-slot", "second-slot") });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const f1 = frame({ kind: "create_session", target: "recipe-app", displayLabel: "First" }, "c-race-1");
		const f2 = frame({ kind: "create_session", target: "recipe-app", displayLabel: "Second" }, "c-race-2");
		const [r1, r2] = await Promise.all([h.handler.handleFrame(f1), h.handler.handleFrame(f2)]);
		const id1 = (r1.result as { id: string }).id;
		const id2 = (r2.result as { id: string }).id;
		expect(id1).not.toBe(id2);
		expect(store.size).toBe(2);
		expect(store.getByTeam(`recipe-app.${id1}`)?.sessionLabel).toBe("First");
		expect(store.getByTeam(`recipe-app.${id2}`)?.sessionLabel).toBe("Second");
	});

	it("create_session with only a sessionName adopts it as the id (old-app path)", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "cv3"),
		);
		expect(reply.result).toMatchObject({ created: true, id: "scratch", sessionLabel: "scratch" });
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();
	});

	it("a failed launch rolls back the freshly-minted record (no orphan)", async () => {
		const store = new SessionStore({ idGen: () => "minted1" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store, relayFails: true });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "cv4"),
		);
		expect(reply.ok).toBe(false);
		expect(store.size).toBe(0);
	});

	it("a bare host-op timeout does NOT roll back the record - the launch may still be running", async () => {
		const store = new SessionStore({ idGen: () => "minted1" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store, relayTimesOut: true });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "cv-timeout"),
		);
		expect(reply.ok).toBe(false);
		expect(store.getByTeam("recipe-app.minted1")?.sessionLabel).toBe("My Work");
	});

	it("a host-disconnect failure is exactly as ambiguous as a timeout - also no rollback", async () => {
		const store = new SessionStore({ idGen: () => "minted1" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store, relayDisconnects: true });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "cv-disconnect"),
		);
		expect(reply.ok).toBe(false);
		expect(store.getByTeam("recipe-app.minted1")?.sessionLabel).toBe("My Work");
	});

	it("a devcontainer wake's own ambiguous timeout/disconnect is exactly as ambiguous as the host-relay case - also no rollback", async () => {
		// Unlike a definitive wake failure (the earlier "throws and rolls back synchronously" test),
		// tryWakeTeam can itself report an ambiguous outcome (WakeCoordinator's own timeout, or the
		// host WS dropping mid-wait) - the container bring-up may still be running underneath. This must
		// roll back exactly as little as a host-target relayToHost timeout/disconnect does.
		for (const errorKind of ["timeout", "disconnected"] as const) {
			const store = new SessionStore({ idGen: () => "minted1" });
			const h = makeTerminalHarness(undefined, undefined, {
				sessionStore: store,
				tryWakeTeam: async () => ({ ok: false, errorKind }),
			});
			const reply = await h.handler.handleFrame(
				frame(
					{ kind: "create_session", target: "recipe-app", displayLabel: "My Work" },
					`cv-wake-${errorKind}`,
				),
			);
			expect(reply.ok).toBe(false);
			expect(store.getByTeam("recipe-app.minted1")?.sessionLabel).toBe("My Work");
		}
	});

	it("a mint-path record a retry reattached still rolls back on a later, genuinely definitive failure", async () => {
		const store = new SessionStore();
		const f = frame({ kind: "create_session", target: "recipe-app", displayLabel: "My Work" }, "c-def-fail");
		// Attempt 1: an ambiguous timeout keeps the record, same as the single-attempt case above.
		const r1 = await makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			relayTimesOut: true,
		}).handler.handleFrame(f);
		expect(r1.ok).toBe(false);
		const firstId = store.findByMintedFrom("conv-pixel:c-def-fail", "recipe-app")?.id;
		expect(firstId).toBeDefined();

		// Attempt 2 (a retry of the identical op, reattaching via provenance): a real, definitive
		// failure this time must still roll back - reattaching on a retry does not grant permanent
		// rollback immunity the way finding an unrelated pre-existing record would.
		const r2 = await makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			relayFails: true,
		}).handler.handleFrame(f);
		expect(r2.ok).toBe(false);
		expect(store.getByTeam(`recipe-app.${firstId}`)).toBeUndefined();
	});

	it("a sessionName-provided create's ambiguous timeout also skips rollback, same as the mint path", async () => {
		const store = new SessionStore();
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store, relayTimesOut: true });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "cv-name-timeout"),
		);
		expect(reply.ok).toBe(false);
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();
	});

	it("a sessionName-path record a retry reattached still rolls back on a later, genuinely definitive failure", async () => {
		const store = new SessionStore();
		const f = frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c-name-def-fail");
		// Attempt 1: an ambiguous timeout keeps the record (rollbackEligible via created:true).
		const r1 = await makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			relayTimesOut: true,
		}).handler.handleFrame(f);
		expect(r1.ok).toBe(false);
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();

		// Attempt 2 (a retry of the identical op, reattaching - created:false this time): the reattached
		// record's own mintedFrom still matches this dedupKey (stamped on attempt 1's fresh create), so
		// it stays rollback-eligible and a real, definitive failure now must roll it back - a reattach on
		// a retry must not grant permanent rollback immunity.
		const r2 = await makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			relayFails: true,
		}).handler.handleFrame(f);
		expect(r2.ok).toBe(false);
		expect(store.getByTeam("recipe-app.scratch")).toBeUndefined();
	});

	it("a sessionName-provided create never rolls back an unrelated stranger's pre-existing record, even on a genuine failure", async () => {
		const store = new SessionStore();
		// A stranger's record already sits at "scratch", created by a wholly different dispatch (no
		// mintedFrom stamped at all, e.g. it predates this mechanism or was itself sessionName-created).
		store.adoptById("scratch", { spawn: "recipe-app", sessionLabel: "Stranger" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store, relayFails: true });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c-name-stranger"),
		);
		expect(reply.ok).toBe(false);
		// The stranger's session must survive: created:false AND mintedFrom does not match this dedupKey.
		expect(store.getByTeam("recipe-app.scratch")?.sessionLabel).toBe("Stranger");
	});

	it("create_session against a reserved/catalog-colliding sessionName throws cleanly with no side effects", async () => {
		const store = new SessionStore({ clash: (id) => id === "reserved-name" });
		const h = makeTerminalHarness(undefined, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "reserved-name" }, "c-clash"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("reserved-name");
		expect(store.size).toBe(0);
		expect(h.hostOps).toHaveLength(0);
	});

	it("a backgrounded rollback never forgets a record that confirmed while its wake was still resolving", async () => {
		const store = new SessionStore();
		let resolveWake: ((r: WakeResult) => void) | undefined;
		const h = makeTerminalHarness(undefined, undefined, {
			sessionStore: store,
			createSessionBoundMs: 20,
			tryWakeTeam: () =>
				new Promise<WakeResult>((resolve) => {
					resolveWake = resolve;
				}),
		});
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "scratch" }, "c-confirm-race"),
		);
		expect(reply.result).toMatchObject({ status: "pending" });

		// The session actually confirms (a real handshake) before the slow wake settles.
		store.confirm("recipe-app.scratch", { team: "recipe-app.scratch", subId: "s1" });

		// The wake's own signal still says "failed" (e.g. its registration window narrowed past a slow
		// first boot) - that must not destroy a session that has since genuinely come up.
		resolveWake?.({ ok: false });
		await new Promise((r) => setTimeout(r, 10));
		expect(store.getByTeam("recipe-app.scratch")).toBeDefined();
	});

	it("a rejected target (validation throw after mint) rolls back the record too", async () => {
		const store = new SessionStore({ idGen: () => "minted1" });
		const h = makeTerminalHarness(() => false, undefined, { sessionStore: store });
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "bogus-project", displayLabel: "My Work" }, "cv5"),
		);
		expect(reply.ok).toBe(false);
		expect(store.size).toBe(0);
	});
});
