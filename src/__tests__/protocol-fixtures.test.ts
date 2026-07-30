import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { SPOKEN_TIER_FIELDS } from "../shared/notice.js";
import {
	ConsoleCloseSessionResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleListDirsResultSchema,
	ConsoleListTeamsResultSchema,
	ConsoleOpEnvelopeSchema,
	ConsolePeekResultSchema,
	ConsolePollResultSchema,
	ConsoleRegisterResultSchema,
	ConsoleRelayFrameSchema,
	ConsoleRelayReplySchema,
	ConsoleReplyBodySchema,
	ConsoleRespondResultSchema,
	ConsoleSendResultSchema,
	MailboxEntrySchema,
} from "../shared/schemas.js";

////////////////////////////////
//  Golden protocol fixtures
//
//  _manifest.json is the single fixture inventory; this suite AND the Android
//  unit tests (ProtocolFixturesTest.kt) iterate it, so a fixture cannot be
//  covered by one runtime and forgotten by the other. This suite additionally
//  asserts the directory and the manifest agree, so an unlisted fixture file
//  cannot exist. Targeted semantics (Long bait, tolerance stripping) keep their
//  own focused tests below the loop.

const FIXTURES = path.join(__dirname, "../../tests/fixtures/protocol");

const SCHEMAS: Record<string, z.ZodType> = {
	ConsoleOpEnvelope: ConsoleOpEnvelopeSchema,
	ConsoleRelayFrame: ConsoleRelayFrameSchema,
	ConsoleRelayReply: ConsoleRelayReplySchema,
	ConsoleReplyBody: ConsoleReplyBodySchema,
	MailboxEntry: MailboxEntrySchema,
	ConsoleRegisterResult: ConsoleRegisterResultSchema,
	ConsoleListTeamsResult: ConsoleListTeamsResultSchema,
	ConsoleSendResult: ConsoleSendResultSchema,
	ConsoleRespondResult: ConsoleRespondResultSchema,
	ConsolePollResult: ConsolePollResultSchema,
	ConsoleCreateSessionResult: ConsoleCreateSessionResultSchema,
	ConsoleCloseSessionResult: ConsoleCloseSessionResultSchema,
	ConsolePeekResult: ConsolePeekResultSchema,
	ConsoleListDirsResult: ConsoleListDirsResultSchema,
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

	it("keeps an attachment's modifiedAt above 2^31 (Long bait for the Kotlin side)", () => {
		// An epoch-ms stamp overflows Int, so a fixture below 2^31 would pass on both runtimes while
		// a real one silently truncated. The absent case is covered by mailbox-reply-files.json.
		const entry = MailboxEntrySchema.parse(fixture("mailbox-reply-files-modified.json"));
		expect(entry.files?.[0].modifiedAt).toBeGreaterThan(2 ** 31);
		expect(MailboxEntrySchema.parse(fixture("mailbox-reply-files.json")).files?.[0].modifiedAt).toBeUndefined();
	});

	it("a reply entry carries all three spoken tiers beside its body", () => {
		const entry = MailboxEntrySchema.parse(fixture("mailbox-reply.json"));
		expect(entry.title).toBe("Reply headline");
		expect(entry.summary).toBe("One short spoken summary of the reply.");
		expect(entry.fullSpoken).toBe("Done, spoken in the body's place.");
	});

	it("MailboxEntrySchema declares every spoken-tier field", () => {
		// The other tier-carrying wire schemas spread NoticeTierWireFields, so they cannot drift;
		// this one keeps flat literal fields (its field order feeds the Kotlin codegen, and a
		// spread would reorder the generated constructor), so the trio is pinned here instead.
		for (const tier of SPOKEN_TIER_FIELDS) {
			expect(Object.keys(MailboxEntrySchema.shape), `MailboxEntrySchema lacks the ${tier} tier`).toContain(tier);
		}
	});

	it("every spoken-tier field is exercised by at least one mailbox fixture (both runtimes decode them)", () => {
		// A future tier added to the wire trio fails here until a fixture carries it, so an
		// additive tier field can never ship with an unpinned Kotlin decode (the class that
		// broke main twice during the Gateway rename).
		const mailboxFixtures = manifest
			.filter((entry) => entry.schema === "MailboxEntry" && entry.expect === "pass")
			.map((entry) => MailboxEntrySchema.parse(fixture(entry.file)));
		for (const tier of SPOKEN_TIER_FIELDS) {
			expect(
				mailboxFixtures.some((entry) => typeof entry[tier] === "string"),
				`no mailbox fixture carries the ${tier} tier`,
			).toBe(true);
		}
	});

	it("a peer mirror entry carries kind, to, and a dedupeKey distinct from from", () => {
		const entry = MailboxEntrySchema.parse(fixture("mailbox-peer.json"));
		expect(entry.kind).toBe("peer");
		expect(entry.from).toBe("alice.sakura.coolapp.main");
		expect(entry.to).toBe("alice.sakura.coolib.main");
		expect(entry.dedupeKey).toBe("peer:alice.sakura.coolapp.main:9f2a1c");
	});

	it("tolerates unknown extra fields and strips them (additive rule)", () => {
		const result = MailboxEntrySchema.safeParse(fixture("tolerance-extra-field.json"));
		expect(result.success).toBe(true);
		expect(result.data).not.toHaveProperty("field_from_the_future");
	});

	it("a loose team carries required gatewayId+kind but omits the optional domainId", () => {
		const result = ConsoleListTeamsResultSchema.parse(fixture("list-teams-result.json"));
		expect(result.teams).toHaveLength(2);
		expect(result.teams[0].kind).toBe("devcontainer");
		expect(result.teams[0].domainId).toBe("alice");
		expect(result.teams[1].gatewayId).toBe("laptop");
		expect(result.teams[1].kind).toBe("loose");
		// domainId is absent for a session whose gateway has not resolved a Domain (arming);
		// consumers fall back to the local Domain.
		expect(result.teams[1].domainId).toBeUndefined();
	});

	it("a v2 list carries the verifying and online statuses with per-session sessionLabels", () => {
		const result = ConsoleListTeamsResultSchema.parse(fixture("list-teams-result-v2.json"));
		expect(result.teams[0].status).toBe("verifying");
		expect(result.teams[0].sessionLabel).toBe("recipe-app");
		expect(result.teams[1].status).toBe("online");
		expect(result.teams[1].sessionLabel).toBe("My Work");
	});

	it("a create_session op envelope carries the displayLabel form", () => {
		const env = ConsoleOpEnvelopeSchema.parse(fixture("op-envelope-create-session-v2.json"));
		expect(env.op.kind).toBe("create_session");
		if (env.op.kind === "create_session") expect(env.op.displayLabel).toBe("My Work");
	});

	it("a rename_session op envelope carries the target and sessionLabel", () => {
		const env = ConsoleOpEnvelopeSchema.parse(fixture("op-envelope-rename-session.json"));
		expect(env.op.kind).toBe("rename_session");
		if (env.op.kind === "rename_session") expect(env.op.sessionLabel).toBe("Renamed Work");
	});

	it("a create_session result carries the pending status once the launch outran the bound", () => {
		const result = ConsoleCreateSessionResultSchema.parse(fixture("create-session-result-pending.json"));
		expect(result).toEqual({ created: true, id: "a1b2c3", sessionLabel: "My Work", status: "pending" });
	});

	it("a close_session op envelope carries the target", () => {
		const env = ConsoleOpEnvelopeSchema.parse(fixture("op-envelope-close-session.json"));
		expect(env.op.kind).toBe("close_session");
		if (env.op.kind === "close_session") expect(env.op.target).toBe("recipe-app.scratch");
	});

	it("a peek result carries a container-logs frame as text + kind (no ansi)", () => {
		const result = ConsolePeekResultSchema.parse(fixture("peek-result-container-logs.json"));
		expect(result.kind).toBe("container-logs");
		expect(result.text).toContain("postCreate");
		expect(result.ansi).toBeUndefined();
	});

	it("a legacy bare {ansi, hash} peek reply still decodes (old gateway, new schema)", () => {
		const result = ConsolePeekResultSchema.parse(fixture("peek-result-legacy.json"));
		expect(result.ansi).toBeDefined();
		expect(result.text).toBeUndefined();
		expect(result.kind).toBeUndefined();
	});
});
