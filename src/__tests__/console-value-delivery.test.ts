import { describe, expect, it } from "vitest";
import { createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { jsonResponse, makeValueHarness } from "./helpers/consoleDelivery.js";

describe("console value delivery", () => {
	it("forwards the verified owner key during a cross-Domain request", async () => {
		const h = makeValueHarness();
		const result = await h.dispatch({
			kind: "cross_domain_request",
			listeningToken: "bob-gateway.token",
			pin: "pin",
			requesterOwnerSignPub: "forged-owner",
			requesterDomainId: "alice",
			requesterGatewayId: "test-host",
		});
		expect(result).toMatchObject({ sas: "421717930842", requesterOwnerSignPub: "verified-owner" });
		expect(h.calls.request[0]).toMatchObject({
			requesterOwnerSignPub: "verified-owner",
			requesterDomainId: "alice",
			requesterGatewayId: "test-host",
		});
	});

	it("returns handshake reads and forwards confirmation and cancellation", async () => {
		const h = makeValueHarness();
		expect(await h.dispatch({ kind: "cross_domain_listen" })).toMatchObject({
			listeningToken: "test-host.token",
			receiverGatewayId: "test-host",
		});
		expect(
			await h.dispatch({ kind: "cross_domain_listen_state", listeningToken: "test-host.token" }),
		).toMatchObject({
			pairingArrived: true,
			sas: "sas",
		});
		expect(await h.dispatch({ kind: "cross_domain_confirm", pin: "pin", mySignedLink: {} as never })).toEqual({
			ok: true,
		});
		expect(
			await h.dispatch({ kind: "cross_domain_cancel", listeningToken: "test-host.token", pin: "pin" }),
		).toEqual({
			cancelled: true,
		});
		expect(h.calls.listen).toBe(1);
		expect(h.calls.listenState).toEqual(["test-host.token"]);
		expect(h.calls.confirm).toHaveLength(1);
		expect(h.calls.cancel).toEqual([{ listeningToken: "test-host.token", pin: "pin" }]);
	});

	it("repeats fresh handshake and peer reads instead of caching them by opId", async () => {
		const h = makeValueHarness();
		await h.dispatch({ kind: "cross_domain_listen_state", listeningToken: "test-host.token" }, "same-read");
		await h.dispatch({ kind: "cross_domain_listen_state", listeningToken: "test-host.token" }, "same-read");
		await h.dispatch({ kind: "cross_domain_list_peers" }, "same-peers");
		await h.dispatch({ kind: "cross_domain_list_peers" }, "same-peers");
		expect(h.calls.listenState).toHaveLength(2);
		expect(h.calls.listPeers).toBe(2);
	});

	it("canonicalizes a local share target and expires jobs only after an existing share is removed", async () => {
		const h = makeValueHarness({
			teams: [
				{ team: "app.dev", gatewayId: "test-host", status: "online", kind: "devcontainer", queue_depth: 0 },
			],
		});
		const target = { kind: "domain" as const, domainId: "bob" };
		expect(await h.dispatch({ kind: "cross_domain_share", sessionTarget: "app.dev", target })).toEqual({
			ok: true,
		});
		expect(h.calls.share).toEqual([{ sessionTarget: "alice.test-host.app.dev", target }]);
		expect(await h.dispatch({ kind: "cross_domain_unshare", sessionTarget: "app.dev", target })).toEqual({
			ok: true,
		});
		expect(h.calls.unshare).toEqual([{ sessionTarget: "alice.test-host.app.dev", target }]);
		expect(h.calls.expire).toEqual([{ sessionTarget: "alice.test-host.app.dev", target }]);
	});

	it("rejects an unlinked Domain and a foreign Gateway before changing shares", async () => {
		const h = makeValueHarness({
			teams: [
				{ team: "app.dev", gatewayId: "test-host", status: "online", kind: "devcontainer", queue_depth: 0 },
			],
			crossDomainShare: { isLinkedDomain: () => false },
		});
		await expect(
			h.dispatch({
				kind: "cross_domain_share",
				sessionTarget: "app.dev",
				target: { kind: "domain", domainId: "carol" },
			}),
		).rejects.toThrow("not a linked Domain");
		await expect(
			h.dispatch({
				kind: "cross_domain_share",
				sessionTarget: "alice.other-gateway.app.dev",
				target: { kind: "domain", domainId: "bob" },
			}),
		).rejects.toThrow();
		expect(h.calls.share).toHaveLength(0);
	});

	it("returns current shares and cleanup counts, including a zero-count unlink", async () => {
		const h = makeValueHarness({
			teams: [{ team: "app.dev", gatewayId: "test-host", status: "online", kind: "loose", queue_depth: 0 }],
			unlinkDomain: (domainId) =>
				domainId === "bob"
					? { peersRemoved: 1, sharesDropped: 2, jobsExpired: 3 }
					: { peersRemoved: 0, sharesDropped: 0, jobsExpired: 0 },
		});
		const target = { kind: "domain" as const, domainId: "bob" };
		await h.dispatch({ kind: "cross_domain_share", sessionTarget: "app.dev", target });
		expect(await h.dispatch({ kind: "cross_domain_list_shares" })).toEqual({
			shares: [{ sessionTarget: "alice.test-host.app.dev", target }],
		});
		expect(await h.dispatch({ kind: "cross_domain_unlink", domainId: "bob" })).toEqual({
			peersRemoved: 1,
			sharesDropped: 2,
			jobsExpired: 3,
		});
		expect(h.calls.unlink).toEqual(["bob"]);
	});

	it("reports an unwired federation as an explicit error", async () => {
		const handler = createConsoleDispatcher({
			registry: new Map(),
			conversationRegistry: new Map(),
			localGatewayId: "test-host",
			localDomainId: "alice",
			routes: {
				deliverToOwner: () => true,
				send: async () => jsonResponse({}),
				respond: () => jsonResponse({}),
				teams: () => jsonResponse([]),
				discover: async () => jsonResponse([]),
				discoverFull: async () => ({ teams: [], coverage: { rosterKnown: true, asked: 0, answered: 0 } }),
			},
		});
		await expect(
			handler.handleValue(
				{ kind: "cross_domain_list_peers" },
				"Pixel",
				"conversation",
				"op-unwired",
				"verified-owner",
			),
		).rejects.toThrow("not available");
	});
});
