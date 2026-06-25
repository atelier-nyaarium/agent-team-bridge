package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult

/**
 * Pure helpers for the cross-Domain link pairing UI: the active SAS type-to-match check and
 * the receiver/requester role state. Kept Android-free so a JVM unit test pins the compare
 * (the security-critical "Confirm unlocks ONLY on an exact local match" rule) and the digit
 * normalization without a device.
 */

////////////////////////////////
//  Interfaces & Types

/** Which side of the pairing this phone is driving. The receiver opens a listening window and
 * waits; the requester enters the friend's code and runs the exchange. */
enum class LinkRole {
	RECEIVER,
	REQUESTER,
}

/** The pairing wizard's step, a linear progression with terminal error/done states. The UI
 * renders one panel per step; an error step carries a human reason. */
sealed interface LinkStep {
	/** Pick a role / show this phone's listening code or enter the friend's. */
	data object Rendezvous : LinkStep

	/** Both phones computed the SAS; the human types the friend's code to confirm. */
	data class Verify(val mySas: String) : LinkStep

	/** The link was written on both sides AND the Router authorized the relay edge. */
	data object Done : LinkStep

	/** The local peer was written, but the Router rejected the relay-affinity edge, so a
	 * cross-Domain send to this peer would be DENIED. Distinct from Done so the false "Linked" is
	 * never shown; carries the peer Domain so Retry re-submits ONLY the edge (no unlink+relink). */
	data class LinkedNoRelay(val peerDomainId: String) : LinkStep

	/** A terminal failure (cap exceeded, mismatch, window expired, transport). */
	data class Failed(val reason: String) : LinkStep
}

/** The outcome of a confirm where the local peer write SUCCEEDED. The edge submit to the Router is
 * a separate step that returns false (not throws) on a Router rejection; this distinguishes the two
 * so the wizard surfaces a relay-edge failure as a recoverable "linked locally, retry the relay"
 * rather than a false "Linked". A confirm whose local peer write itself failed never reaches here
 * (it surfaces as a Result.failure / Failed step). */
sealed interface ConfirmOutcome {
	/** Local peer written and the Router authorized the relay edge: fully linked. */
	data object Linked : ConfirmOutcome

	/** Local peer written, but the Router rejected the relay edge: the peer is linked locally yet
	 * cross-Domain sends to it stay denied until the edge submit succeeds. Carries the peer Domain
	 * for the one-tap edge-only retry. */
	data class RelayEdgeRejected(val peerDomainId: String) : ConfirmOutcome
}

////////////////////////////////
//  Functions & Helpers

object CrossDomainLink {
	/** A 6-digit SAS, the width SasCrypto emits. The UI rejects a typed code of any other
	 * length before comparing, so a partial entry never spuriously matches. */
	const val SAS_DIGITS = 6

	/** Keep only the decimal digits of a human-typed code, so spaces / grouping the human added
	 * while reading the code aloud ("847 291") do not defeat the exact compare. */
	fun normalizeTypedSas(typed: String): String = typed.filter { it.isDigit() }

	/** True iff the typed code, once stripped of grouping, is exactly the expected SAS. This is
	 * the anti-MITM gate: the human types what the friend reads aloud, and Confirm unlocks ONLY
	 * on an exact local match (a substituted key yields a different SAS, so the match fails).
	 * A blank or wrong-length entry never matches. */
	fun sasMatches(expectedSas: String, typed: String): Boolean {
		val normalized = normalizeTypedSas(typed)
		if (normalized.length != SAS_DIGITS) return false
		return normalized == expectedSas
	}

	/** The SAS to display + compare on the requester side: exactly what the Gateway returned
	 * (it already cross-checked it against its local recompute, refusing a substituted code). */
	fun requesterSas(result: CrossDomainRequestResult): String = result.sas

	/** Build the Federation PEERS roster by UNIONing the gateway's cross-Domain peer set
	 * (`peerDomains`, from cross_domain_list_peers) with the Domains discovery already surfaced
	 * (`teams` tagged with a non-home domainId). A peer is listed the moment it is linked, so a
	 * freshly-linked peer with no discovery sessions still appears (and its detail is reachable to
	 * start sharing) - the gap that otherwise dead-locked the post-link flow. Discovery supplies the
	 * session count + presence; a peer present ONLY in the peer set shows zero sessions / offline.
	 * The home Domain is excluded from both inputs. Sorted by domainId for a stable list. */
	fun mergeLinkedDomains(teams: List<Team>, peerOwners: Map<String, String>, home: String): List<LinkedDomain> {
		val byDomain = teams
			.filter { !it.domainId.isNullOrEmpty() && it.domainId != home }
			.groupBy { it.domainId!! }
		val domains = byDomain.keys + peerOwners.keys.filter { it != home }
		return domains
			.map { domainId ->
				val sessions = byDomain[domainId].orEmpty()
				LinkedDomain(
					domainId = domainId,
					// The friend's self-set network name, propagated over discovery (the gateway stamps
					// each shared session's displayName). First non-empty wins; null until any session
					// carries one, in which case the UI falls back to the opaque domainId.
					displayName = sessions.firstNotNullOfOrNull { it.displayName?.ifEmpty { null } },
					sessionCount = sessions.size,
					online = sessions.any { it.status == "online" },
					// The owner from the cross-Domain peer set; null for a discovery-only Domain.
					ownerSignPub = peerOwners[domainId],
				)
			}
			.sortedBy { it.displayName ?: it.domainId }
	}
}
