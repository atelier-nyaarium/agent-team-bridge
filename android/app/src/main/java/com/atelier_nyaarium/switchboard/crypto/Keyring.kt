package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import kotlinx.serialization.json.Json

/**
 * The owner-rooted keyring: the mirrored DomainSnapshot the Console resolves peers
 * against. Every member the Console seals to is resolved here first, so it trusts a
 * Gateway because the owner admitted that Gateway's keys, never because a provisioning
 * blob named them. This is the device side of the symmetric-trust rule and the Kotlin
 * counterpart of resolveAdmitted in src/shared/admission.ts, additionally keyed by
 * Gateway id for the multi-gateway seal path (the Console knows a target by its Gateway id,
 * not its signing key).
 */
class Keyring(val snapshot: DomainSnapshot) {
	val ownerSignPub: String get() = snapshot.ownerSignPub

	/** The newest owner-verified, non-revoked kind:gateway admission for gatewayId, or
	 * null when no such Gateway is admitted. Its boxPub is the seal recipient; its
	 * signPub verifies that Gateway's sealed replies. */
	fun resolveGateway(gatewayId: String): Admission? =
		resolve { it.kind == "gateway" && it.gatewayId == gatewayId }

	/** The admission for a subject signing key, owner-verified and non-revoked. */
	fun resolveSubject(signPubB64: String): Admission? = resolve { it.signPub == signPubB64 }

	private fun resolve(match: (Admission) -> Boolean): Admission? {
		var best: SignedAdmission? = null
		for (s in snapshot.admissions) {
			if (!match(s.admission)) continue
			if (!AdmissionCrypto.verifyAdmission(s, snapshot.ownerSignPub)) continue
			if (best == null || s.admission.issuedAt > best.admission.issuedAt) best = s
		}
		val winner = best ?: return null
		if (isRevoked(winner.admission.signPub, winner.admission.issuedAt)) return null
		return winner.admission
	}

	private fun isRevoked(signPubB64: String, admittedAt: Long): Boolean {
		for (r in snapshot.revocations) {
			if (r.revocation.signPub != signPubB64) continue
			if (!AdmissionCrypto.verifyRevocation(r, snapshot.ownerSignPub)) continue
			// A revocation at or after the admission revokes it.
			if (r.revocation.issuedAt >= admittedAt) return true
		}
		return false
	}

	companion object {
		private val json = Json { ignoreUnknownKeys = true }

		/** An owner-only keyring with no members yet - the state right after the owner
		 * roots the Domain and before it admits any Gateway. */
		fun empty(ownerSignPub: String): Keyring =
			Keyring(DomainSnapshot(ownerSignPub = ownerSignPub, admissions = emptyList(), revocations = emptyList()))

		/** Parse a stored snapshot, or null when the JSON is absent / unparseable. */
		fun parse(snapshotJson: String?): Keyring? =
			snapshotJson?.let {
				runCatching { Keyring(json.decodeFromString(DomainSnapshot.serializer(), it)) }.getOrNull()
			}
	}
}

/** The canonical form of a Domain snapshot. Admissions and revocations are append-only
 * owner-signed facts, so they are deduped by signing key + nonce and ordered by issue time.
 * Every snapshot merge (a sync from a Gateway, or a local admit/revoke folded in before evie
 * rebroadcasts it) routes through here, so the same set of facts always yields identical
 * bytes and resolve() sees each fact exactly once. */
internal fun canonicalSnapshot(
	ownerSignPub: String,
	admissions: List<SignedAdmission>,
	revocations: List<SignedRevocation>,
): DomainSnapshot =
	DomainSnapshot(
		ownerSignPub = ownerSignPub,
		admissions = admissions.distinctBy { "${it.admission.signPub}:${it.admission.nonce}" }.sortedBy { it.admission.issuedAt },
		revocations = revocations.distinctBy { "${it.revocation.signPub}:${it.revocation.nonce}" }.sortedBy { it.revocation.issuedAt },
	)
