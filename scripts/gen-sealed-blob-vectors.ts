import fs from "node:fs";
import path from "node:path";
import { contentAad } from "../src/shared/content-envelope.js";
import { blobChunkAad, sealBlobChunk, sealedBlobSize } from "../src/shared/sealed-blob.js";

/**
 * Writes the cross-runtime vectors for sealed blob framing.
 *
 * The AAD is the whole point: a single character of difference between the two runtimes means
 * nothing the Router holds can be opened, and no unit test inside one runtime can catch it, because
 * both sides of such a test share the same mistake.
 */
const key = Buffer.alloc(32, 7);
const context = { domainId: "domain-a", ownerSignPub: "owner-pub", epoch: 3, blobId: `sha256-${"a".repeat(64)}` };

const cases = [0, 1, 100].map((size) => {
	const plaintext = Buffer.alloc(size, 65);
	const chunks = Math.max(1, Math.ceil(size / 1_048_576));
	const frames: string[] = [];
	for (let index = 0; index < chunks; index++) {
		const slice = plaintext.subarray(index * 1_048_576, (index + 1) * 1_048_576);
		// A fixed nonce per index keeps the vector reproducible; production mints a fresh one.
		const nonce = Buffer.alloc(12, index + 1);
		frames.push(sealBlobChunk(slice, key, context, index, index + 1 === chunks, nonce).toString("base64"));
	}
	return { size, ciphertextSize: sealedBlobSize(size), frames };
});

const vectors = {
	_comment:
		"Cross-runtime vectors for sealed blob framing. Read by BOTH src/__tests__/sealed-blob.test.ts and android/.../SealedBlobTest.kt, so the hand-authored Kotlin twin cannot drift from src/shared/sealed-blob.ts. The AAD binds the blob id, the chunk index and the final flag; a single character of difference means nothing decrypts, and a test inside one runtime cannot catch that because both its halves would share the mistake.",
	key: key.toString("base64"),
	context,
	aadSample: contentAad(blobChunkAad(context, 0, true)).toString("base64"),
	cases,
};

const out = path.join(import.meta.dirname, "..", "tests", "fixtures", "sealed-blob");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "vectors.json"), `${JSON.stringify(vectors, null, "\t")}\n`);
// Biome formats the corpus like any other file, so a regenerate that skips this fails `lint`.
console.log(`wrote ${path.join(out, "vectors.json")} (${cases.length} cases). Run: bunx biome check --write on it.`);
