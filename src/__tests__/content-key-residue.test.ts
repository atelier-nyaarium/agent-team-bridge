import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import { createInboxClaims } from "../gateway/router/inboxClaims.js";
import { createInboxDeliveryPump } from "../gateway/router/inboxDeliveryPump.js";
import { signAdmission } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import { opPayloadAadKind, sealContent, wrapContentKey } from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";

const root = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(root, "src");
const residueRoots: string[] = [];

function productionFiles(dir: string): string[] {
	const result: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) result.push(...productionFiles(file));
		else if (file.endsWith(".ts")) result.push(file);
	}
	return result;
}

describe("content key boundaries", () => {
	it("keeps the key file and derivation on their owners", () => {
		const files = productionFiles(path.join(sourceRoot, "gateway")).concat(
			productionFiles(path.join(sourceRoot, "federation-server")),
		);
		const contents = files.map((file) => [file, fs.readFileSync(file, "utf8")] as const);
		const keyFiles = contents.filter(([, text]) => text.includes("content-keys.json"));
		expect(keyFiles.map(([file]) => path.relative(sourceRoot, file))).toEqual([
			"gateway/federation/contentKeyStore.ts",
		]);
		const store = fs.readFileSync(path.join(sourceRoot, "gateway/federation/contentKeyStore.ts"), "utf8");
		expect(store.match(/writeFileAtomic\([^)]*content-keys\.json/g) ?? []).toHaveLength(0);
		expect((store.match(/writeFileAtomic\(/g) ?? []).length).toBe(1);
		for (const [file, text] of contents) {
			if (file.includes("gateway/") || file.includes("federation-server/"))
				expect(text, path.relative(sourceRoot, file)).not.toContain("deriveContentKey");
		}
	});

	afterEach(() => {
		for (const residueRoot of residueRoots.splice(0)) fs.rmSync(residueRoot, { recursive: true, force: true });
	});

	it("does not log key material during delivery", async () => {
		const residueRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-key-residue-"));
		residueRoots.push(residueRoot);
		const gateway = generateIdentity();
		const owner = generateIdentity();
		const key = Buffer.alloc(32, 0x42);
		const missingKey = Buffer.alloc(32, 0x24);
		const signerAdmission = signAdmission(
			{
				kind: "console",
				signPub: owner.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId: "gateway",
				issuedAt: 1,
				nonce: "bm9uY2U=",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		const trust = { ownerSignPub: owner.sign.pub, admissions: [signerAdmission], revocations: [] };
		const store = new ContentKeyStore(residueRoot, gateway.box.priv, processAmbient());
		const installedEnvelope = wrapContentKey(key, 1, gateway.box.pub, owner.sign.pub, owner.sign.priv);
		store.install(installedEnvelope, trust);
		const sealed = store.seal(Buffer.from("payload"), {
			domainId: "domain",
			ownerSignPub: owner.sign.pub,
			kind: opPayloadAadKind(),
		});
		expect(sealed.kind).toBe("ok");
		if (sealed.kind !== "ok") return;
		expect(
			store.open(sealed.envelope, {
				domainId: "domain",
				ownerSignPub: owner.sign.pub,
				epoch: 1,
				kind: opPayloadAadKind(),
			}).kind,
		).toBe("ok");
		const missingEnvelope = sealContent(
			Buffer.from('{"to":"session","from":"source","body":"payload"}'),
			missingKey,
			{
				domainId: "domain",
				ownerSignPub: owner.sign.pub,
				epoch: 2,
				kind: opPayloadAadKind(),
			},
		);
		const grantEnvelope = wrapContentKey(missingKey, 2, gateway.box.pub, owner.sign.pub, owner.sign.priv);
		const calls: unknown[] = [];
		const claims = createInboxClaims(residueRoot, processAmbient());
		const pump = createInboxDeliveryPump({
			claims,
			routerClient: { callInboxTool: async (_action, params) => calls.push(params) },
			domainId: "domain",
			ownerSignPub: () => owner.sign.pub,
			contentKeyStore: store,
			gatewayId: "gateway",
			gatewaySignPub: gateway.sign.pub,
			keyRequester: {
				request: () => {},
				installed: () => {},
				sendReceipt: async () => {},
				resendReceipts: async () => {},
			},
			allowlistSnapshot: () => trust,
			coordinator: { accept: () => "delivered", acknowledge: () => true },
		});
		const missingRow = {
			seq: 1,
			acceptedAt: 10,
			size: 1,
			envelope: {
				v: 1,
				epoch: 2,
				nonce: "AAAAAAAAAAAAAAAA",
				ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
				origin: { kind: "session" as const, domainId: "domain", gatewayId: "gateway", sessionId: "source" },
				opKey: { conversationId: "conversation", opId: "operation" },
				kind: "message" as const,
				contentRefs: [],
			},
			producerSig: "c2ln",
			body: missingEnvelope,
		};
		const grantRow = {
			seq: 2,
			acceptedAt: 10,
			size: 1,
			envelope: {
				v: 1,
				epoch: "clear" as const,
				origin: { kind: "router" as const, domainId: "domain" },
				kind: "key_grant" as const,
				opKey: { conversationId: "conversation", opId: "grant" },
				contentRefs: [],
			},
			producerSig: "c2ln",
			body: { v: 1, recipientSignPub: gateway.sign.pub, envelope: grantEnvelope, at: 10 },
		};
		const original = { log: console.log, warn: console.warn, error: console.error };
		const output = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		try {
			await pump.onFrame({ address: "session:domain/gateway/session", rows: [missingRow], deliveryEpoch: 1 });
			await pump.onFrame({ address: "gateway:domain/gateway", rows: [grantRow], deliveryEpoch: 1 });
			const logged = output.flatMap((spy) => spy.mock.calls.flat()).join(" ");
			for (const secret of [key, missingKey]) {
				expect(logged).not.toContain(secret.toString("base64"));
				expect(logged).not.toContain(secret.toString("hex"));
			}
			for (const bytes of [sealed.envelope, missingEnvelope, grantEnvelope.sealed])
				expect(logged).not.toContain(JSON.stringify(bytes));
			expect(logged).not.toContain(missingEnvelope.nonce);
		} finally {
			console.log = original.log;
			console.warn = original.warn;
			console.error = original.error;
		}
		expect(calls).toHaveLength(2);
	});
});
