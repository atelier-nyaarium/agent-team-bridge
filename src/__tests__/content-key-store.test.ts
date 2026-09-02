import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import { signAdmission } from "../shared/admission.js";
import { sealContent, wrapContentKey } from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "content-key-store-"));
}

describe("ContentKeyStore", () => {
	it("installs and opens a content envelope", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const console_ = generateIdentity();
		const gateway = generateIdentity();
		const admission = signAdmission(
			{
				kind: "console",
				signPub: console_.sign.pub,
				boxPub: console_.box.pub,
				issuedAt: 1,
				nonce: "admission",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		const key = Buffer.alloc(32, 7);
		const envelope = wrapContentKey(key, 1, gateway.box.pub, console_.sign.pub, console_.sign.priv);
		const store = new ContentKeyStore(dir, gateway.box.priv);
		const trust = { ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] };

		expect(store.install(envelope, trust)).toBe("installed");
		expect(store.epochs()).toEqual([1]);
		const content = sealContent(Buffer.from("secret"), key, {
			domainId: "domain",
			ownerSignPub: owner.sign.pub,
			epoch: 1,
			kind: "board.body",
		});
		expect(
			store.open(content, {
				domainId: "domain",
				ownerSignPub: owner.sign.pub,
				epoch: 1,
				kind: "board.body",
			}),
		).toEqual({ kind: "ok", plaintext: Buffer.from("secret") });
	});

	it("refuses a gateway signer", () => {
		const gateway = generateIdentity();
		const store = new ContentKeyStore(tempDir(), gateway.box.priv);
		const admission = signAdmission(
			{
				kind: "gateway",
				signPub: gateway.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId: "g",
				issuedAt: 1,
				nonce: "a",
			},
			gateway.sign.priv,
			gateway.sign.pub,
		);
		const envelope = wrapContentKey(Buffer.alloc(32), 1, gateway.box.pub, gateway.sign.pub, gateway.sign.priv);
		expect(
			store.install(envelope, {
				ownerSignPub: gateway.sign.pub,
				admissions: [admission],
				revocations: [],
			}),
		).toBe("refused");
	});

	it("refuses an envelope sealed to another recipient without creating a file", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const signer = generateIdentity();
		const gateway = generateIdentity();
		const other = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: signer.sign.pub, boxPub: signer.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const store = new ContentKeyStore(dir, gateway.box.priv);
		expect(
			store.install(wrapContentKey(Buffer.alloc(32), 1, other.box.pub, signer.sign.pub, signer.sign.priv), {
				ownerSignPub: owner.sign.pub,
				admissions: [admission],
				revocations: [],
			}),
		).toBe("refused");
		expect(fs.existsSync(path.join(dir, "content-keys.json"))).toBe(false);
	});

	it("reports an already held epoch without changing the keyring", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const signer = generateIdentity();
		const gateway = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: signer.sign.pub, boxPub: signer.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const trust = { ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] };
		const envelope = wrapContentKey(Buffer.alloc(32, 1), 1, gateway.box.pub, signer.sign.pub, signer.sign.priv);
		const store = new ContentKeyStore(dir, gateway.box.priv);
		expect(store.install(envelope, trust)).toBe("installed");
		expect(store.install(envelope, trust)).toBe("already_present");
		expect(store.epochs()).toEqual([1]);
	});

	it("refuses different bytes for a held epoch without changing the keyring", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const signer = generateIdentity();
		const gateway = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: signer.sign.pub, boxPub: signer.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const trust = { ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] };
		const store = new ContentKeyStore(dir, gateway.box.priv);
		expect(
			store.install(
				wrapContentKey(Buffer.alloc(32, 1), 1, gateway.box.pub, signer.sign.pub, signer.sign.priv),
				trust,
			),
		).toBe("installed");
		expect(
			store.install(
				wrapContentKey(Buffer.alloc(32, 2), 1, gateway.box.pub, signer.sign.pub, signer.sign.priv),
				trust,
			),
		).toBe("refused");
		expect(store.keyFor(1)).toEqual(Buffer.alloc(32, 1));
	});

	it("refuses a tampered, relabeled, or malformed key envelope without a file write", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const signer = generateIdentity();
		const gateway = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: signer.sign.pub, boxPub: signer.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const trust = { ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] };
		const store = new ContentKeyStore(dir, gateway.box.priv);
		const valid = wrapContentKey(Buffer.alloc(32, 1), 1, gateway.box.pub, signer.sign.pub, signer.sign.priv);
		const tampered = { ...valid, sealed: { ...valid.sealed, ciphertext: `${valid.sealed.ciphertext}A` } };
		const relabeled = { ...valid, epoch: 2 };
		for (const envelope of [tampered, relabeled, { epoch: 1 }])
			expect(store.install(envelope as typeof valid, trust)).toBe("refused");
		expect(fs.existsSync(path.join(dir, "content-keys.json"))).toBe(false);
	});

	it("reports missing epochs and tampered tags", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const gateway = generateIdentity();
		const store = new ContentKeyStore(dir, gateway.box.priv);
		const aad = { domainId: "domain", ownerSignPub: owner.sign.pub, epoch: 1, kind: "board.body" as const };
		expect(store.open({ v: 1, epoch: 4, nonce: "AA==", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" }, aad)).toEqual({
			kind: "bad_tag",
		});
		const key = Buffer.alloc(32, 4);
		const console_ = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		store.install(wrapContentKey(key, 1, gateway.box.pub, console_.sign.pub, console_.sign.priv), {
			ownerSignPub: owner.sign.pub,
			admissions: [admission],
			revocations: [],
		});
		const content = sealContent(Buffer.from("secret"), key, aad);
		content.ciphertext = `${content.ciphertext.slice(0, -4)}AAAA`;
		expect(store.open(content, aad)).toEqual({ kind: "bad_tag" });
	});

	it("persists the keyring with mode 0600 and emits no secrets", () => {
		const dir = tempDir();
		const owner = generateIdentity();
		const console_ = generateIdentity();
		const gateway = generateIdentity();
		const key = Buffer.alloc(32, 9);
		const plaintext = "canary plaintext";
		const admission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const trust = { ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] };
		const store = new ContentKeyStore(dir, gateway.box.priv);
		const keyB64 = key.toString("base64");
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
		vi.spyOn(console, "warn").mockImplementation((...args) => logs.push(args.join(" ")));
		store.install(wrapContentKey(key, 1, gateway.box.pub, console_.sign.pub, console_.sign.priv), trust);
		store.open(
			sealContent(Buffer.from(plaintext), key, {
				domainId: "domain",
				ownerSignPub: owner.sign.pub,
				epoch: 1,
				kind: "board.body",
			}),
			{ domainId: "domain", ownerSignPub: owner.sign.pub, epoch: 1, kind: "board.body" },
		);
		expect(fs.statSync(path.join(dir, "content-keys.json")).mode & 0o777).toBe(0o600);
		expect(logs.join("\n")).not.toContain(keyB64);
		expect(logs.join("\n")).not.toContain(plaintext);
	});

	it.each([
		["malformed JSON", "{"],
		[
			"unsupported version",
			JSON.stringify({
				v: 2,
				keys: { "1": Buffer.alloc(32).toString("base64"), "2": Buffer.alloc(32).toString("base64") },
			}),
		],
		["short key", JSON.stringify({ v: 1, keys: { "1": Buffer.alloc(31).toString("base64") } })],
	])("quarantines %s key files", (_reason, contents) => {
		const dir = tempDir();
		const file = path.join(dir, "content-keys.json");
		fs.writeFileSync(file, contents);
		const store = new ContentKeyStore(dir, "");
		const aside = fs.readdirSync(dir).find((name) => name.startsWith("content-keys.json.corrupt-"));
		expect(store.epochs()).toEqual([]);
		expect(aside).toBeDefined();
		expect(fs.readFileSync(path.join(dir, aside!), "utf8")).toBe(contents);
	});

	it("keeps a corrupt aside when a later install succeeds", () => {
		const dir = tempDir();
		const contents = JSON.stringify({ v: 1, keys: { "1": Buffer.alloc(31).toString("base64") } });
		fs.writeFileSync(path.join(dir, "content-keys.json"), contents);
		const gateway = generateIdentity();
		const store = new ContentKeyStore(dir, gateway.box.priv);
		const aside = fs.readdirSync(dir).find((name) => name.startsWith("content-keys.json.corrupt-"))!;
		const owner = generateIdentity();
		const signer = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: signer.sign.pub, boxPub: signer.box.pub, issuedAt: 1, nonce: "a" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const result = store.install(
			wrapContentKey(Buffer.alloc(32), 1, gateway.box.pub, signer.sign.pub, signer.sign.priv),
			{
				ownerSignPub: owner.sign.pub,
				admissions: [admission],
				revocations: [],
			},
		);
		expect(result).toBe("installed");
		expect(fs.readFileSync(path.join(dir, aside), "utf8")).toBe(contents);
	});

	it("does not load identity during standalone-style store construction", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "federation-identity.json"), "garbage");
		expect(() => new ContentKeyStore(dir, () => "unused")).not.toThrow();
	});
});
