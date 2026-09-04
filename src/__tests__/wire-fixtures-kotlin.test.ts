import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { unwrapContentKey } from "../shared/content-envelope.js";
import type { KeyEnvelope } from "../shared/schemasContentKey.js";
import { type OwnerOp, OwnerOpSchema } from "../shared/schemasInbox.js";
import { type WireFixture, WireFixtureSchema, WireManifestSchema } from "../shared/schemasWireFixture.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import { contentKeyOf, loadIdentitySet } from "../testing/identitySet.js";
import { createPhoneDriver } from "../testing/phoneDriver.js";

const root = path.resolve(import.meta.dirname, "../../tests/fixtures/wire/kotlin");
const manifest = WireManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "_manifest.json"), "utf8")));
const load = (file: string): Extract<WireFixture, { producer: "kotlin" }> => {
	const fixture = WireFixtureSchema.parse(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
	if (fixture.producer !== "kotlin") throw new Error(`fixture ${file} is not Kotlin-produced`);
	return fixture;
};
const set = loadIdentitySet();

describe("Kotlin wire fixtures replayed through the Router", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness({ now: () => set.issuedAt });
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	for (const entry of manifest.fixtures.filter((candidate) => candidate.peer === "router.handle")) {
		it(entry.file, async () => {
			const fixture = load(entry.file);
			const response = await h.router.server.handle(
				new Request(`https://router.test${fixture.request.path}`, {
					method: fixture.request.method,
					headers: fixture.request.headers,
					...(fixture.request.method === "GET" ? {} : { body: fixture.request.body }),
				}),
			);
			const text = await response.text();
			expect(response.status, text).toBe(200);
			expect(JSON.parse(text)).toMatchObject(fixture.expect);
		});
	}

	for (const entry of manifest.fixtures.filter((candidate) => candidate.peer === "router.upgrade")) {
		it(`${entry.file} upgrades against the Router's real listener`, async () => {
			const { request } = load(entry.file);
			expect(request.method).toBe("GET");
			const socket = new WebSocket(`wss://127.0.0.1:${h.router.port}${request.path}`, {
				headers: request.headers,
				rejectUnauthorized: false,
			});
			await new Promise<void>((resolve, reject) => {
				socket.once("open", () => resolve());
				socket.once("error", reject);
				socket.once("unexpected-response", (_req, res) =>
					reject(new Error(`upgrade refused: ${res.statusCode}`)),
				);
			});
			socket.close();
		});
	}
});

describe("the TS phone driver reproduces every Kotlin-signed owner op", () => {
	const signed = manifest.fixtures
		.map((entry) => ({ entry, fixture: load(entry.file) }))
		.filter(({ fixture }) => fixture.inputs.op && fixture.inputs.opId && fixture.inputs.nonce);

	for (const { entry, fixture } of signed) {
		it(entry.file, () => {
			const posted = JSON.parse(fixture.request.body) as { ownerOp: OwnerOp };
			const driver = createPhoneDriver({
				set,
				handle: async () => new Response(""),
				now: () => fixture.clock,
				randomBytes: () => Buffer.from(fixture.inputs.nonce as string, "base64"),
				newOpId: () => fixture.inputs.opId as string,
			});
			const ours = driver.ownerOp(fixture.inputs.op as Record<string, unknown>, fixture.inputs.opId as string);
			expect(OwnerOpSchema.parse(ours)).toEqual(OwnerOpSchema.parse(posted.ownerOp));
		});
	}
});

describe("the gateway opens the Kotlin key grant", () => {
	it("KeyDeliveryOps.onKeyRequest/key_grant.json", () => {
		const fixture = load("KeyDeliveryOps.onKeyRequest/key_grant.json");
		const { grant } = fixture.inputs.op as { grant: { envelope: KeyEnvelope } };
		const opened = unwrapContentKey(grant.envelope, set.gateway.identity.box.priv);
		expect(opened.epoch).toBe(set.content.epoch);
		expect(opened.key.equals(contentKeyOf(set))).toBe(true);
	});
});
