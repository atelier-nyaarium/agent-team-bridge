import { describe, expect, it } from "vitest";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import {
	consoleTeam,
	crossSend,
	gateRoutes,
	lib,
	memBinding,
	memShareState,
	scratch,
	type TeamInfoLite,
	unknownKindTeam,
} from "./helpers/federation.js";

describe("destination gate (cross-Domain relay handleOp)", () => {
	it("DENIES a cross-Domain send to a session NOT shared to the caller's Domain", async () => {
		const { routes, sendCalls } = gateRoutes([lib()]);
		// lib exists and is a devcontainer, but it is shared to "carol", not "alice".
		const share = memShareState([["alice.hostb.lib.dev", "carol"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		await expect(handleOp(crossSend("lib.dev"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0); // never reached routes.send
	});

	it("ALLOWS a cross-Domain send to a shared devcontainer and touches the share", async () => {
		const { routes, sendCalls } = gateRoutes([lib()]);
		const share = memShareState([["alice.hostb.lib.dev", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		const result = (await handleOp(crossSend("lib.dev"), "alice-gw", "alice")) as { status: string };
		expect(result.status).toBe("running");
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0]).toMatchObject({ to: "lib.dev", from: "alice.alice-gw.app.dev", channelOnly: true });
		// A permitted delivery refreshed the share so a live thread does not auto-forget.
		expect(share.touched).toEqual(["alice.hostb.lib.dev"]);
	});

	it("ALLOWS a cross-Domain send to a shared LOOSE session", async () => {
		const { routes, sendCalls } = gateRoutes([scratch()]);
		const share = memShareState([["alice.hostb.scratch.dev", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		await handleOp(crossSend("scratch.dev"), "alice-gw", "alice");
		expect(sendCalls).toHaveLength(1);
	});

	it("HARD-DENIES a cross-Domain send to a session of an unrecognized kind, even if 'shared'", async () => {
		// A crafted share record for a non-shareable kind must not open it: the kind gate is the
		// hard boundary (agents-only), checked before the share lookup.
		const { routes, sendCalls } = gateRoutes([unknownKindTeam()]);
		const share = memShareState([["alice.hostb.unknown-kind.dev", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		await expect(handleOp(crossSend("unknown-kind.dev"), "alice-gw", "alice")).rejects.toThrow(
			/cross-Domain op denied/,
		);
		expect(sendCalls).toHaveLength(0);
	});

	it("HARD-DENIES a cross-Domain send to a console-kind session", async () => {
		const { routes, sendCalls } = gateRoutes([consoleTeam()]);
		const share = memShareState([["alice.hostb.pixel.dev", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		await expect(handleOp(crossSend("pixel.dev"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
	});

	it("DENIES a cross-Domain send to an unknown session name", async () => {
		const { routes, sendCalls } = gateRoutes([lib()]);
		const share = memShareState([["alice.hostb.ghost.dev", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		await expect(handleOp(crossSend("ghost.dev"), "alice-gw", "alice")).rejects.toThrow(/cross-Domain op denied/);
		expect(sendCalls).toHaveLength(0);
	});

	// The denial must be an identical, name-free and kind-free error for an unshared-but-existing
	// session and for a nonexistent one. Distinct messages are an existence oracle: a friend could
	// probe which session names and kinds exist, defeating the shared-only list_teams filter.
	it("the denial for an unshared-existing session is byte-identical to a nonexistent one", async () => {
		const { routes } = gateRoutes([lib()]); // lib exists (devcontainer), shared to nobody
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: memShareState(), // nothing shared to alice
		});
		const existsUnshared = await handleOp(crossSend("lib.dev"), "alice-gw", "alice").catch((e: Error) => e.message);
		const nonexistent = await handleOp(crossSend("ghost.dev"), "alice-gw", "alice").catch((e: Error) => e.message);
		const wrongKind = await handleOp(crossSend("lib.dev"), "alice-gw", "alice").catch((e: Error) => e.message);
		expect(existsUnshared).toBe(nonexistent);
		expect(existsUnshared).toBe(wrongKind);
		// And the message leaks neither the name nor the kind nor the Domain.
		expect(existsUnshared).not.toMatch(/lib|ghost|devcontainer|loose|alice/);
	});

	it("a cross-Domain WAKE is gated like a send (only a shared devcontainer/loose may wake)", async () => {
		const { routes } = gateRoutes([lib()]);
		let woke = false;
		const share = memShareState([["alice.hostb.lib.dev", "alice"]]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: async () => {
				woke = true;
				return { ok: true };
			},
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		// Unshared wake denied, no wake fired.
		await expect(handleOp({ kind: "wake", team: "scratch.dev" }, "alice-gw", "alice")).rejects.toThrow(/denied/);
		expect(woke).toBe(false);
		// Shared wake allowed.
		expect(await handleOp({ kind: "wake", team: "lib.dev" }, "alice-gw", "alice")).toEqual({ ok: true });
		expect(woke).toBe(true);
	});

	// A reply gate keyed on the job's RECORDED, verified target Domain (not the bare,
	// friend-controlled gateway id in the session string). alice's anchor for
	// `conv.c1.bob.bob-gw.lib.dev` records dstDomainId "bob": a reply lands only when the VERIFIED
	// sender is Domain "bob" AND gateway "bob-gw" (the gateway in the job's own origin-set key).
	const aliceAnchors = memBinding({ "conv.c1.bob.bob-gw.lib.dev": { dstDomainId: "bob", keyGateway: "bob-gw" } });

	it("DELIVERS a cross-Domain response_push from the friend the send was routed to (no local team needed)", async () => {
		// The origin has NO local 'lib' team (lib lives on bob-gw); the reply must still land.
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "alice-gw",
			localDomainId: "alice",
			shareState: memShareState(),
			crossDomainBinding: aliceAnchors,
		});
		const r = (await handleOp(
			{ kind: "response_push", session_id: "conv.c1.bob.bob-gw.lib.dev", status: "completed", response: "done" },
			"bob-gw",
			"bob",
		)) as { ok: boolean };
		expect(r.ok).toBe(true);
		expect(respondCalls[0]).toMatchObject({ session_id: "conv.c1.bob.bob-gw.lib.dev", response: "done" });
	});

	it("DENIES a cross-Domain response_push from a DIFFERENT linked friend than the one targeted", async () => {
		// carol is a linked friend too, but the anchor recorded the send went to Domain "bob",
		// so carol (Domain "carol") must not be able to deliver a reply into bob's thread.
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "alice-gw",
			localDomainId: "alice",
			shareState: memShareState(),
			crossDomainBinding: aliceAnchors,
		});
		await expect(
			handleOp(
				{ kind: "response_push", session_id: "conv.c1.bob.bob-gw.lib.dev", status: "completed", response: "x" },
				"carol-gw",
				"carol",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);
	});

	it("DENIES a cross-Domain response_push for a session with no recorded anchor at all", async () => {
		// No anchor for this session id (the friend invented it): deny rather than deliver.
		const { routes, respondCalls } = gateRoutes([]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "alice-gw",
			localDomainId: "alice",
			shareState: memShareState(),
			crossDomainBinding: aliceAnchors,
		});
		await expect(
			handleOp(
				{ kind: "response_push", session_id: "conv.c1.eve.eve-gw.lib.dev", status: "completed", response: "x" },
				"eve-gw",
				"eve",
			),
		).rejects.toThrow(/response_push.*denied/);
		expect(respondCalls).toHaveLength(0);
	});

	it("SAME-DOMAIN (srcDomainId null) is unchanged: no share gate, a non-shareable kind still reachable", async () => {
		// A same-Domain relay never consults the share state. Even a non-shareable kind lands
		// (the share/kind gate is cross-Domain only); intra-Domain trust is the existing model.
		const { routes, sendCalls } = gateRoutes([unknownKindTeam()]);
		const share = memShareState(); // empty - must not be consulted
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		const r = (await handleOp(crossSend("unknown-kind.dev"), "hostb-peer", null)) as { status: string };
		expect(r.status).toBe("running");
		expect(sendCalls).toHaveLength(1);
		expect(share.touched).toEqual([]); // never touched on a same-Domain op
	});
});

describe("list_teams share filter (cross-Domain caller)", () => {
	const allKinds = [lib(), scratch(), unknownKindTeam(), consoleTeam()];

	it("a cross-Domain caller sees ONLY the sessions shared to its Domain", async () => {
		const { routes } = gateRoutes(allKinds);
		// lib + scratch shared to alice; the unknown kind + console are never shareable anyway.
		const share = memShareState([
			["alice.hostb.lib.dev", "alice"],
			["alice.hostb.scratch.dev", "alice"],
		]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		const { teams } = (await handleOp({ kind: "list_teams" }, "alice-gw", "alice")) as { teams: TeamInfoLite[] };
		expect(teams.map((t) => t.team).sort()).toEqual(["lib.dev", "scratch.dev"]);
	});

	it("a cross-Domain caller in a DIFFERENT Domain sees only ITS shares (never another Domain's)", async () => {
		const { routes } = gateRoutes(allKinds);
		const share = memShareState([
			["alice.hostb.lib.dev", "alice"],
			["alice.hostb.scratch.dev", "carol"],
		]);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: share,
		});
		const carol = (await handleOp({ kind: "list_teams" }, "carol-gw", "carol")) as { teams: TeamInfoLite[] };
		expect(carol.teams.map((t) => t.team)).toEqual(["scratch.dev"]);
	});

	it("a cross-Domain caller with NO shares sees an empty list (never leaks names)", async () => {
		const { routes } = gateRoutes(allKinds);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: memShareState(),
		});
		const { teams } = (await handleOp({ kind: "list_teams" }, "alice-gw", "alice")) as { teams: TeamInfoLite[] };
		expect(teams).toEqual([]);
	});

	it("a SAME-DOMAIN caller (srcDomainId null) still gets the FULL list (today's behavior)", async () => {
		const { routes } = gateRoutes(allKinds);
		const { handleOp } = createGatewayRelayHandler({
			routes: routes as never,
			tryWakeTeam: () => Promise.resolve({ ok: false }),
			localGatewayId: "hostb",
			localDomainId: "alice",
			shareState: memShareState(), // empty - same-Domain ignores it
		});
		const { teams } = (await handleOp({ kind: "list_teams" }, "peer", null)) as { teams: TeamInfoLite[] };
		expect(teams.map((t) => t.team).sort()).toEqual(["lib.dev", "pixel.dev", "scratch.dev", "unknown-kind.dev"]);
	});
});
