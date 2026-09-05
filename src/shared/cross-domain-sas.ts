import crypto from "node:crypto";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

export interface CrossDomainParty {
	ownerSignPub: string;
	gatewaySignPub: string;
	gatewayBoxPub: string;
	domainId: string;
	gatewayId: string;
}

// SasCrypto.kt must reproduce this fixed preimage order byte-for-byte.
export function crossDomainCommitmentPreimage(party: CrossDomainParty, salt: string): Buffer {
	return Buffer.from(
		[
			SIGNING_TAGS.sasCommit,
			party.ownerSignPub,
			party.gatewaySignPub,
			party.gatewayBoxPub,
			party.domainId,
			party.gatewayId,
			salt,
		].join("\n"),
		"utf8",
	);
}

// Commitments bind identities before SAS reveal and prevent offline SAS grinding.
export function crossDomainCommitment(party: CrossDomainParty, salt: string): string {
	return crypto.createHash("sha256").update(crossDomainCommitmentPreimage(party, salt)).digest("base64");
}

export function verifyCrossDomainCommitment(commitment: string, party: CrossDomainParty, salt: string): boolean {
	return crossDomainCommitment(party, salt) === commitment;
}

// Six digits bounds residual online guesses.
const SAS_DIGITS = 6;

const SAS_MODULUS = 1_000_000n;

/** Lexicographic sorting makes the SAS symmetric. */
export function crossDomainSasPreimage(a: CrossDomainParty, b: CrossDomainParty, pin: string): Buffer {
	const fields = [
		a.ownerSignPub,
		a.gatewaySignPub,
		a.gatewayBoxPub,
		a.domainId,
		a.gatewayId,
		b.ownerSignPub,
		b.gatewaySignPub,
		b.gatewayBoxPub,
		b.domainId,
		b.gatewayId,
	].sort();
	return Buffer.from([SIGNING_TAGS.sas, ...fields, pin].join("\n"), "utf8");
}

function reduceToSas(preimage: Buffer): string {
	const buf = crypto.createHash("sha256").update(preimage).digest();
	let n = 0n;
	for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(buf[i]);
	return (n % SAS_MODULUS).toString(10).padStart(SAS_DIGITS, "0");
}

export function crossDomainSas(a: CrossDomainParty, b: CrossDomainParty, pin: string): string {
	return reduceToSas(crossDomainSasPreimage(a, b, pin));
}

// Enroll binds owner keys and fixed role slots.
export interface EnrollParty {
	ownerSignPub: string;
	ownerBoxPub: string;
	domainId: string;
}

/** Physical role fixes each party's preimage slot. */
export type EnrollRole = "ADMIN" | "ENROLLEE";

export function enrollCommitmentPreimage(party: EnrollParty, role: EnrollRole, salt: string): Buffer {
	return Buffer.from(
		[SIGNING_TAGS.enrollCommit, role, party.ownerSignPub, party.ownerBoxPub, party.domainId, salt].join("\n"),
		"utf8",
	);
}

/** Salted commitments force Router substitutions before reveal. */
export function enrollCommitment(party: EnrollParty, role: EnrollRole, salt: string): string {
	return crypto
		.createHash("sha256")
		.update(enrollCommitmentPreimage(party, role, salt))
		.digest("base64");
}

export function verifyEnrollCommitment(
	commitment: string,
	party: EnrollParty,
	role: EnrollRole,
	salt: string,
): boolean {
	return enrollCommitment(party, role, salt) === commitment;
}

/** Fixed admin and enrollee slots make the enroll SAS symmetric. */
export function enrollSasPreimage(admin: EnrollParty, enrollee: EnrollParty, pin: string): Buffer {
	return Buffer.from(
		[
			SIGNING_TAGS.enrollSas,
			"ADMIN",
			admin.ownerSignPub,
			admin.ownerBoxPub,
			admin.domainId,
			"ENROLLEE",
			enrollee.ownerSignPub,
			enrollee.ownerBoxPub,
			enrollee.domainId,
			pin,
		].join("\n"),
		"utf8",
	);
}

// Enroll codes are computed phone-side. The Router never computes them.
export function enrollSas(admin: EnrollParty, enrollee: EnrollParty, pin: string): string {
	return reduceToSas(enrollSasPreimage(admin, enrollee, pin));
}
