package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult

/**
 * Pure helpers for the cross-Domain link pairing UI: the SAS type-to-match check and the
 * receiver/requester role state. Kept Android-free so a JVM unit test can pin the compare
 * (the "Confirm unlocks only on an exact local match" rule) and digit normalization.
 */

////////////////////////////////
//  Interfaces & Types

/** Which side of the pairing this phone drives. The receiver listens; the requester enters the
 * friend's code and runs the exchange. */
enum class LinkRole {
	RECEIVER,
	REQUESTER,
}

/** The pairing wizard's step. The UI renders one panel per step. */
sealed interface LinkStep {
	/** Pick a role / show this phone's listening code or enter the friend's. */
	data object Rendezvous : LinkStep

	/** Both phones computed the SAS; the human types the friend's code to confirm. */
	data class Verify(val mySas: String) : LinkStep

	/** The link was written on both sides AND the Router authorized the relay edge. */
	data object Done : LinkStep

	/** The local peer was written, but the Router rejected the relay-affinity edge, so a
	 * cross-Domain send to this peer would be denied. Distinct from Done so a false "Linked" is
	 * never shown; carries the peer Domain so Retry re-submits only the edge (no unlink+relink). */
	data class LinkedNoRelay(val peerDomainId: String) : LinkStep

	/** A terminal failure (cap exceeded, mismatch, window expired, transport). */
	data class Failed(val reason: String) : LinkStep
}

/** The outcome of a confirm where the local peer write succeeded. The edge submit to the Router
 * returns false (not throws) on a rejection, so this distinguishes a recoverable "linked locally,
 * retry the relay" from a full "Linked". A confirm whose local peer write failed never reaches here
 * (it surfaces as a Result.failure / Failed step). */
sealed interface ConfirmOutcome {
	/** Local peer written and the Router authorized the relay edge. */
	data object Linked : ConfirmOutcome

	/** Local peer written, but the Router rejected the relay edge, so cross-Domain sends to the peer
	 * stay denied until the edge submit succeeds. Carries the peer Domain for the edge-only retry. */
	data class RelayEdgeRejected(val peerDomainId: String) : ConfirmOutcome
}

////////////////////////////////
//  Functions & Helpers

object CrossDomainLink {
	/** The SAS width SasCrypto emits. A typed code of any other length is rejected before
	 * comparing, so a partial entry never spuriously matches. */
	const val SAS_DIGITS = 6

	/** Keep only the decimal digits, so grouping a human added while reading the code aloud
	 * ("847 291") does not defeat the exact compare. */
	fun normalizeTypedSas(typed: String): String = typed.filter { it.isDigit() }

	/** True iff the typed code, once stripped of grouping, is exactly the expected SAS. This is
	 * the anti-MITM gate: a substituted key yields a different SAS, so the match fails. A blank or
	 * wrong-length entry never matches. */
	fun sasMatches(expectedSas: String, typed: String): Boolean {
		val normalized = normalizeTypedSas(typed)
		if (normalized.length != SAS_DIGITS) return false
		return normalized == expectedSas
	}

	/** The SAS to display and compare on the requester side: exactly what the Gateway returned
	 * (it already cross-checked it against its local recompute, refusing a substituted code). */
	fun requesterSas(result: CrossDomainRequestResult): String = result.sas

	/** Build the Federation peers roster by unioning the gateway's cross-Domain peer set
	 * (from cross_domain_list_peers) with the Domains discovery already surfaced (teams tagged
	 * with a non-local domainId). A peer is listed the moment it is linked, so a freshly-linked
	 * peer with no discovery sessions still appears and its detail is reachable. Discovery supplies
	 * the session count and presence; a peer present only in the peer set shows zero sessions and
	 * offline. The admin Domain is excluded from both inputs. Sorted for a stable list. */
	fun mergeLinkedDomains(teams: List<Team>, peerOwners: Map<String, String>, adminDomain: String): List<LinkedDomain> {
		val byDomain = teams
			.filter { !it.domainId.isNullOrEmpty() && it.domainId != adminDomain }
			.groupBy { it.domainId!! }
		val domains = byDomain.keys + peerOwners.keys.filter { it != adminDomain }
		return domains
			.map { domainId ->
				val sessions = byDomain[domainId].orEmpty()
				LinkedDomain(
					domainId = domainId,
					// The friend's self-set display name, propagated over discovery. First non-empty
					// wins; null until a session carries one, where the UI falls back to the domainId.
					displayName = sessions.firstNotNullOfOrNull { it.displayName?.ifEmpty { null } },
					sessionCount = sessions.size,
					online = sessions.any { it.status == "online" },
					// Null for a discovery-only Domain.
					ownerSignPub = peerOwners[domainId],
				)
			}
			.sortedBy { it.displayName ?: it.domainId }
	}
}
