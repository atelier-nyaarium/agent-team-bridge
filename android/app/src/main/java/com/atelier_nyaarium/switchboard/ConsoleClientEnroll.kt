package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalResult
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeResult
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.RosterRequest
import com.atelier_nyaarium.switchboard.proto.RosterResult
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.TransportRequest
import com.atelier_nyaarium.switchboard.proto.TransportResult
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeResult
import com.atelier_nyaarium.switchboard.proto.TrustPendingRequest
import com.atelier_nyaarium.switchboard.proto.TrustPendingResult
import java.util.UUID
import okhttp3.RequestBody.Companion.toRequestBody

////////////////////////////////
//  Router-direct ops
//
//  Router decides them itself and answers a typed result, so they work before any Gateway is admitted.

/** Submit an owner enroll op directly to the Router (the Domain root). Enroll ops are Router-direct and
 * never posted to a Gateway, so they succeed with no gateway connected; the Router answers an
 * EnrollResult directly. A bounce (offline, 501, malformed) is surfaced as a failed
 * EnrollResult. */
suspend fun ConsoleClient.enroll(op: EnrollOp): EnrollResult {
	val envelope = EnrollEnvelope(transport.credentials.device, transport.credentials.conversationId, UUID.randomUUID().toString(), op)
	return transport.postRouterDirect(
		tag = "Enroll",
		describe = "op=${op::class.simpleName}",
		body = wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { EnrollResult(ok = false, error = it) }
}

/** Drive one device-approval frame (arm/poll/approve/cancel) through the Router's coordinator over the
 * AUTHENTICATED console-bridge. Mirrors enroll()'s envelope + POST: the Router answers a
 * ConsoleApprovalResult directly (200 ok, 400 reject), never posting to a Gateway. The public
 * join/fetch steps must NOT come here - they go to postPublicApproval. */
suspend fun ConsoleClient.postConsoleApproval(op: ConsoleApprovalOp): ConsoleApprovalResult =
	transport.postRouterDirect(
		tag = "DeviceApproval",
		describe = "step=${op::class.simpleName}",
		body = wireJson.encodeToString(ConsoleApprovalEnvelope.serializer(), ConsoleApprovalEnvelope(op)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { ConsoleApprovalResult(ok = false, error = it) }

/** First-root a pending friend Domain at this device's silently-generated owner key. The Router decides
 * it directly from the self-signed frame + one-time invite nonce, with no gateway and no admission, so it
 * works before any Gateway is admitted. It answers an EnrollResult (2xx ok, 400 reject for an expired or
 * already-claimed invite). A reject is not retryable (the root was decided), so the caller surfaces it. */
suspend fun ConsoleClient.firstRoot(signed: SignedFirstRoot): EnrollResult {
	val envelope = FirstRootEnvelope(signed)
	return transport.postRouterDirect(
		tag = "FirstRoot",
		describe = "domain=${signed.firstRoot.domainId}",
		body = wireJson.encodeToString(FirstRootEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { EnrollResult(ok = false, error = it) }
}

/** Pull this owner's network gateway-bridge transport (the proxy SA token + CA) from the Router. POST
 * { transport } Router-direct like firstRoot: the Router holds the gateway-bridge Secret and answers
 * itself, scoping by the request's signed owner proof. ok=false is an opaque reject (bad proof or not a
 * rooted owner); a transport bounce maps to ok=false too. The Console seals the returned creds into a
 * bootstrap bundle for a creds-less Gateway it is enrolling. */
suspend fun ConsoleClient.requestGatewayTransport(req: TransportRequest): TransportResult =
	transport.postRouterDirect(
		tag = "Transport",
		describe = "transport",
		body = wireJson.encodeToString(TransportEnvelope.serializer(), TransportEnvelope(req)).toRequestBody(ConsoleHttp.JSON),
		// A 2xx body carries the minted gateway-bridge SA token - never let it reach the debug log.
		logBody = false,
	) { TransportResult(ok = false, error = it) }

/** Drive one enroll-handshake frame through the Router's broker (POST { enrollHandshake }). The Router
 * forwards the peer's frame, or reports pending; the phone computes the SAS locally. Pre-admission like
 * firstRoot (the fresh enrollee has no admission). A terminal failure is ok=false + error; ok=true with
 * the peer frame absent means keep polling (re-send the same step). */
suspend fun ConsoleClient.enrollHandshake(op: EnrollHandshakeOp): EnrollHandshakeResult {
	val envelope = EnrollHandshakeEnvelope(op)
	return transport.postRouterDirect(
		tag = "EnrollHs",
		describe = "step=${op::class.simpleName}",
		body = wireJson.encodeToString(EnrollHandshakeEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { EnrollHandshakeResult(ok = false, error = it) }
}

/** Fetch the cross-tenant roster (the Users surface) from the Router. POST { roster } Router-direct like
 * firstRoot: the Router aggregates across Domains a gateway cannot see and answers itself. The request
 * carries the console's signed ROSTER proof; a non-member comes back ok=false (opaque). */
suspend fun ConsoleClient.roster(req: RosterRequest): RosterResult =
	transport.postRouterDirect(
		tag = "Roster",
		describe = "roster",
		body = wireJson.encodeToString(RosterEnvelope.serializer(), RosterEnvelope(req)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { RosterResult(ok = false, error = it) }

/** Broker a FLOW-2 trust-rendezvous frame (arm/join/reveal/cancel) at the Router. POST { trustHandshake }
 * Router-direct (the dumb broker; no sealing, like the enroll handshake). */
suspend fun ConsoleClient.trustHandshake(op: TrustHandshakeOp): TrustHandshakeResult =
	transport.postRouterDirect(
		tag = "Trust",
		describe = "handshake op=${op::class.simpleName}",
		body = wireJson.encodeToString(TrustHandshakeEnvelope.serializer(), TrustHandshakeEnvelope(op)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { TrustHandshakeResult(ok = false, error = it) }

/** Query "who armed trust toward me?" at the Router (the highlight). POST { trustPending } with the
 * owner-signed proof; the Router returns the armed rendezvous indexed under this owner key. */
suspend fun ConsoleClient.trustPending(req: TrustPendingRequest): TrustPendingResult =
	transport.postRouterDirect(
		tag = "Trust",
		describe = "pending",
		body = wireJson.encodeToString(TrustPendingEnvelope.serializer(), TrustPendingEnvelope(req)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { TrustPendingResult(ok = false, error = it) }

/** Submit an admin-signed provision_tenant enroll op and decode the minted one-time invite nonce the
 * Router returns (the admin's app builds the friend's QR from it). Same Router-direct path as enroll();
 * only the richer result decode differs, since the wire EnrollResult omits the nonce. */
suspend fun ConsoleClient.provisionTenant(signed: SignedProvisionTenant): ProvisionTenantResult {
	val envelope = EnrollEnvelope(
		transport.credentials.device,
		transport.credentials.conversationId,
		UUID.randomUUID().toString(),
		EnrollOp.ProvisionTenant(signed),
	)
	return transport.postRouterDirect(
		tag = "Enroll",
		describe = "op=ProvisionTenant",
		body = wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		// A 2xx body carries the minted one-time invite nonce - never let it reach the debug log.
		logBody = false,
	) { ProvisionTenantResult(ok = false, error = it) }
}
