import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveAdmittedConsole, type SignedAdmission, type SignedRevocation } from "../../shared/admission.js";
import { renameFileSync, writeFileAtomic } from "../../shared/atomic-write.js";
import { type ContentAad, openContent, sealContent, unwrapContentKey } from "../../shared/content-envelope.js";
import { b64Field } from "../../shared/crypto.js";
import {
	type ContentEnvelope,
	ContentEnvelopeSchema,
	type KeyEnvelope,
	KeyEnvelopeSchema,
} from "../../shared/schemasContentKey.js";

export const CONTENT_KEYS_FILE = "content-keys.json";

const ContentKeyFileSchema = z.object({
	v: z.literal(1),
	keys: z.record(
		z
			.string()
			.regex(/^[1-9][0-9]*$/)
			.refine((value) => Number(value) <= 2147483647),
		b64Field().refine((value) => Buffer.from(value, "base64").length === 32, "key must decode to exactly 32 bytes"),
	),
});

export interface ContentKeyTrust {
	ownerSignPub: string;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
}

export type ContentKeyRefusalReason = "malformed_envelope" | "untrusted_signer" | "unwrap_failed" | "different_key";

export type ContentKeyClassification =
	| { kind: "accepted"; map: Map<number, Buffer>; newEpochs: number[] }
	| { kind: "refused"; reason: ContentKeyRefusalReason; epoch?: number };

export class ContentKeyStore {
	private readonly file: string;
	private readonly recipientBoxPriv: string | (() => string);
	private readonly keys: Map<number, Buffer>;

	constructor(dir: string, recipientBoxPriv: string | (() => string) = "") {
		this.file = path.join(dir, CONTENT_KEYS_FILE);
		this.recipientBoxPriv = recipientBoxPriv;
		this.keys = this.read();
	}

	static writeFile(file: string, keys: Map<number, Buffer>): void {
		const encoded: Record<string, string> = {};
		for (const epoch of [...keys.keys()].sort((a, b) => a - b))
			encoded[String(epoch)] = keys.get(epoch)!.toString("base64");
		writeFileAtomic(file, JSON.stringify({ v: 1, keys: encoded }), {
			mode: 0o600,
			fsyncFile: true,
			fsyncDirectory: true,
		});
	}

	private read(): Map<number, Buffer> {
		let rawText: string;
		try {
			rawText = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawText);
		} catch {
			return this.quarantine("malformed JSON");
		}
		const result = ContentKeyFileSchema.safeParse(parsed);
		if (!result.success) return this.quarantine("invalid content key entry");
		return new Map(
			Object.entries(result.data.keys).map(
				([epoch, key]) => [Number(epoch), Buffer.from(key, "base64")] as const,
			),
		);
	}

	private quarantine(reason: string): Map<number, Buffer> {
		const aside = `${this.file}.corrupt-${Date.now()}`;
		renameFileSync(this.file, aside);
		console.warn(`[content-key-store] ${reason}; moved aside to ${aside}`);
		return new Map();
	}

	// Commits preserve held epochs.
	commit(map: Map<number, Buffer>): void {
		for (const epoch of this.keys.keys()) {
			if (!map.has(epoch)) throw new Error("content key commit would drop a held epoch");
		}
		this.keys.clear();
		for (const [epoch, key] of map) this.keys.set(epoch, Buffer.from(key));
		this.persist();
	}

	private persist(): void {
		ContentKeyStore.writeFile(this.file, this.keys);
	}

	reload(): void {
		const next = this.read();
		this.keys.clear();
		for (const [epoch, key] of next) this.keys.set(epoch, key);
	}

	epochs(): number[] {
		return [...this.keys.keys()].sort((a, b) => a - b);
	}

	snapshot(): Map<number, Buffer> {
		return new Map([...this.keys].map(([epoch, key]) => [epoch, Buffer.from(key)]));
	}

	keyFor(epoch: number): Buffer | null {
		return this.keys.get(epoch) ?? null;
	}

	classify(envelopes: KeyEnvelope[], trust: ContentKeyTrust | null): ContentKeyClassification {
		const parsed = z.array(KeyEnvelopeSchema).safeParse(envelopes);
		if (!parsed.success) return { kind: "refused", reason: "malformed_envelope" };
		const recipientBoxPriv =
			typeof this.recipientBoxPriv === "function" ? this.recipientBoxPriv() : this.recipientBoxPriv;
		if (!recipientBoxPriv) throw new Error("content key recipient box key is unavailable");
		const merged = this.snapshot();
		const newEpochs: number[] = [];
		for (const envelope of parsed.data) {
			if (
				trust &&
				!resolveAdmittedConsole(trust.admissions, trust.revocations, trust.ownerSignPub, envelope.signerSignPub)
			)
				return { kind: "refused", reason: "untrusted_signer", epoch: envelope.epoch };
			let unwrapped: { epoch: number; key: Buffer };
			try {
				unwrapped = unwrapContentKey(envelope, recipientBoxPriv);
			} catch {
				return { kind: "refused", reason: "unwrap_failed", epoch: envelope.epoch };
			}
			const held = merged.get(unwrapped.epoch);
			if (held && !held.equals(unwrapped.key)) {
				return { kind: "refused", reason: "different_key", epoch: unwrapped.epoch };
			}
			if (!held) {
				merged.set(unwrapped.epoch, unwrapped.key);
				if (!this.keys.has(unwrapped.epoch)) newEpochs.push(unwrapped.epoch);
			}
		}
		return { kind: "accepted", map: merged, newEpochs };
	}

	// Existing keys remain unchanged.
	install(envelope: KeyEnvelope, trust: ContentKeyTrust): "installed" | "already_present" | "refused" {
		const result = this.classify([envelope], trust);
		if (result.kind === "refused") return "refused";
		if (result.newEpochs.length === 0) return "already_present";
		this.commit(result.map);
		return "installed";
	}

	/** Seals under a held epoch. */
	seal(
		plaintext: Buffer,
		aad: Omit<ContentAad, "epoch">,
		explicitEpoch?: number,
	): { kind: "ok"; envelope: ContentEnvelope } | { kind: "no_key" } {
		const epoch = explicitEpoch ?? this.epochs().at(-1);
		const key = epoch === undefined ? null : this.keyFor(epoch);
		if (epoch === undefined || !key) return { kind: "no_key" };
		return { kind: "ok", envelope: sealContent(plaintext, key, { ...aad, epoch }) };
	}

	open(
		env: ContentEnvelope,
		aad: ContentAad,
	): { kind: "ok"; plaintext: Buffer } | { kind: "missing_epoch"; epoch: number } | { kind: "bad_tag" } {
		const parsed = ContentEnvelopeSchema.safeParse(env);
		if (!parsed.success) return { kind: "bad_tag" };
		const key = this.keyFor(parsed.data.epoch);
		if (!key) return { kind: "missing_epoch", epoch: parsed.data.epoch };
		try {
			return { kind: "ok", plaintext: openContent(parsed.data, key, aad) };
		} catch {
			return { kind: "bad_tag" };
		}
	}
}
