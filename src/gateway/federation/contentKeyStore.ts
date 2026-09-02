import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveAdmittedConsole, type SignedAdmission, type SignedRevocation } from "../../shared/admission.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { type ContentAad, openContent, unwrapContentKey } from "../../shared/content-envelope.js";
import {
	type ContentEnvelope,
	ContentEnvelopeSchema,
	type KeyEnvelope,
	KeyEnvelopeSchema,
} from "../../shared/schemasContentKey.js";

const renameFileSync = Reflect.get(fs, "renameSync") as typeof fs.renameSync;

const ContentKeyFileSchema = z.object({
	v: z.literal(1),
	keys: z.record(
		z
			.string()
			.regex(/^[1-9][0-9]*$/)
			.refine((value) => Number(value) <= 2147483647),
		z.string().refine((value) => Buffer.from(value, "base64").length === 32),
	),
});

export interface ContentKeyTrust {
	ownerSignPub: string;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
}

export class ContentKeyStore {
	private readonly file: string;
	private readonly recipientBoxPriv: string | (() => string);
	private readonly keys: Map<number, Buffer>;

	constructor(dir: string, recipientBoxPriv: string | (() => string) = "") {
		this.file = path.join(dir, "content-keys.json");
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

	// Already-present keys pass.
	install(envelope: KeyEnvelope, trust: ContentKeyTrust): "installed" | "already_present" | "refused" {
		const parsed = KeyEnvelopeSchema.safeParse(envelope);
		if (!parsed.success) return "refused";
		const recipientBoxPriv =
			typeof this.recipientBoxPriv === "function" ? this.recipientBoxPriv() : this.recipientBoxPriv;
		if (!recipientBoxPriv) throw new Error("content key recipient box key is unavailable");
		let unwrapped: { epoch: number; key: Buffer };
		try {
			unwrapped = unwrapContentKey(parsed.data, recipientBoxPriv);
		} catch {
			return "refused";
		}
		if (
			!resolveAdmittedConsole(trust.admissions, trust.revocations, trust.ownerSignPub, parsed.data.signerSignPub)
		) {
			return "refused";
		}
		const { epoch, key } = unwrapped;
		const held = this.keys.get(epoch);
		if (held) {
			if (held.equals(key)) return "already_present";
			console.warn(`[content-key-store] refused different key for epoch ${epoch}`);
			return "refused";
		}
		this.keys.set(epoch, key);
		this.persist();
		return "installed";
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
