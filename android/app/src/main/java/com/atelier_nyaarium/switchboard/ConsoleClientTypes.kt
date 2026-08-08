package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeRef
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import com.atelier_nyaarium.switchboard.proto.RosterRequest
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.TransportRequest
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import com.atelier_nyaarium.switchboard.proto.TrustPendingRequest
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

////////////////////////////////
//  Interfaces & Types

/**
 * Credential blob the console holds. Reaches the console bridge through the k8s API
 * service-proxy: the SA token authenticates to the API server, the app token (a separate
 * forwarded header) authenticates to evie.
 *
 * Thin wrapper over the generated proto.Provisioning wire shape, adding the runtime
 * behavior a schema cannot express: device defaulting to Build.MODEL, conversationId
 * minting a UUID, trailing-slash URL normalization, the service-proxy defaults.
 */
data class Provisioning(
	val apiUrl: String,
	val caPem: String,
	val saToken: String,
	val appToken: String,
	val namespace: String,
	val service: String,
	val port: Int,
	val device: String,
	val conversationId: String,
	/** Present on a friend invite blob: the pending Domain id + one-time invite nonce the app
	 * first-roots with. Its presence is what distinguishes an invite from an already-rooted admin blob. */
	val pendingTenant: PendingTenantRef? = null,
	/** Present alongside pendingTenant on an enroll invite: the admin's owner keys + Domain and the
	 * handshakeId + pin seeding the in-person trust compare. The enrollee reads it after first-rooting
	 * to run the ceremony as enrollee. */
	val enrollHandshake: EnrollHandshakeRef? = null,
	/** evie's public nonce-gated device-approval ingress. A held device stamps it into the
	 * authorize-console QR so a fresh device can reach evie with no creds; absent means this network
	 * has no public ingress and the Add-a-device entry is disabled. */
	val deviceApprovalReach: String? = null,
) {
	companion object {
		fun parse(blob: String): Provisioning {
			val p = wireJson.decodeFromString<com.atelier_nyaarium.switchboard.proto.Provisioning>(blob)
			return Provisioning(
				apiUrl = p.apiUrl.trimEnd('/'),
				caPem = p.caPem,
				saToken = p.saToken,
				appToken = p.appToken ?: "",
				namespace = p.namespace ?: "evie-bot",
				service = p.service ?: "evie-console-bridge",
				port = p.port?.toInt() ?: 20004,
				device = p.device ?: (android.os.Build.MODEL ?: "android"),
				conversationId = p.conversationId ?: UUID.randomUUID().toString(),
				pendingTenant = p.pendingTenant,
				enrollHandshake = p.enrollHandshake,
				deviceApprovalReach = p.deviceApprovalReach?.trimEnd('/'),
			)
		}
	}
}

data class SendResult(val ok: Boolean, val status: String, val error: String?)

/** The owner enroll envelope: `enrollOp` (not `op`) routes to evie's enrollment coordinator,
 * which answers an EnrollResult directly instead of relaying to a Gateway. */
@Serializable
internal data class EnrollEnvelope(
	val device: String,
	val conversationId: String,
	val opId: String,
	val enrollOp: EnrollOp,
)

/** A retryable bounce body (offline / malformed), distinct from an EnrollResult. */
@Serializable
// internal (not private): referenced from postEvieDirect, an internal inline fun - an inline
// function's body cannot access a private-in-file type even from the same file (the compiler
// treats inlining as a visibility-widening operation). Same bug class as ConsoleClient's own
// PINNED_*/HELD_*/PROXY_CEILING_MS companion constants; see their comment for the general rule.
internal data class BounceBody(val error: String? = null, val retryable: Boolean = false)

/** First-root POST body: a top-level `firstRoot` field routes to evie's console-bridge
 * firstRoot intake, decided at evie and never relayed to a Gateway. */
@Serializable
internal data class FirstRootEnvelope(val firstRoot: SignedFirstRoot)

/** Enroll-handshake POST body: a top-level `enrollHandshake` field routes to evie's
 * console-bridge enroll-handshake broker, a dumb relay never sent to a Gateway. */
@Serializable
internal data class EnrollHandshakeEnvelope(val enrollHandshake: EnrollHandshakeOp)

/** Roster POST body: a top-level `roster` field routes to evie's cross-tenant roster handler,
 * which aggregates across Domains a gateway cannot see and answers itself. */
@Serializable
internal data class RosterEnvelope(val roster: RosterRequest)

/** Transport-request POST body: a top-level `transport` field routes to evie's console-bridge
 * transport intake, which holds the gateway-bridge Secret and answers itself. */
@Serializable
internal data class TransportEnvelope(val transport: TransportRequest)

/** Device-approval POST body for the AUTHENTICATED held device: a top-level `consoleApproval` field
 * routes to evie's console-bridge device-approval coordinator (arm/poll/approve/cancel). The public
 * join/fetch steps go to the credential-less ingress instead (see postPublicApproval). */
@Serializable
internal data class ConsoleApprovalEnvelope(val consoleApproval: ConsoleApprovalOp)

/** Trust-rendezvous POST bodies: top-level fields routing to evie's trust broker and pending query. */
@Serializable
internal data class TrustHandshakeEnvelope(val trustHandshake: TrustHandshakeOp)

@Serializable
internal data class TrustPendingEnvelope(val trustPending: TrustPendingRequest)

/** evie's reply to a provision_tenant enroll op. Mirrors EnrollResult but also carries the minted
 * one-time invite `nonce` the admin's app builds the friend's QR from. The wire EnrollResult schema
 * omits `nonce`, so this is a richer local decode. */
@Serializable
data class ProvisionTenantResult(val ok: Boolean, val error: String? = null, val nonce: String? = null)

/** Decode tolerates unknown fields (additive protocol). Encode omits null-defaulted optionals,
 * which is what the gateway's schemas accept. */
internal val wireJson = Json { ignoreUnknownKeys = true }

/** The gateway's marker for a decision that will never apply, as opposed to a failure that might
 * succeed later. Mirrors the prefix consoleHandler.ts stamps on a refusal. */
const val BOARD_REFUSED_PREFIX = "refused:"

/** A board op the gateway itself decided will never apply. The ONE outcome that retires a queued
 * action; every other failure retries. */
class BoardRefused(val reason: String) : Exception(reason)

////////////////////////////////
//  Functions & Helpers

/** Map a Crypto.SealedEnvelope to the proto.SealedEnvelope wire type. Fields are identical by
 * design; the mapper avoids coupling the two class hierarchies. */
internal fun Crypto.SealedEnvelope.toProto(): SealedEnvelope =
	SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

/** Map a proto.SealedEnvelope to Crypto.SealedEnvelope for unseal calls. */
internal fun SealedEnvelope.toCrypto(): Crypto.SealedEnvelope =
	Crypto.SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)
