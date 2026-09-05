import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import { signAdmission } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";
import type { KeyEnvelope } from "../shared/schemasContentKey.js";

type Fixture = {
	recipientBox: { pub: string; priv: string };
	admittedSigner: { pub: string; priv: string };
	held: Record<string, string>;
	envelopes: Record<string, KeyEnvelope>;
	cases: Array<{
		name: string;
		envelopes: string[];
		decision: "unchanged" | "installed" | "refused";
		reason?: string;
		expectedEpochs: number[];
	}>;
};

const fixture = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/content-envelope/keyring-merge.json"), "utf8"),
) as Fixture;

describe("content keyring merge fixture", () => {
	it.each(fixture.cases)("$name", (testCase) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-keyring-merge-"));
		try {
			const store = new ContentKeyStore(dir, fixture.recipientBox.priv, processAmbient());
			store.commit(
				new Map(
					Object.entries(fixture.held).map(([epoch, key]) => [Number(epoch), Buffer.from(key, "base64")]),
				),
			);
			const owner = generateIdentity();
			const admission = signAdmission(
				{
					kind: "console",
					signPub: fixture.admittedSigner.pub,
					boxPub: "fixture-box",
					issuedAt: 1,
					nonce: "fixture-admission",
				},
				owner.sign.priv,
				owner.sign.pub,
			);
			const result = store.classify(
				testCase.envelopes.map((name) => fixture.envelopes[name]),
				{ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] },
			);

			if (testCase.decision === "refused") {
				expect(result).toMatchObject({ kind: "refused", reason: testCase.reason });
			} else {
				expect(
					result.kind === "accepted" &&
						result.newEpochs.length === (testCase.decision === "installed" ? 1 : 0),
				).toBe(true);
				if (testCase.decision === "installed" && result.kind === "accepted") store.commit(result.map);
			}
			expect(store.epochs()).toEqual(testCase.expectedEpochs);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
