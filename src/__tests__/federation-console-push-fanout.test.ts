import { describe, expect, it, vi } from "vitest";
import { createRoutes } from "../gateway/routes.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import type { FederatedOp } from "../shared/federation-protocol.js";
import {
	channelWs,
	fakeEvie,
	gateRoutes,
	makeCtx,
	registryWith,
	sealerA,
	sealerB,
	TEST_REQ,
} from "./helpers/federation.js";

describe("console_push multi-gateway fan-out (same-Domain, E2E sealed)", () => {
	it("humanNotify relays the same notice to every OTHER same-Domain Gateway via list_gateways, self-excluding and filtering through the allowlist", async () => {
		const { routes: hostbRoutes, consolePushCalls } = gateRoutes([]);
		let landedOnHostb: FederatedOp | undefined;
		const evie = fakeEvie({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: (op) => {
				landedOnHostb = op;
				const push = op as { entry: unknown; dedupeKey: string };
				return hostbRoutes.consolePush(push.entry as never, push.dedupeKey);
			},
			onCall: (action) =>
				action === "list_gateways"
					? // Includes the caller itself (hosta) and an unadmitted gateway (eve-gw), both of
						// which must be filtered out before any relay is even attempted.
						{ gateways: [{ gatewayId: "hosta" }, { gatewayId: "hostb" }, { gatewayId: "eve-gw" }] }
					: { ok: true },
		});
		const mailboxStore = new DeviceMailboxStore();
		const ctx = makeCtx("hosta", {
			evieClient: evie.client,
			sealer: sealerA,
			mailboxStore,
			ownerId: () => "owner-1",
			// hostb AND hosta (the caller's own id) are both admitted into the local allowlist - a
			// real Allowlist self-admits its own gateway (see Allowlist.selfAdmission), so this must
			// NOT be the thing that excludes hosta. Only the self-exclusion guard can, which is what
			// this isolates: if that guard were ever deleted, hosta would be relayed to and the
			// assertion below would catch it (an allowlist that only excluded eve-gw would not).
			resolvesLocalGateway: (gatewayId) => gatewayId === "hostb" || gatewayId === "hosta",
		});
		const { humanNotify } = createRoutes(ctx);

		const res = humanNotify(TEST_REQ, {
			from: "recipe-app",
			title: "cycle done",
			summary: "s",
			full: "body",
			fullSpoken: "Spoken body.",
		});
		expect((await res.json()).delivered).toBe(true);
		// The local landing is synchronous, independent of the fan-out.
		expect(mailboxStore.get("owner-1")?.drain().entries).toHaveLength(1);

		// fanOutConsolePush is fire-and-forget; wait for the relay to actually land on hostb.
		await vi.waitFor(() => expect(consolePushCalls).toHaveLength(1));

		expect(landedOnHostb).toMatchObject({ kind: "console_push" });
		// fullSpoken must survive the console_push entry schema (a non-strict zod parse strips
		// unknown keys, so a schema missing the field would silently drop it between Gateways).
		expect(consolePushCalls[0].entry).toMatchObject({
			kind: "notice",
			from: "recipe-app",
			title: "cycle done",
			summary: "s",
			fullSpoken: "Spoken body.",
		});
		// Only hostb was actually relayed to - hosta (self) and eve-gw (unadmitted) were filtered
		// out before ever reaching evie's gateway_relay call.
		const relayed = evie.calls.filter((c) => c.action === "gateway_relay").map((c) => c.params.dstGateway);
		expect(relayed).toEqual(["hostb"]);
	});

	it("a relay retry (the same dedupeKey re-delivered) lands on the sibling Gateway exactly once", async () => {
		const mailboxStore = new DeviceMailboxStore();
		const bobCtx = makeCtx("hostb", { mailboxStore, ownerId: () => "owner-1" });
		const { consolePush } = createRoutes(bobCtx);

		const entry = {
			kind: "notice" as const,
			session_id: "notice.alice.hosta.recipe-app.claude",
			from: "recipe-app",
		};
		consolePush(entry, "stable-key-1");
		consolePush(entry, "stable-key-1"); // an at-least-once retry of the SAME relay attempt

		expect(mailboxStore.get("owner-1")?.drain().entries).toHaveLength(1);
	});

	it("pluginAction relays a plugin_action entry to every OTHER same-Domain Gateway, same convergence path as a notice", async () => {
		const { routes: hostbRoutes, consolePushCalls } = gateRoutes([]);
		let landedOnHostb: FederatedOp | undefined;
		const evie = fakeEvie({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: (op) => {
				landedOnHostb = op;
				const push = op as { entry: unknown; dedupeKey: string };
				return hostbRoutes.consolePush(push.entry as never, push.dedupeKey);
			},
			onCall: (action) =>
				action === "list_gateways"
					? { gateways: [{ gatewayId: "hosta" }, { gatewayId: "hostb" }] }
					: { ok: true },
		});
		const mailboxStore = new DeviceMailboxStore();
		const ctx = makeCtx("hosta", {
			evieClient: evie.client,
			sealer: sealerA,
			mailboxStore,
			ownerId: () => "owner-1",
			resolvesLocalGateway: (gatewayId) => gatewayId === "hostb" || gatewayId === "hosta",
		});
		const { pluginAction } = createRoutes(ctx);

		const res = pluginAction(TEST_REQ, { from: "recipe-app", pluginId: "designer", actionType: "delete-card" });
		expect((await res.json()).delivered).toBe(true);
		expect(mailboxStore.get("owner-1")?.drain().entries).toHaveLength(1);

		await vi.waitFor(() => expect(consolePushCalls).toHaveLength(1));
		expect(landedOnHostb).toMatchObject({ kind: "console_push" });
		expect(consolePushCalls[0].entry).toMatchObject({
			kind: "plugin_action",
			pluginId: "designer",
			actionType: "delete-card",
		});
	});

	it("single-Gateway behavior is unchanged: no evieClient, humanNotify still delivers locally with no error", async () => {
		const mailboxStore = new DeviceMailboxStore();
		const { humanNotify } = createRoutes(makeCtx("hosta", { mailboxStore, ownerId: () => "owner-1" }));
		const res = humanNotify(TEST_REQ, { from: "recipe-app", title: "t", summary: "s", full: "body" });
		expect((await res.json()).delivered).toBe(true);
		expect(mailboxStore.get("owner-1")?.drain().entries).toHaveLength(1);
	});

	it("consolePush (the landing side) never itself fans back out - no gossip loop", async () => {
		// A connected evieClient is deliberately wired in: if consolePush ever grew a call to
		// fanOutConsolePush (the regression this guards against), this evie mock would record it.
		const evie = fakeEvie({});
		const mailboxStore = new DeviceMailboxStore();
		const ctx = makeCtx("hostb", {
			evieClient: evie.client,
			sealer: sealerB,
			mailboxStore,
			ownerId: () => "owner-1",
		});
		const { consolePush } = createRoutes(ctx);

		consolePush({ kind: "notice", session_id: "notice.alice.hosta.recipe-app.claude", from: "recipe-app" }, "dk-1");
		// consolePush is synchronous with no relay of its own, but give a hypothetical regression's
		// fire-and-forget fan-out a real window to have started before asserting silence.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mailboxStore.get("owner-1")?.drain().entries).toHaveLength(1);
		expect(evie.calls).toHaveLength(0);
	});

	it("mirrorPeer's peer-kind fan-out relays to a sibling Gateway, landing exactly once per mirror copy even under a relay retry", async () => {
		const hostbMailbox = new DeviceMailboxStore();
		const { consolePush: hostbConsolePush } = createRoutes(
			makeCtx("hostb", { mailboxStore: hostbMailbox, ownerId: () => "owner-1" }),
		);
		const evie = fakeEvie({
			destSealer: sealerB,
			srcGateway: "hosta",
			handle: (op) => {
				const push = op as { entry: unknown; dedupeKey: string };
				// Simulate an at-least-once relay retry: the identical op lands on hostb twice.
				hostbConsolePush(push.entry as never, push.dedupeKey);
				return hostbConsolePush(push.entry as never, push.dedupeKey);
			},
			onCall: (action) => (action === "list_gateways" ? { gateways: [{ gatewayId: "hostb" }] } : { ok: true }),
		});
		const pushed: Record<string, unknown>[] = [];
		const ctx = makeCtx("hosta", {
			evieClient: evie.client,
			sealer: sealerA,
			mailboxStore: new DeviceMailboxStore(),
			ownerId: () => "owner-1",
			registry: registryWith({ "coolib.dev": channelWs(pushed) }),
		});
		const { send } = createRoutes(ctx);

		await send(new Request("http://localhost/send", { method: "POST" }), {
			from: "coolapp.dev",
			fromConversationId: "conv-1",
			to: "coolib.dev",
			body: "can you check this?",
			channelOnly: true,
		});

		// A local-to-local send mirrors BOTH participants (their own thread each), so two distinct
		// peer entries fan out to hostb; each survives its own simulated retry landing exactly once.
		await vi.waitFor(() => expect(hostbMailbox.get("owner-1")?.drain().entries).toHaveLength(2));
	});
});
