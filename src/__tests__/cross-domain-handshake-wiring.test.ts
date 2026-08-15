import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CrossDomainHandshakeCoordinator,
	type CrossDomainSelf,
	createCrossDomainHandshakePump,
	parseCommitReply,
	parseRevealReply,
	type XDomainCommitReplyWire,
	type XDomainCommitWire,
	type XDomainRevealReplyWire,
	type XDomainRevealWire,
} from "../gateway/federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { type CrossDomainParty, crossDomainCommitment, crossDomainSas } from "../shared/cross-domain-sas.js";
import type {
	CrossDomainHandshakeReplyParams,
	CrossDomainHandshakeRevealReplyParams,
} from "../shared/evie-protocol.js";

////////////////////////////////
//  Harness

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "xdomain-wiring-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function selfFor(gatewayId: string, domainId: string): CrossDomainSelf {
	return {
		ownerSignPub: () => "owner-pub",
		gatewaySignPub: `${gatewayId}-sign`,
		gatewayBoxPub: `${gatewayId}-box`,
		domainId,
		gatewayId,
	};
}

const REQUESTER: CrossDomainParty = {
	ownerSignPub: "bob-owner",
	gatewaySignPub: "bob-gw-sign",
	gatewayBoxPub: "bob-gw-box",
	domainId: "bob",
	gatewayId: "bob-gw",
};
const REQ_SALT = "cmVxLXNhbHQ";

function commitWire(token: string): XDomainCommitWire {
	return { listeningToken: token, pin: "cGlu", requesterCommitment: crossDomainCommitment(REQUESTER, REQ_SALT) };
}

function revealWire(token: string): XDomainRevealWire {
	return { listeningToken: token, pin: "cGlu", requesterParty: REQUESTER, requesterSalt: REQ_SALT };
}

////////////////////////////////
//  Receiver leg: the pump dispatches commit / reveal to the coordinator

describe("createCrossDomainHandshakePump (receiver leg)", () => {
	it("a round-1 commit frame reaches handleIncomingCommit and the reply is shipped back", async () => {
		const recv = selfFor("sakura-gw", "alice");
		const coord = new CrossDomainHandshakeCoordinator({ self: recv, peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;

		const commitReplies: CrossDomainHandshakeReplyParams[] = [];
		const handleIncomingCommit = vi.fn((req: XDomainCommitWire) => coord.handleIncomingCommit(req));
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit,
			handleIncomingReveal: vi.fn(),
			sendCommitReply: async (reply) => {
				commitReplies.push(reply);
				return {};
			},
			sendRevealReply: async () => ({}),
		});

		pump({
			type: "cross_domain_handshake",
			handshakeId: "h1",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "sakura-gw",
			payload: commitWire(token),
		});
		await flush();

		expect(handleIncomingCommit).toHaveBeenCalledOnce();
		expect(commitReplies).toHaveLength(1);
		expect(commitReplies[0]).toMatchObject({ handshakeId: "h1", ok: true });
		const result = commitReplies[0].result as XDomainCommitReplyWire;
		expect(result.receiverCommitment.length).toBeGreaterThan(0);
	});

	it("a round-2 reveal frame reaches handleIncomingReveal and the reply carries the SAS", async () => {
		const recv = selfFor("sakura-gw", "alice");
		const coord = new CrossDomainHandshakeCoordinator({ self: recv, peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;
		// Prime round 1 so the reveal has a matching commitment.
		coord.handleIncomingCommit(commitWire(token));

		const revealReplies: CrossDomainHandshakeRevealReplyParams[] = [];
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit: (req) => coord.handleIncomingCommit(req),
			handleIncomingReveal: (req) => coord.handleIncomingReveal(req),
			sendCommitReply: async () => ({}),
			sendRevealReply: async (reply) => {
				revealReplies.push(reply);
				return {};
			},
		});

		pump({
			type: "cross_domain_handshake_reveal",
			handshakeId: "h2",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "sakura-gw",
			payload: revealWire(token),
		});
		await flush();

		expect(revealReplies).toHaveLength(1);
		expect(revealReplies[0]).toMatchObject({ handshakeId: "h2", ok: true });
		const result = revealReplies[0].result as XDomainRevealReplyWire;
		const receiverParty: CrossDomainParty = {
			ownerSignPub: "owner-pub",
			gatewaySignPub: "sakura-gw-sign",
			gatewayBoxPub: "sakura-gw-box",
			domainId: "alice",
			gatewayId: "sakura-gw",
		};
		expect(result.sas).toBe(crossDomainSas(receiverParty, REQUESTER, "cGlu"));
	});

	it("a coordinator rejection (unknown token) becomes an error reply, correlated by handshakeId", async () => {
		const recv = selfFor("sakura-gw", "alice");
		const coord = new CrossDomainHandshakeCoordinator({ self: recv, peers: new CrossDomainPeers(tmp()) });
		const replies: CrossDomainHandshakeReplyParams[] = [];
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit: (req) => coord.handleIncomingCommit(req),
			handleIncomingReveal: (req) => coord.handleIncomingReveal(req),
			sendCommitReply: async (reply) => {
				replies.push(reply);
				return {};
			},
			sendRevealReply: async () => ({}),
		});

		// No listen() first: the token was never minted.
		pump({
			type: "cross_domain_handshake",
			handshakeId: "h3",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "sakura-gw",
			payload: commitWire("sakura-gw.never"),
		});
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].handshakeId).toBe("h3");
		expect(replies[0].ok).toBe(false);
		expect(replies[0].error).toBeTruthy();
	});

	it("a malformed inner commit payload is rejected with an error reply (boundary validation)", async () => {
		const replies: CrossDomainHandshakeReplyParams[] = [];
		const handleIncomingCommit = vi.fn();
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit,
			handleIncomingReveal: vi.fn(),
			sendCommitReply: async (reply) => {
				replies.push(reply);
				return {};
			},
			sendRevealReply: async () => ({}),
		});

		pump({
			type: "cross_domain_handshake",
			handshakeId: "h4",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "sakura-gw",
			payload: { listeningToken: "only-this" }, // missing pin + commitment
		});
		await flush();

		expect(handleIncomingCommit).not.toHaveBeenCalled();
		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({ handshakeId: "h4", ok: false });
		expect(replies[0].error).toBeTruthy();
	});

	it("a malformed reveal payload is rejected on the reveal reply channel", async () => {
		const revealReplies: CrossDomainHandshakeRevealReplyParams[] = [];
		const handleIncomingReveal = vi.fn();
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit: vi.fn(),
			handleIncomingReveal,
			sendCommitReply: async () => ({}),
			sendRevealReply: async (reply) => {
				revealReplies.push(reply);
				return {};
			},
		});

		pump({
			type: "cross_domain_handshake_reveal",
			handshakeId: "h5",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "sakura-gw",
			payload: { listeningToken: "t", pin: "p" }, // missing requesterParty + salt
		});
		await flush();

		expect(handleIncomingReveal).not.toHaveBeenCalled();
		expect(revealReplies).toHaveLength(1);
		expect(revealReplies[0]).toMatchObject({ handshakeId: "h5", ok: false });
		expect(revealReplies[0].error).toBeTruthy();
	});

	it("a malformed frame with no handshakeId is dropped without a reply", async () => {
		const replies: (CrossDomainHandshakeReplyParams | CrossDomainHandshakeRevealReplyParams)[] = [];
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit: vi.fn(),
			handleIncomingReveal: vi.fn(),
			sendCommitReply: async (reply) => {
				replies.push(reply);
				return {};
			},
			sendRevealReply: async (reply) => {
				replies.push(reply);
				return {};
			},
		});

		pump("garbage");
		pump(null);
		pump({ type: "cross_domain_handshake" }); // no handshakeId to correlate
		pump({ type: "cross_domain_handshake_reveal" }); // no handshakeId to correlate
		await flush();

		expect(replies).toHaveLength(0);
	});

	it("a sendReply failure is contained (no unhandled rejection)", async () => {
		const recv = selfFor("sakura-gw", "alice");
		const coord = new CrossDomainHandshakeCoordinator({ self: recv, peers: new CrossDomainPeers(tmp()) });
		const token = coord.listen().listeningToken;
		const pump = createCrossDomainHandshakePump({
			handleIncomingCommit: (req) => coord.handleIncomingCommit(req),
			handleIncomingReveal: (req) => coord.handleIncomingReveal(req),
			sendCommitReply: async () => {
				throw new Error("Router gone");
			},
			sendRevealReply: async () => ({}),
		});

		pump({
			type: "cross_domain_handshake",
			handshakeId: "h6",
			srcDomain: "bob",
			srcGateway: "bob-gw",
			dstGateway: "sakura-gw",
			payload: commitWire(token),
		});
		await flush();
		// Reaching here without an unhandled rejection is the assertion.
	});
});

////////////////////////////////
//  Requester seam: the wired Router seam (the index.ts shape, exercised in isolation)

describe("cross-Domain handshake requester seam (wired through a callTool-style Router)", () => {
	// A Router seam built exactly like index.ts: it serializes each round into a tool call,
	// unwraps the held reply, and parses the result.
	function wiredRoute(callTool: (action: string, params: Record<string, unknown>) => Promise<unknown>) {
		const drive = async (action: string, receiverGatewayId: string, payload: unknown): Promise<unknown> => {
			const res = (await callTool(action, {
				handshakeId: "fixed-id",
				srcDomain: "bob",
				srcGateway: "bob-gw",
				dstGateway: receiverGatewayId,
				payload,
			})) as { error?: string; result?: { ok?: boolean; error?: string; result?: unknown } };
			if (res.error) throw new Error(res.error);
			const r = res.result;
			if (!r?.ok) throw new Error(r?.error ?? "the friend's Gateway did not complete the handshake");
			return r.result;
		};
		return {
			sendCommit: async (gw: string, req: XDomainCommitWire) =>
				parseCommitReply(await drive("cross_domain_handshake", gw, req)),
			sendReveal: async (gw: string, req: XDomainRevealWire) =>
				parseRevealReply(await drive("cross_domain_handshake_reveal", gw, req)),
		};
	}

	it("the requester leg routes both rounds via the injected Router and cross-checks the SAS", async () => {
		const receiver = new CrossDomainHandshakeCoordinator({
			self: selfFor("sakura-gw", "alice"),
			peers: new CrossDomainPeers(tmp()),
		});
		const token = receiver.listen().listeningToken;

		const callTool = vi.fn(async (action: string, params: Record<string, unknown>) => {
			expect(params.dstGateway).toBe("sakura-gw"); // routed by the token prefix
			if (action === "cross_domain_handshake") {
				const result = receiver.handleIncomingCommit(params.payload as XDomainCommitWire);
				return { result: { ok: true, result } };
			}
			const result = receiver.handleIncomingReveal(params.payload as XDomainRevealWire);
			return { result: { ok: true, result } };
		});

		const requester = new CrossDomainHandshakeCoordinator({
			self: selfFor("bob-gw", "bob"),
			peers: new CrossDomainPeers(tmp()),
			route: wiredRoute(callTool),
		});

		const result = await requester.request({
			listeningToken: token,
			pin: "cGlu",
			requesterOwnerSignPub: "owner-pub",
			requesterDomainId: "bob",
			requesterGatewayId: "bob-gw",
		});

		// Two tool calls (commit + reveal), and the requester recomputed the SAS (no MITM).
		expect(callTool).toHaveBeenCalledTimes(2);
		expect(result.sas.length).toBeGreaterThan(0);
		expect(result.receiverGatewaySignPub).toBe("sakura-gw-sign");
	});

	it("a Router-level error (held call returned ok:false) surfaces to the requester leg", async () => {
		const callTool = vi.fn(async () => ({ result: { ok: false, error: "gateway offline" } }));
		const requester = new CrossDomainHandshakeCoordinator({
			self: selfFor("bob-gw", "bob"),
			peers: new CrossDomainPeers(tmp()),
			route: wiredRoute(callTool),
		});
		await expect(
			requester.request({
				listeningToken: "sakura-gw.tok",
				pin: "cGlu",
				requesterOwnerSignPub: "owner-pub",
				requesterDomainId: "bob",
				requesterGatewayId: "bob-gw",
			}),
		).rejects.toThrow();
	});

	it("a tool-call transport error surfaces to the requester leg", async () => {
		const callTool = vi.fn(async () => ({ error: "Not connected to evie-bot" }));
		const requester = new CrossDomainHandshakeCoordinator({
			self: selfFor("bob-gw", "bob"),
			peers: new CrossDomainPeers(tmp()),
			route: wiredRoute(callTool),
		});
		await expect(
			requester.request({
				listeningToken: "sakura-gw.tok",
				pin: "cGlu",
				requesterOwnerSignPub: "owner-pub",
				requesterDomainId: "bob",
				requesterGatewayId: "bob-gw",
			}),
		).rejects.toThrow();
	});
});

////////////////////////////////
//  parse*Reply boundaries

describe("parseCommitReply / parseRevealReply", () => {
	it("parseCommitReply accepts a well-formed commit reply", () => {
		const reply: XDomainCommitReplyWire = { receiverCommitment: "Y29tbWl0" };
		expect(parseCommitReply(reply)).toEqual(reply);
	});

	it("parseCommitReply rejects a malformed reply", () => {
		expect(() => parseCommitReply({})).toThrow();
	});

	it("parseRevealReply accepts a well-formed reveal reply", () => {
		const reply: XDomainRevealReplyWire = {
			receiverParty: {
				ownerSignPub: "o",
				gatewaySignPub: "s",
				gatewayBoxPub: "b",
				domainId: "alice",
				gatewayId: "sakura-gw",
			},
			receiverSalt: "c2FsdA",
			sas: "847291",
		};
		expect(parseRevealReply(reply)).toEqual(reply);
	});

	it("parseRevealReply rejects a malformed reply (missing party)", () => {
		expect(() => parseRevealReply({ sas: "847291", receiverSalt: "s" })).toThrow();
	});
});
