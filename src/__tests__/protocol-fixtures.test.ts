import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	MailboxEntrySchema,
	PhoneListTeamsResultSchema,
	PhonePollResultSchema,
	PhoneRegisterResultSchema,
	PhoneRelayFrameSchema,
	PhoneRelayReplySchema,
	PhoneRespondResultSchema,
	PhoneSendResultSchema,
} from "../shared/schemas.js";

////////////////////////////////
//  Golden protocol fixtures
//
//  _manifest.json is the single fixture inventory; this suite AND the Android
//  unit tests (ProtocolFixturesTest.kt) iterate it, so a fixture cannot be
//  covered by one runtime and forgotten by the other. This suite additionally
//  asserts the directory and the manifest agree, so an unlisted fixture file
//  cannot exist. Targeted semantics (Long bait, tolerance stripping, the
//  out-of-union request_type) keep their own focused tests below the loop.

const FIXTURES = path.join(__dirname, "../../tests/fixtures/protocol");

const SCHEMAS: Record<string, z.ZodType> = {
	PhoneRelayFrame: PhoneRelayFrameSchema,
	PhoneRelayReply: PhoneRelayReplySchema,
	MailboxEntry: MailboxEntrySchema,
	PhoneRegisterResult: PhoneRegisterResultSchema,
	PhoneListTeamsResult: PhoneListTeamsResultSchema,
	PhoneSendResult: PhoneSendResultSchema,
	PhoneRespondResult: PhoneRespondResultSchema,
	PhonePollResult: PhonePollResultSchema,
};

interface ManifestEntry {
	file: string;
	schema: string;
	expect: "pass" | "fail";
}

function fixture(name: string): unknown {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

const manifest = (fixture("_manifest.json") as { fixtures: ManifestEntry[] }).fixtures;

describe("protocol fixtures", () => {
	it("manifest covers exactly the fixture files on disk", () => {
		const onDisk = fs
			.readdirSync(FIXTURES)
			.filter((name) => name.endsWith(".json") && name !== "_manifest.json")
			.sort();
		const listed = manifest.map((entry) => entry.file).sort();
		expect(listed).toEqual(onDisk);
	});

	it("manifest schemas all resolve", () => {
		for (const entry of manifest) {
			expect(SCHEMAS[entry.schema], `unknown schema ${entry.schema} for ${entry.file}`).toBeDefined();
		}
	});

	it.each(manifest.map((entry) => [entry.file, entry] as const))("%s matches its manifest entry", (_, entry) => {
		const result = SCHEMAS[entry.schema].safeParse(fixture(entry.file));
		expect(result.success).toBe(entry.expect === "pass");
	});

	it("keeps the at field above 2^31 (Long bait for the Kotlin side)", () => {
		const entry = MailboxEntrySchema.parse(fixture("mailbox-message.json"));
		expect(entry.at).toBeGreaterThan(2 ** 31);
	});

	it("tolerates unknown extra fields and strips them (additive rule)", () => {
		const result = MailboxEntrySchema.safeParse(fixture("tolerance-extra-field.json"));
		expect(result.success).toBe(true);
		expect(result.data).not.toHaveProperty("field_from_the_future");
	});

	it("carries the live out-of-union request_type", () => {
		const entry = MailboxEntrySchema.parse(fixture("mailbox-handoff.json"));
		expect(entry.request_type).toBe("handoff");
	});

	it("tolerates an old-arbiter team without kind", () => {
		const result = PhoneListTeamsResultSchema.parse(fixture("list-teams-result.json"));
		expect(result.teams).toHaveLength(2);
		expect(result.teams[0].kind).toBe("devcontainer");
		expect(result.teams[1].kind).toBeUndefined();
	});
});
