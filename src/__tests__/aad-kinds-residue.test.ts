import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const tsBuilderPath = path.join(root, "src/shared/content-envelope.ts");
const tsTestPath = path.join(root, "src/__tests__/content-envelope.test.ts");
const kotlinTestPath = path.join(
	root,
	"android/app/src/test/java/com/atelier_nyaarium/switchboard/crypto/ContentEnvelopeVectorsTest.kt",
);
const vectorPath = path.join(root, "tests/fixtures/content-envelope/vectors.json");
const kotlinBuilderPath = path.join(
	root,
	"android/app/src/main/java/com/atelier_nyaarium/switchboard/crypto/ContentAadKinds.kt",
);

const read = (file: string) => fs.readFileSync(file, "utf8");
const names = (source: string) => [...source.matchAll(/export function (\w+AadKind)\s*\(/g)].map((match) => match[1]);
const filesUnder = (directory: string) =>
	fs
		.readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));

describe("AAD kind residue", () => {
	it("keeps one named vector and one Kotlin twin for every builder", () => {
		const builders = names(read(tsBuilderPath));
		const vectors = JSON.parse(read(vectorPath)) as Record<string, unknown>;
		const vectorByBuilder: Record<string, string> = {
			boardTextAadKind: "boardTitleAad",
			inboxBodyAadKind: "ownerRowAad",
			scheduledBodyAadKind: "scheduledBodyAad",
			opPayloadAadKind: "opPayloadAad",
			valueResultAadKind: "valueResultAad",
			opResultAadKind: "opResultAad",
			vaultAadKind: "vaultValueAad",
		};
		for (const builder of builders) expect(vectors[vectorByBuilder[builder]]).toBeDefined();
		for (const vector of [
			"boardTitleAad",
			"boardBodyAad",
			"boardNameAad",
			"ownerRowAad",
			"scheduledBodyAad",
			"opPayloadAad",
			"valueResultAad",
			"opResultAad",
			"vaultPublicTitleAad",
			"vaultPublicDescriptionAad",
			"vaultPrivateTitleAad",
			"vaultPrivateDescriptionAad",
			"vaultValueAad",
			"vaultGatewaysAad",
			"vaultTypedAad",
		]) {
			expect(read(tsTestPath)).toContain(vector);
			expect(read(kotlinTestPath)).toContain(vector);
		}

		const kotlinDeclarations = filesUnder(path.join(root, "android/app/src/main"))
			.filter((file) => file.endsWith(".kt"))
			.flatMap((file) =>
				[...read(file).matchAll(/fun\s+(\w+AadKind)\s*\(/g)].map((match) => ({ file, name: match[1] })),
			);
		for (const declaration of kotlinDeclarations) expect(declaration.file).toBe(kotlinBuilderPath);
		for (const builder of builders) expect(read(kotlinBuilderPath)).toMatch(new RegExp(`fun ${builder}\\s*\\(`));
	});

	it("leaves no AAD literals in callers", () => {
		const forbidden = [
			["op", "payload"],
			["op", "result"],
			["inbox", "body"],
			["board", "title"],
			["board", "body"],
			["board", "name"],
			["vault", "publicTitle"],
			["vault", "publicDescription"],
			["vault", "privateTitle"],
			["vault", "privateDescription"],
			["vault", "value"],
			["vault", "gateways"],
			["vault", "typed"],
		].map((parts) => parts.join("."));
		const files = filesUnder(path.join(root, "src"))
			.filter((file) => file.endsWith(".ts"))
			.filter(
				(file) =>
					file !== tsBuilderPath &&
					file !== path.join(root, "src/shared/schemasContentKey.ts") &&
					file !== path.join(root, "src/__tests__/aad-kinds-residue.test.ts"),
			);
		const sources = files.map((file) => [file, read(file)] as const);
		for (const literal of forbidden)
			for (const [file, source] of sources) expect(source, file).not.toContain(literal);
		for (const literal of forbidden)
			for (const file of filesUnder(path.join(root, "android/app/src/main")).filter(
				(file) => file.endsWith(".kt") && file !== kotlinBuilderPath,
			)) {
				expect(read(file), file).not.toContain(literal);
			}
	});
});
