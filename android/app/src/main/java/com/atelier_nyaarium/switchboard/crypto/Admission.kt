package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.Revocation
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import com.atelier_nyaarium.switchboard.proto.Protocol

/**
 * Owner-signed admission / revocation, the byte-exact Kotlin counterpart of
 * switchboard's `src/shared/admission.ts`. The owner device (this console) signs
 * admissions that Hosts and the Router verify, so the canonical signing bytes - a
 * versioned, newline-joined, fixed-order encoding - must reproduce exactly. The
 * cross-platform vector in AdmissionTest pins it. Never sign raw JSON.
 */
object AdmissionCrypto {
	fun admissionSigningBytes(a: Admission): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_ADMISSION, a.kind, a.signPub, a.boxPub, a.gatewayId ?: "", a.issuedAt.toString(), a.nonce)
			.joinToString("\n")
			.toByteArray(Charsets.UTF_8)

	fun revocationSigningBytes(r: Revocation): ByteArray =
		listOf(Protocol.Wire.SIGNING_TAG_REVOCATION, r.signPub, r.issuedAt.toString(), r.nonce).joinToString("\n").toByteArray(Charsets.UTF_8)

	fun signAdmission(admission: Admission, ownerSignPriv: String, ownerSignPub: String): SignedAdmission =
		SignedAdmission(
			admission = admission,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(admissionSigningBytes(admission), ownerSignPriv),
		)

	fun signRevocation(revocation: Revocation, ownerSignPriv: String, ownerSignPub: String): SignedRevocation =
		SignedRevocation(
			revocation = revocation,
			ownerSignPub = ownerSignPub,
			signature = Crypto.sign(revocationSigningBytes(revocation), ownerSignPriv),
		)

	fun verifyAdmission(s: SignedAdmission, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub && Crypto.verify(admissionSigningBytes(s.admission), s.signature, expectedOwnerSignPub)

	fun verifyRevocation(s: SignedRevocation, expectedOwnerSignPub: String): Boolean =
		s.ownerSignPub == expectedOwnerSignPub &&
			Crypto.verify(revocationSigningBytes(s.revocation), s.signature, expectedOwnerSignPub)
}
