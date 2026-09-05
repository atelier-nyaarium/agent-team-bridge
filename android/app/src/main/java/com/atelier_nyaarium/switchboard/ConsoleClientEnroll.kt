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

suspend fun ConsoleClient.enroll(op: EnrollOp): EnrollResult {
	val envelope = EnrollEnvelope(transport.credentials.device, transport.credentials.conversationId, UUID.randomUUID().toString(), op)
	return transport.postRouterDirect(
		tag = "Enroll",
		describe = "op=${op::class.simpleName}",
		body = wireJson.encodeToString(EnrollEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { EnrollResult(ok = false, error = it) }
}

suspend fun ConsoleClient.postConsoleApproval(op: ConsoleApprovalOp): ConsoleApprovalResult =
	transport.postRouterDirect(
		tag = "DeviceApproval",
		describe = "step=${op::class.simpleName}",
		body = wireJson.encodeToString(ConsoleApprovalEnvelope.serializer(), ConsoleApprovalEnvelope(op)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { ConsoleApprovalResult(ok = false, error = it) }

suspend fun ConsoleClient.firstRoot(signed: SignedFirstRoot): EnrollResult {
	val envelope = FirstRootEnvelope(signed)
	return transport.postRouterDirect(
		tag = "FirstRoot",
		describe = "domain=${signed.firstRoot.domainId}",
		body = wireJson.encodeToString(FirstRootEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { EnrollResult(ok = false, error = it) }
}

suspend fun ConsoleClient.requestGatewayTransport(req: TransportRequest): TransportResult =
	transport.postRouterDirect(
		tag = "Transport",
		describe = "transport",
		body = wireJson.encodeToString(TransportEnvelope.serializer(), TransportEnvelope(req)).toRequestBody(ConsoleHttp.JSON),
		// Do not log credentials.
		logBody = false,
	) { TransportResult(ok = false, error = it) }

suspend fun ConsoleClient.enrollHandshake(op: EnrollHandshakeOp): EnrollHandshakeResult {
	val envelope = EnrollHandshakeEnvelope(op)
	return transport.postRouterDirect(
		tag = "EnrollHs",
		describe = "step=${op::class.simpleName}",
		body = wireJson.encodeToString(EnrollHandshakeEnvelope.serializer(), envelope).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { EnrollHandshakeResult(ok = false, error = it) }
}

suspend fun ConsoleClient.roster(req: RosterRequest): RosterResult =
	transport.postRouterDirect(
		tag = "Roster",
		describe = "roster",
		body = wireJson.encodeToString(RosterEnvelope.serializer(), RosterEnvelope(req)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { RosterResult(ok = false, error = it) }

suspend fun ConsoleClient.trustHandshake(op: TrustHandshakeOp): TrustHandshakeResult =
	transport.postRouterDirect(
		tag = "Trust",
		describe = "handshake op=${op::class.simpleName}",
		body = wireJson.encodeToString(TrustHandshakeEnvelope.serializer(), TrustHandshakeEnvelope(op)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { TrustHandshakeResult(ok = false, error = it) }

suspend fun ConsoleClient.trustPending(req: TrustPendingRequest): TrustPendingResult =
	transport.postRouterDirect(
		tag = "Trust",
		describe = "pending",
		body = wireJson.encodeToString(TrustPendingEnvelope.serializer(), TrustPendingEnvelope(req)).toRequestBody(ConsoleHttp.JSON),
		logBody = true,
	) { TrustPendingResult(ok = false, error = it) }

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
		// Do not log invite nonces.
		logBody = false,
	) { ProvisionTenantResult(ok = false, error = it) }
}
