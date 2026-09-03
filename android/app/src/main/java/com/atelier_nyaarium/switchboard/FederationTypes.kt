package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope

////////////////////////////////
//  Interfaces & Types

/** A scanned admit-gateway QR: the Gateway identity the owner is about to admit, plus the optional
 * LAN target and one-time nonce for delivering the sealed bootstrap bundle. */
data class ScannedGateway(
	val gatewayId: String,
	val signPub: String,
	val boxPub: String,
	val sas: String,
	val lanHost: String? = null,
	val lanPort: Int? = null,
	val nonce: String? = null,
	/** SHA-256 of the gateway's ephemeral enroll TLS leaf. Present means deliver over pinned HTTPS;
	 * absent means paste only, never cleartext. */
	val certFp: String? = null,
)

/** The outcome of enrolling a Gateway, with the sealed bundle to hand-carry when LAN delivery was
 * not possible. */
data class EnrollDelivery(val admitted: Boolean, val message: String, val pasteBundle: String?)

/** A held device's armed "Add a device" window: the rendezvous token, its one-time nonce, and the
 * authorize-console QR text (public material only) the new device scans. */
data class DeviceApprovalArmed(val approvalId: String, val nonce: String, val qr: String)

/** A scanned authorize-console QR on the NEW device. The owner signPub is pinned to verify the
 * sealed reply. */
data class ScannedDeviceApproval(
	val domainId: String,
	val ownerSignPub: String,
	val ownerBoxPub: String,
	val approvalId: String,
	val nonce: String,
	val reach: String,
	/** Pin for the reach, empty when this device holds none. */
	val reachCertFp: String = "",
	val sas: String,
)

/** The console transport a held device seals to a freshly-approved one: the provisioning creds, plus
 * Gateway without holding the owner key. */
@kotlinx.serialization.Serializable
data class ConsoleTransport(
	/** The Router endpoint and the leaf fingerprint pinned against it. */
	val routerUrl: String = "",
	val routerCertFp: String = "",
	val appToken: String,
	val domainId: String? = null,
	val gatewayId: String? = null,
	val domainVersion: String? = null,
	val domain: DomainSnapshot? = null,
	val contentKeys: List<KeyEnvelope> = emptyList(),
)

/** Outcome of "Revoke and Delete Domain". */
sealed class DeleteDomainOutcome {
	/** The Router verified the owner and dropped the slice; local state was wiped. */
	object Deleted : DeleteDomainOutcome()

	/** The Router was unreachable, so local state was wiped but the server-side purge is unconfirmed. */
	object WipedUnconfirmed : DeleteDomainOutcome()

	/** The Router refused. Local state is intact, so the owner key survives for a retry. */
	data class Rejected(val error: String) : DeleteDomainOutcome()
}

/** A linked friend Domain row for the Federation hub. `ownerSignPub` is null for a Domain seen only
 */
data class LinkedDomain(
	val domainId: String,
	val displayName: String?,
	val sessionCount: Int,
	val online: Boolean,
	val ownerSignPub: String?,
)

/** A requester-side pairing in flight: the one-time pin the requester minted, passed back to
 * confirm, and the Gateway's request result. */
data class CrossDomainPairing(val pin: String, val result: CrossDomainRequestResult)

/** A receiver-side pairing learned from a listen-state poll. The pin is absent because the requester
 * minted it; the receiver passes its own listening token, which the gateway resolves to the pin. */
data class CrossDomainReceiverPairing(
	val sas: String,
	val friendOwnerSignPub: String,
	val friendDomainId: String,
	val friendGatewayId: String,
	val friendGatewaySignPub: String,
	val friendGatewayBoxPub: String,
)

////////////////////////////////
//  Functions & Helpers

/** How often each phone re-polls the Router broker during the in-person enroll ceremony. Short,
 * because the peer is on screen beside you. */
internal const val ENROLL_POLL_MS = 2_000L

/** Max poll attempts per handshake round, comfortably under the broker's 10-minute window TTL, so a
 * vanished peer fails with a timeout rather than hanging forever. */
internal const val ENROLL_POLL_MAX = 150

/** FLOW-2 rendezvous sides: who ARMED versus who JOINED. Distinct from the SAS role, which is
 * ordered by sorted owner key. Must match the TrustHandshakeOp.Reveal `side` literals on the wire. */
internal const val TRUST_SIDE_INITIATOR = "INITIATOR"
internal const val TRUST_SIDE_TARGET = "TARGET"
