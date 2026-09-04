import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	ConsoleCloseSessionResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleForgetResultSchema,
	ConsoleListDirsResultSchema,
	ConsoleOpSchema,
	ConsolePeekResultSchema,
	ConsoleSendResultSchema,
	InboxRowSchema,
	OwnerOpSchema,
	PlanesReadResultSchema,
	PlanesReadValueSchema,
} from "../shared/schemas.js";
import { MailboxEntrySchema } from "../shared/schemasConsoleOp.js";

const FIXTURES = path.join(__dirname, "../../tests/fixtures/protocol");

const SCHEMAS: Record<string, z.ZodType> = {
	ConsoleOp: ConsoleOpSchema,
	MailboxEntry: MailboxEntrySchema,
	OwnerOp: OwnerOpSchema,
	InboxRow: InboxRowSchema,
	PlanesReadValue: PlanesReadValueSchema,
	PlanesReadResult: PlanesReadResultSchema,
	ConsoleSendResult: ConsoleSendResultSchema,
	ConsoleCreateSessionResult: ConsoleCreateSessionResultSchema,
	ConsoleCloseSessionResult: ConsoleCloseSessionResultSchema,
	ConsoleForgetResult: ConsoleForgetResultSchema,
	ConsoleListDirsResult: ConsoleListDirsResultSchema,
	ConsolePeekResult: ConsolePeekResultSchema,
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
		expect(manifest.map((entry) => entry.file).sort()).toEqual(onDisk);
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

	it("preserves large integer fields", () => {
		expect(OwnerOpSchema.parse(fixture("owner-op.json")).at).toBeGreaterThan(2 ** 31);
		expect(PlanesReadValueSchema.parse(fixture("planes-read-value.json")).known.presence).toBe(4294967296);
	});

	it("accepts additive fields without exposing them", () => {
		const op = { ...(fixture("console-op-create-session.json") as object), futureField: true };
		const result = ConsoleOpSchema.parse(op);
		expect(result).not.toHaveProperty("futureField");
	});

	it("keeps the retained result shapes covered", () => {
		expect(ConsoleSendResultSchema.parse(fixture("send-result.json")).status).toBe("delivered");
		expect(ConsoleCreateSessionResultSchema.parse(fixture("create-session-result-pending.json")).status).toBe(
			"pending",
		);
		expect(ConsoleCloseSessionResultSchema.parse(fixture("close-session-result.json"))).toBeDefined();
		expect(ConsoleForgetResultSchema.parse(fixture("forget-result-release.json")).boardDisposition).toBe("release");
		expect(ConsoleListDirsResultSchema.parse(fixture("list-dirs-result.json"))).toBeDefined();
		expect(ConsolePeekResultSchema.parse(fixture("peek-result-legacy.json")).ansi).toBeDefined();
		expect(InboxRowSchema.parse(fixture("inbox-row.json")).seq).toBe(1);
	});
});
