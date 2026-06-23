import crypto from "node:crypto";

////////////////////////////////
//  Cross-Domain pairing SAS + commitment (commit-reveal SAS-AKE)
//
//  The cross-Domain listening-mode handshake (cross-domain-federation.md) is an
//  unauthenticated key exchange between two owners' Gateways relayed by the
//  content-blind Router. A bare SAS over only the public keys + the pin is offline
//  grindable: a malicious Router substitutes its own keys on BOTH legs and searches
//  for a key set that yields the SAME short code on the two phones, defeating the
//  out-of-band compare. The fix is commit-then-reveal: each side publishes a HIDING
//  commitment to its own keys+ids BEFORE either side reveals them, so the Router can
//  no longer grind (it must pick its substituted keys before it learns the peer's,
//  collapsing the attack to a single online 1-in-10^6 guess bounded by the attempt
//  cap). The SAS then binds the COMMITTED keys + both sides' ids + the pin.
//
//  Two primitives live here:
//  - crossDomainCommitment: the hiding commitment a side sends first (SHA-256 over
//    its own keys + ids + a random salt). The peer re-derives it after the reveal and
//    aborts if it does not match what was committed.
//  - crossDomainSas: the safety code over the COMMITTED keys + both ids + the pin, the
//    code the humans compare out of band.
//
//  switchboard-only, NOT a SYNC-HASH leaf: the Router never computes either value
//  (content-blind), and the keys/pin are phone-held + gateway-carried. The Android Kotlin
//  twin (SasCrypto.kt) hand-authors the SAME formulas and is pinned
//  against this reference by tests/fixtures/cross-domain-sas/vectors.json, exactly as
//  SessionId.kt is pinned by the session-id vectors. Because the twin must reproduce
//  these byte-for-byte under BouncyCastle, the derivation uses ONLY SHA-256 + big-endian
//  BigInt math (no language-specific quirks): see crossDomainSas below.

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
			"SAS_COMMIT_V1",
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

// The displayed safety code is this many decimal digits, shown as two groups of three.
// The code is a yes/no COMPARE, so its ceiling is human rubber-stamping (which rises with
// length), not the crypto residual: six digits is the shortest width that keeps the
// post-commitment online-guess space negligible (1-in-10^6) while staying easy to compare
// faithfully. The commitment closes the offline grind; the width bounds only the residual.
const SAS_DIGITS = 6;

// 10^6, the modulus the digest reduces to. A BigInt because the digest value `n` it reduces
// is a BigInt (the 8 digest bytes reach ~1.8e19), so the modulo runs in BigInt space.
const SAS_MODULUS = 1_000_000n;

/** The canonical SAS preimage: the literal `SAS_V1`, then BOTH sides' five identity
 * fields SORTED lexicographically by their string value, then the pin - all
 * newline-joined.
 *
 * The fields are sorted as a flat list so the result is order-independent: each side
 * holds the same ten identity fields (its own five + the peer's five) and sorts them to
 * the same sequence regardless of which side it is. base64 keys and slug ids contain no
 * newline, so the joined fields can never merge ambiguously. Substituting ANY committed
 * key or mislabeling either id changes the sorted sequence and therefore the SAS, which
 * is what makes it the residual MITM detector once the commitment closes the grind. */
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
	return Buffer.from(["SAS_V1", ...fields, pin].join("\n"), "utf8");
}

/** The displayed safety code: SHA-256 the canonical preimage, read the FIRST 8 digest
 * bytes as a big-endian unsigned BigInt, reduce mod 10^6, and zero-pad to 6 decimal
 * digits (displayed as two groups of three).
 *
 * Derivation (the Kotlin twin must mirror exactly):
 *   1. preimage = crossDomainSasPreimage(a, b, pin)   (UTF-8 bytes)
 *   2. digest   = SHA-256(preimage)                   (32 bytes)
 *   3. n        = digest[0..7] as a big-endian unsigned BigInt
 *   4. code     = (n mod 10^6) zero-padded to 6 digits
 *
 * Eight bytes (a 64-bit value, max ~1.8e19) comfortably exceed 10^6, so the modulus is
 * load-bearing: it bounds the value to exactly 6 digits with a near-uniform
 * distribution. Width is fixed at 6 so the two phones compare equal-length strings. */
export function crossDomainSas(a: CrossDomainParty, b: CrossDomainParty, pin: string): string {
	const buf = crypto
		.createHash("sha256")
		.update(crossDomainSasPreimage(a, b, pin))
		.digest();
	let n = 0n;
	for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(buf[i]);
	return (n % SAS_MODULUS).toString(10).padStart(SAS_DIGITS, "0");
}

////////////////////////////////
//  Enroll SAS (owner-anchored, role-tagged) - the in-person admin<->enrollee compare
//
//  The FLOW-1 enroll ceremony confirms two OWNERS' keys (the admin who showed the QR and
//  the fresh enrollee who scanned it), brokered by an UNTRUSTED evie. It does NOT reuse the
//  gateway crossDomainSas above: the enrollee has no gateway, so the binding is over OWNER
//  keys (ownerSignPub + ownerBoxPub + domainId), never gateway keys. Two structural
//  differences from the gateway SAS, both load-bearing because evie is untrusted here:
//
//  - FIXED-SLOT, ROLE-TAGGED preimage (not the gateway's flat lexicographic sort). Each
//    owner's three fields sit in a labelled ADMIN / ENROLLEE block in a fixed position, so a
//    field-role swap (e.g. presenting ownerBoxPub in the ownerSignPub slot) changes the
//    preimage and the code - the SAS is injective by construction, not merely saved by the
//    commitment. Role is unambiguous offline: the phone that SHOWED the QR is ADMIN, the one
//    that SCANNED is ENROLLEE, so both derive the same block assignment without trusting evie.
//  - The `pin` rides in the QR (out of band) and is folded in here but NEVER sent to evie, so
//    evie cannot even compute a candidate code to grind.
//
//  The 6-digit reduction (SHA-256 -> first 8 bytes big-endian -> mod 10^6 -> zero-pad 6) and
//  the hiding salted commitment are the SAME as the gateway SAS; only the preimage shape and
//  the version literals (ENROLL_SAS_V1 / ENROLL_COMMIT_V1) differ, so an enroll code and a
//  gateway code are never interchangeable. The Android SasCrypto.kt twin mirrors these
//  byte-for-byte, pinned by tests/fixtures/enroll-sas/vectors.json.

/** One owner side of an enroll handshake: the owner root signing key, the owner box key
 * (the seal anchor for owner-to-owner trust), and the Domain id. No gateway fields - the
 * enrollee is gateway-less at enroll time. */
export interface EnrollParty {
	ownerSignPub: string;
	ownerBoxPub: string;
	domainId: string;
}

/** This side's role in the ceremony: ADMIN showed the QR, ENROLLEE scanned it. The role is
 * known from the physical act (not from evie), and tags the party's slot in both the
 * commitment and the SAS so the two blocks can never be transposed. */
export type EnrollRole = "ADMIN" | "ENROLLEE";

/** The canonical enroll commitment preimage for ONE side: the literal `ENROLL_COMMIT_V1`,
 * the side's role tag, its three owner fields in fixed order, then its random salt - all
 * newline-joined. The salt hides the (public) keys so the commitment is binding without
 * being guessable. The peer re-derives this from the revealed party + role + salt and aborts
 * on a mismatch. */
export function enrollCommitmentPreimage(party: EnrollParty, role: EnrollRole, salt: string): Buffer {
	return Buffer.from(
		["ENROLL_COMMIT_V1", role, party.ownerSignPub, party.ownerBoxPub, party.domainId, salt].join("\n"),
		"utf8",
	);
}

/** A side's hiding commitment to its own owner keys + role: SHA-256 of the canonical
 * commitment preimage, base64. Sent in round 1 before either side reveals; the peer verifies
 * it against the round-2 reveal, which is what forces an untrusted evie to commit any
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
			"ENROLL_SAS_V1",
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
 * the owner-anchored role-tagged preimage. Computed PHONE-SIDE only (evie never computes it);
 * the two humans compare the two phones' codes in person. */
export function enrollSas(admin: EnrollParty, enrollee: EnrollParty, pin: string): string {
	const buf = crypto
		.createHash("sha256")
		.update(enrollSasPreimage(admin, enrollee, pin))
		.digest();
	let n = 0n;
	for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(buf[i]);
	return (n % SAS_MODULUS).toString(10).padStart(SAS_DIGITS, "0");
}
