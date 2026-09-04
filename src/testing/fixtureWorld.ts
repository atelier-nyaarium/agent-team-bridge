import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { GatewayBootstrap } from "../gateway/boot.js";
import { ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import { type DomainSnapshot, verifyAdmission } from "../shared/admission.js";
import { deriveContentKey } from "../shared/content-envelope.js";
import type { Identity } from "../shared/crypto.js";
import { type IdentitySet, type RouterTransportSeed, seedGateway } from "./identitySet.js";

export class FixtureDraws {
	private counter = 0;
	private readonly seen = new Set<string>();
	readonly inputs: { draws: Record<string, string> } = { draws: {} };

	private constructor(
		private readonly producer: string,
		private readonly composer: string,
		private readonly name: string,
	) {}

	static forCase(producer: string, composer: string, name: string): FixtureDraws {
		return new FixtureDraws(producer, composer, name);
	}

	next(size: number): Buffer {
		if (!Number.isInteger(size) || size < 0 || size > 32) throw new Error("fixture draw size must be from 0 to 32");
		const index = this.counter++;
		const bytes = createHash("sha256")
			.update(`${this.producer}:${this.composer}:${this.name}:${index}`)
			.digest()
			.subarray(0, size);
		const encoded = bytes.toString("base64");
		if (this.seen.has(encoded)) throw new Error(`fixture draw ${index} repeats bytes`);
		this.seen.add(encoded);
		this.inputs.draws[String(index)] = encoded;
		return bytes;
	}

	newId(): string {
		return this.next(16).toString("hex");
	}
}

export interface FixturePhoneFacts {
	domainId: string;
	ownerSignPub: string;
	consoleIdentity: Identity;
	device: string;
	conversationId: string;
	contentKey: Buffer;
}

export class FixtureWorld {
	readonly domain: DomainSnapshot;
	readonly contentKey: Buffer;
	readonly phone: FixturePhoneFacts;

	private constructor(readonly set: IdentitySet) {
		this.contentKey = Buffer.from(set.content.key, "base64");
		const expected = deriveContentKey(set.domain.owner.sign.priv, set.domain.id, set.content.epoch);
		if (!this.contentKey.equals(expected))
			throw new Error("fixture content key does not derive from the Domain owner");
		if (!verifyAdmission(set.gateway.admission, set.domain.owner.sign.pub))
			throw new Error("gateway admission is invalid");
		if (!verifyAdmission(set.console.admission, set.domain.owner.sign.pub))
			throw new Error("console admission is invalid");
		this.domain = {
			ownerSignPub: set.domain.owner.sign.pub,
			admissions: [set.gateway.admission, set.console.admission],
			revocations: [],
		};
		this.phone = {
			domainId: set.domain.id,
			ownerSignPub: set.domain.owner.sign.pub,
			consoleIdentity: set.console.identity,
			device: set.console.device,
			conversationId: set.console.conversationId,
			contentKey: Buffer.from(this.contentKey),
		};
	}

	static from(set: IdentitySet): FixtureWorld {
		return new FixtureWorld(set);
	}

	contentKeys(dir: string, randomBytes: (size: number) => Buffer = nodeRandomBytes): ContentKeyStore {
		return new ContentKeyStore(dir, this.set.gateway.identity.box.priv, randomBytes);
	}

	gatewayBootstrap(federationDir: string, transport: RouterTransportSeed, contentKeys?: ContentKeyStore) {
		seedGateway(federationDir, this.set, transport);
		return GatewayBootstrap.resolve(
			{ federationDir },
			{ enrollNonce: null, allowFixtureIdentity: true },
			{ identity: () => this.set.gateway.identity, contentKeys },
		);
	}
}
