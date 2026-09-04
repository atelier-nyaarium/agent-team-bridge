import crypto from "node:crypto";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

////////////////////////////////
//  Cross-Domain pairing SAS + commitment (commit-reveal SAS-AKE)
//
//  The cross-Domain handshake is an unauthenticated key exchange between two owners'
//  Gateways relayed by the content-blind Router. A bare SAS over only the public keys +
//  the pin is offline grindable: a malicious Router substitutes its own keys on both legs
//  and searches for a key set yielding the same short code on both phones, defeating the
//  out-of-band compare. Commit-then-reveal closes this: each side publishes a hiding
//  commitment to its keys+ids before either reveals them, so the Router must pick its
//  substituted keys before learning the peer's, collapsing the attack to a single online
//  1-in-10^6 guess bounded by the attempt cap. The SAS binds the committed keys + both
//  sides' ids + the pin.
//
//  switchboard-only, not a SYNC-HASH leaf: the Router never computes either value, and the
//  keys/pin are phone-held. The Android twin (SasCrypto.kt) hand-authors the same formulas,
//  pinned against this reference by tests/fixtures/cross-domain-sas/vectors.json. The twin
//  must reproduce these byte-for-byte under BouncyCastle, so the derivation uses only
//  SHA-256 + big-endian BigInt math.

////////////////////////////////
//  Interfaces & Types

/** One side's committed identity: the keys + ids the side binds into the link and the
 * SAS. Both the commitment and the SAS are computed over these fields in this exact
 * order, so the two runtimes must assemble them identically. */
export interface CrossDomainParty {
	ownerSignPub: string;
	gatewaySignPub: string;
	gatewayBoxPub: string;
	domainId: string;
	gatewayId: string;
}

////////////////////////////////
//  Commitment

/** The canonical commitment preimage for one side: the literal `SAS_COMMIT_V1`, then
 * that side's five identity fields in fixed order, then the side's random salt - all
 * newline-joined. The salt hides the committed values (the keys are public, so a bare
 * hash of them would be guessable). */
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

/** A side's hiding commitment to its own keys+ids, sent BEFORE either side reveals
 * keys: SHA-256 of the canonical commitment preimage, base64. The peer re-derives it
 * from the revealed keys+ids+salt and aborts the handshake on a mismatch, which is what
 * makes the offline grind impossible. */
export function crossDomainCommitment(party: CrossDomainParty, salt: string): string {
	return crypto.createHash("sha256").update(crossDomainCommitmentPreimage(party, salt)).digest("base64");
}

/** True iff `commitment` is the commitment a side would have produced for these
 * revealed keys+ids+salt. A reveal whose values do not reproduce the earlier commitment
 * is rejected (the commit-reveal binding). */
export function verifyCrossDomainCommitment(commitment: string, party: CrossDomainParty, salt: string): boolean {
	return crossDomainCommitment(party, salt) === commitment;
}

////////////////////////////////
//  SAS

// Displayed safety code width, shown as two groups of three. Six digits keeps the
// post-commitment online-guess space negligible (1-in-10^6) while staying easy to compare;
// the commitment closes the offline grind, the width bounds only the residual.
const SAS_DIGITS = 6;

// 10^6, the modulus the digest reduces to. A BigInt because the digest value `n` it reduces
// is a BigInt (the 8 digest bytes reach ~1.8e19), so the modulo runs in BigInt space.
const SAS_MODULUS = 1_000_000n;

/** The canonical SAS preimage: the literal `SAS_V1`, then BOTH sides' five identity fields
 * SORTED lexicographically, then the pin - all newline-joined.
 *
 * The flat sort makes the result order-independent: each side holds the same ten fields
 * (its own five + the peer's five) and sorts to the same sequence regardless of side. base64
 * keys and slug ids contain no newline, so fields never merge ambiguously. Substituting any
 * committed key or mislabeling either id changes the sorted sequence and the SAS, which is
 * what makes it the residual MITM detector once the commitment closes the grind. */
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

/**
 * Reduce a SAS preimage to the displayed code, the common kernel shared by every SAS
 * derivation (cross-Domain and enroll); the per-derivation preimage builders stay specialized
 * as the audit surface. The Kotlin twin's reduceToSas mirrors this exactly, pinned by the
 * cross-runtime vectors.
 *
 *   1. digest = SHA-256(preimage)                 (32 bytes)
 *   2. n      = digest[0..7] as a big-endian unsigned BigInt
 *   3. code   = (n mod 10^6) zero-padded to 6 digits
 *
 * Eight bytes (max ~1.8e19) far exceed 10^6, so the modulus bounds the value to exactly 6
 * digits with a near-uniform distribution; the fixed width lets the two phones compare
 * equal-length strings. */
function reduceToSas(preimage: Buffer): string {
	const buf = crypto.createHash("sha256").update(preimage).digest();
	let n = 0n;
	for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(buf[i]);
	return (n % SAS_MODULUS).toString(10).padStart(SAS_DIGITS, "0");
}

export function crossDomainSas(a: CrossDomainParty, b: CrossDomainParty, pin: string): string {
	return reduceToSas(crossDomainSasPreimage(a, b, pin));
}

////////////////////////////////
//  Enroll SAS (owner-anchored, role-tagged) - the in-person admin<->enrollee compare
//
//  The enroll ceremony confirms two OWNERS' keys (the admin who showed the QR and the enrollee
//  who scanned it), brokered by an untrusted Router. It does NOT reuse the gateway crossDomainSas:
//  the enrollee has no gateway, so the binding is over OWNER keys (ownerSignPub + ownerBoxPub +
//  domainId), never gateway keys. Two load-bearing differences, both because the Router is untrusted:
//
//  - FIXED-SLOT, ROLE-TAGGED preimage (not a flat lexicographic sort). Each owner's three
//    fields sit in a labelled ADMIN / ENROLLEE block at a fixed position, so a field-role swap
//    changes the code - the SAS is injective by construction, not merely saved by the
//    commitment. Role is unambiguous offline: the phone that SHOWED the QR is ADMIN, the one
//    that SCANNED is ENROLLEE.
//  - The pin rides in the QR (out of band) and is folded in here but NEVER sent to the Router, so
//    the Router cannot compute a candidate code to grind.
//
//  The 6-digit reduction and the hiding salted commitment are the SAME as the gateway SAS;
//  only the preimage shape and the version literals (ENROLL_SAS_V1 / ENROLL_COMMIT_V1) differ,
//  so an enroll code and a gateway code are never interchangeable. The Android SasCrypto.kt
//  twin mirrors these byte-for-byte, pinned by tests/fixtures/enroll-sas/vectors.json.

/** One owner side of an enroll handshake: the owner root signing key, the owner box key
 * (the seal anchor for owner-to-owner trust), and the Domain id. No gateway fields - the
 * enrollee is gateway-less at enroll time. */
export interface EnrollParty {
	ownerSignPub: string;
	ownerBoxPub: string;
	domainId: string;
}

/** This side's role in the ceremony: ADMIN showed the QR, ENROLLEE scanned it. The role is
 * known from the physical act (not from the Router), and tags the party's slot in both the
 * commitment and the SAS so the two blocks can never be transposed. */
export type EnrollRole = "ADMIN" | "ENROLLEE";

/** The canonical enroll commitment preimage for ONE side: the literal `ENROLL_COMMIT_V1`,
 * the side's role tag, its three owner fields in fixed order, then its random salt - all
 * newline-joined. The salt hides the (public) keys so the commitment is binding without
 * being guessable. The peer re-derives this from the revealed party + role + salt and aborts
 * on a mismatch. */
export function enrollCommitmentPreimage(party: EnrollParty, role: EnrollRole, salt: string): Buffer {
	return Buffer.from(
		[SIGNING_TAGS.enrollCommit, role, party.ownerSignPub, party.ownerBoxPub, party.domainId, salt].join("\n"),
		"utf8",
	);
}

/** A side's hiding commitment to its own owner keys + role: SHA-256 of the canonical
 * commitment preimage, base64. Sent in round 1 before either side reveals; the peer verifies
 * it against the round-2 reveal, which is what forces an untrusted Router to commit any
 * substitution before it learns the real peer key. */
export function enrollCommitment(party: EnrollParty, role: EnrollRole, salt: string): string {
	return crypto
		.createHash("sha256")
		.update(enrollCommitmentPreimage(party, role, salt))
		.digest("base64");
}

/** True iff `commitment` is the commitment a side would have produced for this revealed
 * party + role + salt. A reveal whose values do not reproduce the earlier commitment is
 * rejected (the commit-reveal binding). */
export function verifyEnrollCommitment(
	commitment: string,
	party: EnrollParty,
	role: EnrollRole,
	salt: string,
): boolean {
	return enrollCommitment(party, role, salt) === commitment;
}

/** The canonical enroll SAS preimage: the literal `ENROLL_SAS_V1`, then the ADMIN block
 * (its three owner fields), then the ENROLLEE block, then the pin - all newline-joined in
 * FIXED order. Both phones assemble the identical preimage (each knows which side is ADMIN
 * from showing vs scanning the QR), so the symmetric code matches when no substitution
 * occurred. base64 keys, slug domainIds, the fixed role literals, and a base64 pin contain
 * no newline, so the join is unambiguous. */
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

/** The displayed 6-digit enroll safety code, computed identically to crossDomainSas (SHA-256
 * the preimage, first 8 digest bytes as a big-endian BigInt, mod 10^6, zero-pad to 6) but over
 * the owner-anchored role-tagged preimage. Computed PHONE-SIDE only (the Router never computes it);
 * the two humans compare the two phones' codes in person. */
export function enrollSas(admin: EnrollParty, enrollee: EnrollParty, pin: string): string {
	return reduceToSas(enrollSasPreimage(admin, enrollee, pin));
}
