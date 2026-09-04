import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailboxEntrySchema } from "../shared/schemasConsoleOp.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import { loadIdentitySet } from "../testing/identitySet.js";

describe("TS wire fixtures", () => {
	const root = path.resolve(import.meta.dirname, "../../tests/fixtures/wire/ts");
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "_manifest.json"), "utf8")) as {
		fixtures: Array<{ file: string; peer: string }>;
	};
	const set = loadIdentitySet();
	let h: FederationHarness;

	beforeAll(async () => {
		h = await startFederationHarness({ now: () => set.issuedAt });
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	interface Fixture {
		frame: { name: string; params: Record<string, unknown> };
		expect: Record<string, unknown>;
		phone?: { open: unknown };
	}
	const load = (file: string): Fixture => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
	const isRegister = (file: string) => load(file).frame.name === "gateway_register";

	// Registration mints a new incarnation.
	const frames = manifest.fixtures.filter((entry) => !isRegister(entry.file));
	const registrations = manifest.fixtures.filter((entry) => isRegister(entry.file));

	for (const entry of frames) {
		it(entry.file, async () => {
			const fixture = load(entry.file);
			const client = h.gateway.federation()!.routerClient;
			const incarnation = fixture.frame.params.incarnation;
			if (incarnation !== undefined && incarnation !== client.incarnation())
				throw new Error(
					`fixture incarnation ${String(incarnation)} differs from live ${String(client.incarnation())}`,
				);
			// The transport stamps the incarnation.
			const answer = await client.callInboxTool(fixture.frame.name, fixture.frame.params);
			expect(answer.result ?? answer).toMatchObject(fixture.expect);
			if (fixture.frame.name === "inbox_append" && fixture.phone) {
				const opId = (fixture.frame.params.row as { envelope: { opKey: { opId: string } } }).envelope.opKey
					.opId;
				const row = (await h.phone.inboxRead()).find((item) => item.envelope.opKey.opId === opId);
				expect(row).toBeDefined();
				MailboxEntrySchema.parse(h.phone.open(row!));
			}
		});
	}

	for (const entry of registrations) {
		it(`${entry.file} registers once and refuses its own replay`, async () => {
			const fixture = load(entry.file);
			const client = h.gateway.federation()!.routerClient;
			const first = await client.callTool(fixture.frame.name, fixture.frame.params);
			expect(first.result ?? first).toMatchObject(fixture.expect);
			const replay = await client.callTool(fixture.frame.name, fixture.frame.params);
			expect(replay.result ?? replay).toMatchObject({ ok: false });
		});
	}
});
