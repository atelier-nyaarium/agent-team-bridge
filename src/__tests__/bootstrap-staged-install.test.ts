import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Allowlist } from "../gateway/federation/allowlist.js";
import { activateStaged, recoverStaging, stageBootstrap } from "../gateway/federation/bootstrapInstall.js";
import { ContentKeyStore } from "../gateway/federation/contentKeyStore.js";
import { signAdmission, signRevocation } from "../shared/admission.js";
import { wrapContentKey } from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";
import type { GatewayBootstrapBundle } from "../shared/schemas.js";

function bundle(): {
	bundle: GatewayBootstrapBundle;
	owner: ReturnType<typeof generateIdentity>;
	gateway: ReturnType<typeof generateIdentity>;
} {
	const owner = generateIdentity();
	const gateway = generateIdentity();
	return {
		owner,
		gateway,
		bundle: {
			nonce: "nonce",
			transport: { routerUrl: "https://router", routerCertFp: "aa", bearer: "bb" },
			admission: {
				admission: {
					kind: "gateway",
					signPub: gateway.sign.pub,
					boxPub: gateway.box.pub,
					gatewayId: "g",
					issuedAt: 1,
					nonce: "a",
				},
				ownerSignPub: owner.sign.pub,
				signature: "sig",
			},
			domain: { ownerSignPub: owner.sign.pub, admissions: [], revocations: [] },
			domainId: "domain",
		},
	};
}

function rootLive(
	dir: string,
	owner: ReturnType<typeof generateIdentity>,
	gateway: ReturnType<typeof generateIdentity>,
): void {
	new Allowlist(dir).applySnapshot({
		ownerSignPub: owner.sign.pub,
		admissions: [
			signAdmission(
				{
					kind: "gateway",
					signPub: gateway.sign.pub,
					boxPub: gateway.box.pub,
					gatewayId: "g",
					issuedAt: 0,
					nonce: "live",
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		],
		revocations: [],
	});
}

function signedGatewayBundle(
	base: GatewayBootstrapBundle,
	owner: ReturnType<typeof generateIdentity>,
	gateway: ReturnType<typeof generateIdentity>,
	issuedAt: number,
): GatewayBootstrapBundle {
	const admission = signAdmission(
		{
			kind: "gateway",
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			gatewayId: "g",
			issuedAt,
			nonce: `gateway-${issuedAt}`,
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	return { ...base, admission, domain: { ...base.domain, admissions: [admission] } };
}

function enrollLive(
	dir: string,
	base: GatewayBootstrapBundle,
	owner: ReturnType<typeof generateIdentity>,
	gateway: ReturnType<typeof generateIdentity>,
	issuedAt = 1,
	contentKeys?: GatewayBootstrapBundle["contentKeys"],
): void {
	rootLive(dir, owner, gateway);
	const delivered = { ...signedGatewayBundle(base, owner, gateway, issuedAt), contentKeys };
	stageBootstrap(dir, delivered, gateway, new ContentKeyStore(dir, gateway.box.priv));
	recoverStaging(dir);
}

function liveBytes(dir: string): Buffer[] {
	return ["federation-allowlist.json", "transport.json", "domain-id", "content-keys.json"].map((file) =>
		fs.readFileSync(path.join(dir, file)),
	);
}

describe("staged bootstrap install", () => {
	it("rolls back a marker with a missing artifact", () => {
		for (const artifact of ["federation-allowlist.json", "transport.json", "domain-id", "content-keys.json"]) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
			const staging = path.join(dir, "staging");
			fs.mkdirSync(staging);
			for (const present of ["federation-allowlist.json", "transport.json", "domain-id", "content-keys.json"])
				if (present !== artifact) fs.writeFileSync(path.join(staging, present), "partial");
			fs.writeFileSync(path.join(staging, "INSTALLED"), "");
			recoverStaging(dir);
			for (const present of ["federation-allowlist.json", "transport.json", "domain-id", "content-keys.json"])
				expect(fs.existsSync(path.join(dir, present))).toBe(false);
			expect(fs.existsSync(staging)).toBe(false);
		}
	});

	it("rolls back marker-less interruptions after any artifact", () => {
		const artifacts = ["federation-allowlist.json", "domain-id", "content-keys.json", "transport.json"];
		for (let count = 0; count <= artifacts.length; count++) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
			const staging = path.join(dir, "staging");
			fs.mkdirSync(staging);
			for (const artifact of artifacts.slice(0, count)) fs.writeFileSync(path.join(staging, artifact), "partial");
			recoverStaging(dir);
			for (const artifact of artifacts) expect(fs.existsSync(path.join(dir, artifact))).toBe(false);
			expect(fs.existsSync(staging)).toBe(false);
		}
	});

	it("activates every artifact once the marker exists and recovers twice", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const initial = bundle();
		stageBootstrap(dir, initial.bundle, initial.gateway, new ContentKeyStore(dir, initial.gateway.box.priv));
		expect(fs.existsSync(path.join(dir, "staging", "INSTALLED"))).toBe(true);
		recoverStaging(dir);
		for (const artifact of ["federation-allowlist.json", "transport.json", "domain-id", "content-keys.json"])
			expect(fs.existsSync(path.join(dir, artifact))).toBe(true);
		recoverStaging(dir);
		activateStaged(dir);
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
	});

	it("enrolls a pre-change bundle with only the gateway admission", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		const admission = signAdmission(
			{
				kind: "gateway",
				signPub: gateway.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId: "g",
				issuedAt: 1,
				nonce: "gateway",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		const preChange = { ...base, admission, domain: { ...base.domain, admissions: [admission] } };

		stageBootstrap(dir, preChange, gateway, new ContentKeyStore(dir, gateway.box.priv), "unlisted-old-console");
		recoverStaging(dir);

		expect(new Allowlist(dir).selfAdmission(gateway.sign.pub)?.admission.gatewayId).toBe("g");
	});

	it("refuses a bundle rooted at another owner before staging", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const liveOwner = generateIdentity();
		new Allowlist(dir).setOwner(liveOwner.sign.pub);
		const before = fs.readdirSync(dir);

		expect(() => stageBootstrap(dir, bundle().bundle, generateIdentity(), new ContentKeyStore(dir))).toThrow();
		expect(fs.readdirSync(dir)).toEqual(before);
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
	});

	it("rejects a gateway-signed content key without staging", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const owner = generateIdentity();
		const gateway = generateIdentity();
		rootLive(dir, owner, gateway);
		const gatewayAdmission = signAdmission(
			{
				kind: "gateway",
				signPub: gateway.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId: "g",
				issuedAt: 1,
				nonce: "gateway",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		const invalid = {
			...bundle().bundle,
			domain: { ownerSignPub: owner.sign.pub, admissions: [gatewayAdmission], revocations: [] },
			contentKeys: [wrapContentKey(Buffer.alloc(32, 3), 1, gateway.box.pub, gateway.sign.pub, gateway.sign.priv)],
		};

		expect(() => stageBootstrap(dir, invalid, gateway, new ContentKeyStore(dir, gateway.box.priv))).toThrow();
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
	});

	it("installs a console-signed key from the domain snapshot", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		rootLive(dir, owner, gateway);
		const console_ = generateIdentity();
		const consoleAdmission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "console" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const delivered = {
			...base,
			domain: { ...base.domain, admissions: [consoleAdmission] },
			contentKeys: [
				wrapContentKey(Buffer.alloc(32, 8), 1, gateway.box.pub, console_.sign.pub, console_.sign.priv),
			],
		};

		const store = new ContentKeyStore(dir, gateway.box.priv);
		expect(store.epochs()).toEqual([]);
		stageBootstrap(dir, delivered, gateway, new ContentKeyStore(dir, gateway.box.priv));
		recoverStaging(dir);

		expect(new Allowlist(dir).ownerSignPub).toBe(owner.sign.pub);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "transport.json"), "utf8"))).toEqual(base.transport);
		expect(fs.readFileSync(path.join(dir, "domain-id"), "utf8")).toBe("domain");
		store.reload();
		expect(store.epochs()).toEqual([1]);
	});

	it("resumes activation after each copied artifact", () => {
		const artifacts = ["federation-allowlist.json", "domain-id", "content-keys.json", "transport.json"];
		for (let count = 1; count <= artifacts.length; count++) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
			const { bundle: base, owner, gateway } = bundle();
			rootLive(dir, owner, gateway);
			const console_ = generateIdentity();
			const admission = signAdmission(
				{
					kind: "console",
					signPub: console_.sign.pub,
					boxPub: console_.box.pub,
					issuedAt: 1,
					nonce: "console",
				},
				owner.sign.priv,
				owner.sign.pub,
			);
			const delivered = {
				...base,
				domain: { ...base.domain, admissions: [admission] },
				contentKeys: [
					wrapContentKey(Buffer.alloc(32, 8), 1, gateway.box.pub, console_.sign.pub, console_.sign.priv),
				],
			};
			stageBootstrap(dir, delivered, gateway, new ContentKeyStore(dir, gateway.box.priv));
			for (const artifact of artifacts.slice(0, count))
				fs.copyFileSync(path.join(dir, "staging", artifact), path.join(dir, artifact));
			recoverStaging(dir);
			expect(artifacts.every((artifact) => fs.existsSync(path.join(dir, artifact)))).toBe(true);
			expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
			expect(new ContentKeyStore(dir, gateway.box.priv).epochs()).toEqual([1]);
		}
	});

	it("refuses revoked and re-admitted frame signers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		const console_ = generateIdentity();
		const consoleAdmission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "console" },
			owner.sign.priv,
			owner.sign.pub,
		);
		enrollLive(dir, base, owner, gateway, 1);
		const revoked = signRevocation(
			{ signPub: console_.sign.pub, issuedAt: 2, nonce: "revoke" },
			owner.sign.priv,
			owner.sign.pub,
		);
		new Allowlist(dir).applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [
				signAdmission(
					{
						kind: "gateway",
						signPub: gateway.sign.pub,
						boxPub: gateway.box.pub,
						gatewayId: "g",
						issuedAt: 1,
						nonce: "gateway-1",
					},
					owner.sign.priv,
					owner.sign.pub,
				),
				consoleAdmission,
			],
			revocations: [revoked],
		});
		const before = liveBytes(dir);
		const delivered = {
			...signedGatewayBundle(base, owner, gateway, 2),
			domain: { ...base.domain, admissions: [consoleAdmission] },
			contentKeys: [
				wrapContentKey(Buffer.alloc(32, 8), 1, gateway.box.pub, console_.sign.pub, console_.sign.priv),
			],
		};

		expect(() =>
			stageBootstrap(dir, delivered, gateway, new ContentKeyStore(dir, gateway.box.priv), console_.sign.pub),
		).toThrow();
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
		expect(liveBytes(dir)).toEqual(before);

		const laterGatewayAdmission = signAdmission(
			{
				kind: "gateway",
				signPub: console_.sign.pub,
				boxPub: console_.box.pub,
				gatewayId: "other",
				issuedAt: 3,
				nonce: "gateway",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		new Allowlist(dir).applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [consoleAdmission, laterGatewayAdmission],
			revocations: [],
		});
		const afterReAdmission = { ...delivered, domain: { ...delivered.domain, revocations: [] } };
		expect(() =>
			stageBootstrap(
				dir,
				afterReAdmission,
				gateway,
				new ContentKeyStore(dir, gateway.box.priv),
				console_.sign.pub,
			),
		).toThrow();
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
	});

	it("requires a newer gateway admission and accepts the newer one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		enrollLive(dir, base, owner, gateway, 1);
		const before = liveBytes(dir);
		expect(() =>
			stageBootstrap(
				dir,
				signedGatewayBundle(base, owner, gateway, 1),
				gateway,
				new ContentKeyStore(dir, gateway.box.priv),
			),
		).toThrow();
		expect(liveBytes(dir)).toEqual(before);
		stageBootstrap(
			dir,
			signedGatewayBundle(base, owner, gateway, 2),
			gateway,
			new ContentKeyStore(dir, gateway.box.priv),
		);
		expect(fs.existsSync(path.join(dir, "staging", "INSTALLED"))).toBe(true);
	});

	it("merges delivered keys without dropping held epochs", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		const console_ = generateIdentity();
		const consoleAdmission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "console" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const envelopes = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, index) => {
				const epoch = from + index;
				return wrapContentKey(
					Buffer.alloc(32, epoch),
					epoch,
					gateway.box.pub,
					console_.sign.pub,
					console_.sign.priv,
				);
			});
		const initial = {
			...signedGatewayBundle(base, owner, gateway, 1),
			domain: { ...base.domain, admissions: [consoleAdmission] },
		};
		stageBootstrap(
			dir,
			{ ...initial, contentKeys: envelopes(1, 5) },
			gateway,
			new ContentKeyStore(dir, gateway.box.priv),
		);
		recoverStaging(dir);
		stageBootstrap(
			dir,
			{
				...signedGatewayBundle(base, owner, gateway, 2),
				domain: { ...base.domain, admissions: [consoleAdmission] },
				contentKeys: envelopes(3, 5),
			},
			gateway,
			new ContentKeyStore(dir, gateway.box.priv),
		);
		recoverStaging(dir);
		stageBootstrap(
			dir,
			{
				...signedGatewayBundle(base, owner, gateway, 3),
				domain: { ...base.domain, admissions: [consoleAdmission] },
			},
			gateway,
			new ContentKeyStore(dir, gateway.box.priv),
		);
		recoverStaging(dir);
		expect(new ContentKeyStore(dir, gateway.box.priv).epochs()).toEqual([1, 2, 3, 4, 5]);
	});

	it("refuses a different key for a held epoch", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		const console_ = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "console" },
			owner.sign.priv,
			owner.sign.pub,
		);
		rootLive(dir, owner, gateway);
		stageBootstrap(
			dir,
			{
				...signedGatewayBundle(base, owner, gateway, 1),
				domain: { ...base.domain, admissions: [admission] },
				contentKeys: [
					wrapContentKey(Buffer.alloc(32, 1), 1, gateway.box.pub, console_.sign.pub, console_.sign.priv),
				],
			},
			gateway,
			new ContentKeyStore(dir, gateway.box.priv),
		);
		recoverStaging(dir);
		new Allowlist(dir).applySnapshot({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] });
		const before = liveBytes(dir);
		const delivered = {
			...signedGatewayBundle(base, owner, gateway, 2),
			domain: { ...base.domain, admissions: [admission] },
			contentKeys: [
				wrapContentKey(Buffer.alloc(32, 2), 1, gateway.box.pub, console_.sign.pub, console_.sign.priv),
			],
		};
		expect(() => stageBootstrap(dir, delivered, gateway, new ContentKeyStore(dir, gateway.box.priv))).toThrow();
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
		expect(liveBytes(dir)).toEqual(before);
	});

	it("keeps staging after activation failure and retries all artifacts", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		const console_ = generateIdentity();
		const admission = signAdmission(
			{ kind: "console", signPub: console_.sign.pub, boxPub: console_.box.pub, issuedAt: 1, nonce: "console" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const delivered = {
			...signedGatewayBundle(base, owner, gateway, 1),
			domain: { ...base.domain, admissions: [admission] },
			contentKeys: [
				wrapContentKey(Buffer.alloc(32, 9), 1, gateway.box.pub, console_.sign.pub, console_.sign.priv),
			],
		};
		stageBootstrap(dir, delivered, gateway, new ContentKeyStore(dir, gateway.box.priv));
		fs.mkdirSync(path.join(dir, "content-keys.json"));
		expect(() => activateStaged(dir)).toThrow();
		expect(fs.existsSync(path.join(dir, "staging", "INSTALLED"))).toBe(true);
		fs.rmdirSync(path.join(dir, "content-keys.json"));
		recoverStaging(dir);
		expect(new ContentKeyStore(dir, gateway.box.priv).epochs()).toEqual([1]);
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
	});

	it("discards foreign-rooted and garbage installed staging", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		const { bundle: base, owner, gateway } = bundle();
		enrollLive(dir, base, owner, gateway);
		const before = liveBytes(dir);
		const foreign = bundle();
		const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-stage-"));
		stageBootstrap(
			foreignDir,
			foreign.bundle,
			foreign.gateway,
			new ContentKeyStore(foreignDir, foreign.gateway.box.priv),
		);
		fs.mkdirSync(path.join(dir, "staging"));
		for (const artifact of ["federation-allowlist.json", "domain-id", "content-keys.json", "transport.json"])
			fs.copyFileSync(path.join(foreignDir, "staging", artifact), path.join(dir, "staging", artifact));
		fs.writeFileSync(path.join(dir, "staging", "INSTALLED"), "");
		recoverStaging(dir);
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
		expect(liveBytes(dir)).toEqual(before);

		stageBootstrap(
			dir,
			signedGatewayBundle(base, owner, gateway, 2),
			gateway,
			new ContentKeyStore(dir, gateway.box.priv),
		);
		fs.writeFileSync(path.join(dir, "staging", "federation-allowlist.json"), "garbage");
		recoverStaging(dir);
		expect(fs.existsSync(path.join(dir, "staging"))).toBe(false);
		expect(liveBytes(dir)).toEqual(before);
	});
});
