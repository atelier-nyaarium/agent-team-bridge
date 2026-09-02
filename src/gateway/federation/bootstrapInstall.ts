import fs from "node:fs";
import path from "node:path";
import {
	resolveAdmittedConsole,
	type SignedAdmission,
	verifyAdmission,
	verifyRevocation,
} from "../../shared/admission.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { unwrapContentKey } from "../../shared/content-envelope.js";
import { type Identity, unseal } from "../../shared/crypto.js";
import {
	type GatewayBootstrapBundle,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
} from "../../shared/schemas.js";
import { KeyEnvelopeSchema } from "../../shared/schemasContentKey.js";
import { ALLOWLIST_FILE, Allowlist } from "./allowlist.js";
import { ContentKeyStore } from "./contentKeyStore.js";

const STAGING_DIR = "staging";
const ARTIFACTS = [ALLOWLIST_FILE, "domain-id", "content-keys.json", "transport.json"] as const;

////////////////////////////////
//  Functions & Helpers

export function stageBootstrap(
	federationDir: string,
	bundle: GatewayBootstrapBundle,
	gatewayIdentity: Identity,
	liveKeys = new Map<number, Buffer>(),
	outerSignerSignPub?: string,
): void {
	const liveAllowlist = new Allowlist(federationDir);
	const liveSnapshot = liveAllowlist.getSnapshot();
	const liveOwnerSignPub = liveAllowlist.ownerSignPub;
	if (liveOwnerSignPub && liveOwnerSignPub !== bundle.domain.ownerSignPub) {
		throw new Error("bundle is rooted at a different owner than this gateway's Domain");
	}
	const stagingDir = path.join(federationDir, STAGING_DIR);
	fs.rmSync(stagingDir, { recursive: true, force: true });
	fs.mkdirSync(stagingDir, { recursive: true });
	try {
		const keyMap = new Map(liveKeys);
		const verifiedBundleAdmissions = bundle.domain.admissions.filter((admission) =>
			verifyAdmission(admission, bundle.domain.ownerSignPub),
		);
		const admissions = [...(liveSnapshot?.admissions ?? []), ...verifiedBundleAdmissions, bundle.admission].filter(
			(admission, index, all) =>
				all.findIndex(
					(candidate) =>
						candidate.admission.signPub === admission.admission.signPub &&
						candidate.admission.nonce === admission.admission.nonce,
				) === index,
		);
		const revocations = [
			...(liveSnapshot?.revocations ?? []),
			...bundle.domain.revocations.filter((revocation) =>
				verifyRevocation(revocation, bundle.domain.ownerSignPub),
			),
		].filter(
			(revocation, index, all) =>
				all.findIndex(
					(candidate) =>
						candidate.revocation.signPub === revocation.revocation.signPub &&
						candidate.revocation.nonce === revocation.revocation.nonce,
				) === index,
		);
		if (liveSnapshot) {
			const liveSelf = liveAllowlist.selfAdmission(gatewayIdentity.sign.pub);
			if (liveSelf && bundle.admission.admission.issuedAt <= liveSelf.admission.issuedAt) {
				throw new Error("bootstrap admission is not newer than the live admission");
			}
			if (
				outerSignerSignPub &&
				!resolveAdmittedConsole(admissions, revocations, bundle.domain.ownerSignPub, outerSignerSignPub)
			)
				throw new Error("bootstrap frame signer is not an admitted console");
		}
		for (const envelope of bundle.contentKeys ?? []) {
			const parsedEnvelope = KeyEnvelopeSchema.safeParse(envelope);
			if (!parsedEnvelope.success) throw new Error("bootstrap content key envelope is invalid");
			if (
				liveSnapshot &&
				!resolveAdmittedConsole(
					admissions,
					revocations,
					bundle.domain.ownerSignPub,
					parsedEnvelope.data.signerSignPub,
				)
			) {
				throw new Error("bootstrap: content key is not signed by an admitted console");
			}
			const { epoch, key } = unwrapContentKey(parsedEnvelope.data, gatewayIdentity.box.priv);
			const held = keyMap.get(epoch);
			if (held && !held.equals(key)) throw new Error(`different content key for epoch ${epoch}`);
			if (held) continue;
			keyMap.set(epoch, key);
		}
		Allowlist.writeFile(path.join(stagingDir, ALLOWLIST_FILE), {
			ownerSignPub: bundle.domain.ownerSignPub,
			admissions,
			revocations,
		});
		writeFileAtomic(path.join(stagingDir, "transport.json"), JSON.stringify(bundle.transport), {
			mode: 0o600,
			fsyncFile: true,
			fsyncDirectory: true,
		});
		writeFileAtomic(path.join(stagingDir, "domain-id"), bundle.domainId ?? "", {
			mode: 0o600,
			fsyncFile: true,
			fsyncDirectory: true,
		});
		ContentKeyStore.writeFile(path.join(stagingDir, "content-keys.json"), keyMap);
		writeFileAtomic(path.join(stagingDir, "INSTALLED"), "", { mode: 0o600, fsyncFile: true, fsyncDirectory: true });
	} catch (error) {
		fs.rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

export function activateStaged(federationDir: string): void {
	const stagingDir = path.join(federationDir, STAGING_DIR);
	if (!fs.existsSync(path.join(stagingDir, "INSTALLED"))) return;
	if (!stagedIsWhole(federationDir)) throw new Error("bootstrap staging artifact is missing");
	const stagedAllowlist = new Allowlist(stagingDir);
	const liveAllowlist = new Allowlist(federationDir);
	if (
		!stagedAllowlist.ownerSignPub ||
		(liveAllowlist.ownerSignPub && stagedAllowlist.ownerSignPub !== liveAllowlist.ownerSignPub)
	)
		throw new Error("bootstrap staging allowlist has the wrong owner");
	fs.mkdirSync(federationDir, { recursive: true });
	for (const artifact of ARTIFACTS) {
		writeFileAtomic(path.join(federationDir, artifact), fs.readFileSync(path.join(stagingDir, artifact)), {
			mode: 0o600,
			fsyncFile: true,
			fsyncDirectory: true,
		});
	}
	fs.rmSync(stagingDir, { recursive: true, force: true });
	if (process.platform !== "win32") {
		const descriptor = fs.openSync(federationDir, "r");
		try {
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	}
}

export function stagedIsWhole(federationDir: string): boolean {
	const stagingDir = path.join(federationDir, STAGING_DIR);
	let markerIsFile = false;
	try {
		markerIsFile = fs.statSync(path.join(stagingDir, "INSTALLED")).isFile();
	} catch {}
	return (
		markerIsFile &&
		ARTIFACTS.every((artifact) => {
			try {
				return fs.statSync(path.join(stagingDir, artifact)).isFile();
			} catch {
				return false;
			}
		})
	);
}

export function recoverStaging(federationDir: string): void {
	const stagingDir = path.join(federationDir, STAGING_DIR);
	if (!fs.existsSync(stagingDir)) return;
	if (fs.existsSync(path.join(stagingDir, "INSTALLED"))) {
		const stagedAllowlist = new Allowlist(stagingDir);
		const liveAllowlist = new Allowlist(federationDir);
		if (
			!stagedIsWhole(federationDir) ||
			!stagedAllowlist.ownerSignPub ||
			(liveAllowlist.ownerSignPub && stagedAllowlist.ownerSignPub !== liveAllowlist.ownerSignPub)
		) {
			fs.rmSync(stagingDir, { recursive: true, force: true });
			console.warn("[bootstrap] discarded corrupt staging");
			return;
		}
		try {
			activateStaged(federationDir);
		} catch (error) {
			console.error(
				`[bootstrap] activation failed, staging kept for retry: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	} else fs.rmSync(stagingDir, { recursive: true, force: true });
}

//  A creds-less Gateway receives its enrollment as a sealed GatewayBootstrapFrame over the
//  LAN (or pasted). The trust chain, in order, before anything is installed:
//   1. The seal opens with THIS Gateway's box key (wrong-recipient or tampered -> fails).
//      Only a party that scanned this Gateway's QR (which carried its box pub) could seal
//      to it, so opening proves proximity + write-once via the nonce.
//   2. The nonce equals the one this Gateway's listener showed (anti-replay across windows).
//   3. The enclosed admission is owner-signed under the bundle's own Domain root AND binds
//      THIS Gateway's exact keys + id + a gateway kind. The owner key is trusted on first
//      use here, gated by the SAS the human confirmed and LAN proximity.

/** Open + fully validate a received bootstrap frame. Returns the trusted bundle, or
 * throws with a short reason (the caller keeps the listener open on a soft failure). */
export function openBootstrapBundle(
	frame: unknown,
	gatewayIdentity: Identity,
	expectedNonce: string,
	gatewayId: string,
): GatewayBootstrapBundle {
	const parsedFrame = GatewayBootstrapFrameSchema.safeParse(frame);
	if (!parsedFrame.success) throw new Error("bootstrap frame is invalid");
	const parsed = parsedFrame.data;
	// Unseal verifies the sender's signature (against the carried console signing key) and
	// decrypts with this Gateway's box key; throws on tamper / wrong sender / wrong recipient.
	const plain = unseal(parsed.sealed, gatewayIdentity.box.priv, parsed.signerSignPub);
	let rawBundle: unknown;
	try {
		rawBundle = JSON.parse(plain.toString("utf8"));
	} catch {
		throw new Error("bootstrap bundle is invalid");
	}
	const parsedBundle = GatewayBootstrapBundleSchema.safeParse(rawBundle);
	if (!parsedBundle.success) throw new Error("bootstrap bundle is invalid");
	const bundle = parsedBundle.data;

	if (bundle.nonce !== expectedNonce) throw new Error("bootstrap: nonce does not match this enrollment window");

	const owner = bundle.domain.ownerSignPub;
	const admission: SignedAdmission = bundle.admission;
	if (!verifyAdmission(admission, owner)) throw new Error("bootstrap: admission is not signed by the Domain owner");
	const a = admission.admission;
	if (
		a.kind !== "gateway" ||
		a.gatewayId !== gatewayId ||
		a.signPub !== gatewayIdentity.sign.pub ||
		a.boxPub !== gatewayIdentity.box.pub
	) {
		throw new Error("bootstrap: admission does not bind this Gateway's id + keys");
	}
	return bundle;
}
