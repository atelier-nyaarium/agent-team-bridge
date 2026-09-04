import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type ContentAad, openContent, unwrapContentKey } from "../shared/content-envelope.js";
import { ContentEnvelopeSchema, KeyEnvelopeSchema } from "../shared/schemasContentKey.js";
import { type OwnerOp, OwnerOpSchema } from "../shared/schemasInbox.js";
import { type WireFixture, WireFixtureSchema, WireManifestSchema } from "../shared/schemasWireFixture.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import { FixtureWorld } from "../testing/fixtureWorld.js";
import { loadIdentitySet } from "../testing/identitySet.js";
import { createPhoneDriver } from "../testing/phoneDriver.js";

const root = path.resolve(import.meta.dirname, "../../tests/fixtures/wire/kotlin");
const manifest = WireManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "_manifest.json"), "utf8")));
const load = (file: string): Extract<WireFixture, { producer: "kotlin" }> => {
	const fixture = WireFixtureSchema.parse(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
	if (fixture.producer !== "kotlin") throw new Error(`fixture ${file} is not Kotlin-produced`);
	return fixture;
};
const set = loadIdentitySet();
const world = FixtureWorld.from(set);

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
				world,
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

describe("the gateway opens what the phone sealed", () => {
	const pathParts = (value: string): string[] => value.replace(/\[(\d+)\]/g, ".$1").split(".");
	const resolve = (value: unknown, pathValue: string): unknown => {
		let current = value;
		for (const part of pathParts(pathValue)) {
			if (current === null || typeof current !== "object") return undefined;
			current = (current as Record<string, unknown>)[part];
		}
		return current;
	};
	const isEnvelope = (value: unknown): boolean =>
		ContentEnvelopeSchema.safeParse(value).success || KeyEnvelopeSchema.safeParse(value).success;
	const sealedPaths = (value: unknown, prefix = ""): string[] => {
		if (isEnvelope(value)) return [prefix];
		if (!value || typeof value !== "object") return [];
		return Object.entries(value).flatMap(([key, child]) => sealedPaths(child, prefix ? `${prefix}.${key}` : key));
	};

	for (const entry of manifest.fixtures.filter((candidate) => candidate.peer === "router.handle")) {
		it(`${entry.file} opens declared sealed values`, () => {
			const fixture = load(entry.file);
			const declared = fixture.sealed ?? [];
			const declaredPaths = declared.map((sealed) => pathParts(sealed.path).join("."));
			for (const pathValue of sealedPaths(fixture.inputs.op)) {
				expect(declaredPaths.includes(pathValue), `${entry.file}:${pathValue}`).toBe(true);
			}
			for (const sealed of declared) {
				const envelope = resolve(fixture.inputs.op, sealed.path);
				if (sealed.aadKind === "key") {
					const opened = unwrapContentKey(KeyEnvelopeSchema.parse(envelope), set.gateway.identity.box.priv);
					expect(opened.key.equals(world.contentKey)).toBe(true);
					continue;
				}
				const parsed = ContentEnvelopeSchema.parse(envelope);
				const aad: ContentAad = {
					domainId: world.phone.domainId,
					ownerSignPub: world.phone.ownerSignPub,
					epoch: parsed.epoch,
					kind: sealed.aadKind as ContentAad["kind"],
				};
				const plaintext = openContent(parsed, world.contentKey, aad).toString("utf8");
				if (sealed.plaintextOf) expect(plaintext).toBe(resolve(fixture.inputs, sealed.plaintextOf));
				if (sealed.expectJson) expect(JSON.parse(plaintext)).toMatchObject(sealed.expectJson);
			}
		});
	}
});
