import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveContentKey, wrapContentKey } from "../shared/content-envelope.js";
import { type Identity, seal } from "../shared/crypto.js";
import type { KeyRequest } from "../shared/schemasContentKey.js";
import { attachFakeSession } from "../testing/fakeSession.js";
import {
	type FederationHarness,
	type RouterOnlyHarness,
	startFederationHarness,
	startRouterOnly,
} from "../testing/federationHarness.js";

describe("federation harness cold start", () => {
	let h: RouterOnlyHarness;

	beforeEach(async () => {
		h = await startRouterOnly();
	}, 30_000);

	afterEach(async () => {
		if (h) await h.close();
	});

	it("answers reach before roster, then accepts the first signed gateway operation", async () => {
		const before = await h.phone.reach();
		expect(before.domainId).toBe(h.set.domain.id);
		expect(before.gateways).toEqual([]);

		const gateway = h.composeGateway();
		await h.waitFor(() => gateway.federation()?.routerClient.isRegistered() || undefined, "gateway registration");
		const after = await h.phone.reach();
		expect(after.gateways).toHaveLength(1);
		expect(after.gateways[0]?.gatewayId).toBe(h.set.gateway.id);
		const answer = await h.phone.send({ kind: "consumer_register", incarnation: 0 });
		expect(answer).toMatchObject({ cursor: expect.any(Number) });
		await gateway.close();
	});

	it("installs a bounded bootstrap and requests the missing earlier epoch", async () => {
		const nonce = "arming-nonce";
		// Admission precedes the bundle.
		const federationDir = path.join(h.root, "gateway", "federation");
		fs.mkdirSync(federationDir, { recursive: true });
		fs.writeFileSync(path.join(federationDir, "federation-identity.json"), JSON.stringify(h.set.gateway.identity));
		const gateway = h.composeGateway({ arming: true, enrollNonce: nonce });
		const gatewayIdentity: Identity = h.set.gateway.identity;
		const gatewayAdmission = h.set.gateway.admission;
		const contentKeys = [2, 3, 4].map((epoch) =>
			wrapContentKey(
				deriveContentKey(h.set.domain.owner.sign.priv, h.set.domain.id, epoch),
				epoch,
				gatewayIdentity.box.pub,
				h.set.console.identity.sign.pub,
				h.set.console.identity.sign.priv,
			),
		);
		const bundle = {
			nonce,
			transport: {
				routerUrl: `https://127.0.0.1:${h.router.port}`,
				routerCertFp: h.router.certFp,
				bearer: h.set.tokens.federation,
			},
			admission: gatewayAdmission,
			domain: {
				ownerSignPub: h.set.domain.owner.sign.pub,
				admissions: [gatewayAdmission, h.set.console.admission],
				revocations: [],
			},
			domainId: h.set.domain.id,
			contentKeys,
		};
		const frame = {
			v: 1,
			signerSignPub: h.set.console.identity.sign.pub,
			sealed: seal(
				Buffer.from(JSON.stringify(bundle)),
				gatewayIdentity.box.pub,
				h.set.console.identity.sign.priv,
			),
		};
		const response = await gateway.router(
			new Request("http://gateway.test/enroll", {
				method: "POST",
				body: JSON.stringify(frame),
				headers: { "content-type": "application/json" },
			}),
		);
		expect(response.status).toBe(200);
		expect(gateway.contentKeyStore.epochs()).toEqual([2, 3, 4]);
		await h.waitFor(() => gateway.federation()?.routerClient.isRegistered() || undefined, "gateway registration");
		const request = await h.waitFor(async () => {
			const rows = await h.phone.inboxRead();
			const row = rows.find((candidate) => candidate.envelope.kind === "key_request");
			return row ? (h.phone.open(row) as KeyRequest) : undefined;
		}, "missing epoch request");
		expect(request.epochs).toEqual([1]);

		const grant = await h.phone.send({
			kind: "key_grant",
			grant: {
				v: 1,
				recipientSignPub: gatewayIdentity.sign.pub,
				envelope: wrapContentKey(
					deriveContentKey(h.set.domain.owner.sign.priv, h.set.domain.id, 1),
					1,
					gatewayIdentity.box.pub,
					h.set.console.identity.sign.pub,
					h.set.console.identity.sign.priv,
				),
				at: h.now(),
			},
		});
		expect(grant).toMatchObject({ outcome: "accepted" });
		await h.waitFor(() => gateway.contentKeyStore.epochs().includes(1) || undefined, "installed epoch 1");
		expect(gateway.contentKeyStore.epochs()).toEqual([1, 2, 3, 4]);
		await gateway.close();
	});
});

describe("federation harness routing and restart", () => {
	let h: FederationHarness;

	beforeEach(async () => {
		h = await startFederationHarness();
	}, 30_000);

	afterEach(async () => {
		if (h) await h.close();
	});

	it("fences the old incarnation and re-sends the presence baseline after a Router restart", async () => {
		const session = attachFakeSession(h.gateway, {
			team: "fixture-app.restart",
			conversationId: "conv-restart",
		});
		await session.ready();
		const before = h.gateway.federation()?.routerClient.incarnation();
		if (before === null || before === undefined) throw new Error("gateway incarnation is unavailable");
		await h.restartRouter();
		const after = await h.waitFor(() => h.gateway.federation()?.routerClient.incarnation(), "new incarnation");
		expect(after).toBeGreaterThan(before);
		const reach = await h.waitFor(async () => {
			const answer = await h.phone.reach();
			return answer.gateways.length > 0 ? answer : undefined;
		}, "gateway re-registration");
		expect(reach.gateways.map((gateway) => gateway.gatewayId)).toEqual([h.set.gateway.id]);
		const presence = await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead();
			const plane = planes.find((candidate) => candidate.name === "presence");
			return plane && JSON.stringify(plane.payload).includes(session.team) ? plane : undefined;
		}, "session presence after Router restart");
		const rows = JSON.stringify(presence.payload).split(`"team":"${session.team}"`).length - 1;
		expect(rows).toBe(1);
		session.close();
	});
});
