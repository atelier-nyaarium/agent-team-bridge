package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.CrossDomainCancelResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainConfirmResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListPeersResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListSharesResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainListenStateResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget
import com.atelier_nyaarium.switchboard.proto.CrossDomainUnlinkResult
import com.atelier_nyaarium.switchboard.proto.CrossDomainUnshareResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

////////////////////////////////
//  Cross-Domain trust ops
//
//  Gateway: the handshake coordinator, the per-session share state, and the unlink cleanup all run on
//  this owner's own Gateway (the friend Gateway is reached through the mesh, not sealed to directly).
//  Reads run fresh; the mutating ops carry a stable opId so a lost-reply retry replays the cached
//  result rather than re-running, like send/tmux_send.

/** RECEIVER: open a listening window. Returns the short token to read to the friend plus
 * this Gateway's keys (for the SAS) and the window's expiry. */
suspend fun ConsoleClient.crossDomainListen(): CrossDomainListenResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListen), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LISTEN)

/** REQUESTER: pair against the friend's listening token. The Gateway runs the full
 * commit-reveal exchange and returns the 6-digit SAS plus both sides' keys. */
suspend fun ConsoleClient.crossDomainRequest(
	listeningToken: String,
	pin: String,
	requesterOwnerSignPub: String,
	requesterDomainId: String,
	requesterGatewayId: String,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainRequestResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainRequest(
				listeningToken = listeningToken,
				pin = pin,
				requesterOwnerSignPub = requesterOwnerSignPub,
				requesterDomainId = requesterDomainId,
				requesterGatewayId = requesterGatewayId,
		), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_REQUEST,
	)

/** EITHER ROLE: confirm the SAS match. Each owner confirms INDEPENDENTLY, submitting only its
 * OWN signed link side (binding the friend keys from the SAS-verified pairing); the Gateway
 * verifies it under this owner's key and writes the cross-Domain peer. No friend-link exchange. */
suspend fun ConsoleClient.crossDomainConfirm(
	pin: String,
	mySignedLink: SignedXDomainLink,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainConfirmResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainConfirm(pin = pin, mySignedLink = mySignedLink), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_CONFIRM,
	)

/** RECEIVER: poll the listening window's pairing state. Before a pairing arrives this reports
 * pairingArrived=false; once the requester's exchange lands, it carries the SAS + the friend's
 * keys the receiver phone owner-signs its link over. A fresh read each call (never cached). */
suspend fun ConsoleClient.crossDomainListenState(listeningToken: String): CrossDomainListenStateResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListenState(listeningToken = listeningToken)),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LISTEN_STATE,
	)

/** EITHER ROLE: cancel a listening window (receiver token) and/or a pending pairing (pin)
 * when the owner leaves the pairing screen, so a stale request cannot complete. */
suspend fun ConsoleClient.crossDomainCancel(listeningToken: String? = null, pin: String? = null): CrossDomainCancelResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainCancel(listeningToken = listeningToken, pin = pin)),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_CANCEL,
	)

/** Mark a local session shared to an audience (a linked friend Domain, or everyone trusted). */
suspend fun ConsoleClient.crossDomainShare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainShareResult {
	postRouterShare(Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_SHARE, sessionTarget, target)
	return try {
		valueResult(
			sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainShare(sessionTarget = sessionTarget, target = target), opId),
			Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_SHARE,
		)
	} catch (e: Exception) {
		// A refused mirror withdraws the record.
		runCatching { postRouterShare(Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNSHARE, sessionTarget, target) }
			.onFailure { DebugLog.log("Share", "withdrawal after a refused mirror failed") }
		throw e
	}
}

/** Withdraw a local session's share from an audience. */
suspend fun ConsoleClient.crossDomainUnshare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainUnshareResult {
	postRouterShare(Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNSHARE, sessionTarget, target)
	return valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainUnshare(sessionTarget = sessionTarget, target = target), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNSHARE,
	)
}

/** The Router record admits the friend's rows. */
private suspend fun ConsoleClient.postRouterShare(kind: String, sessionTarget: String, target: CrossDomainShareTarget) {
	val answer = postSigned(
		buildJsonObject {
			put("kind", kind)
			put("sessionTarget", canonicalShareTarget(sessionTarget))
			put("target", wireJson.encodeToJsonElement(CrossDomainShareTarget.serializer(), target))
		},
	)
	requireDelivery(answer, kind)
}

private fun ConsoleClient.canonicalShareTarget(sessionTarget: String): String =
	when (val parsed = parseTarget(sessionTarget, localDomainId(), defaultGatewayId())) {
		is Address -> parsed.canonical
		is SpawnPoint -> Address.of(parsed.domain, parsed.gateway, parsed.spawn, Protocol.DEFAULT_SESSION).canonical
	}

/** This owner's current shares, so the UI can render the per-session checkmarks. */
suspend fun ConsoleClient.crossDomainListShares(): CrossDomainListSharesResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListShares), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LIST_SHARES)

 /**
 * peer is visible (and its detail reachable) before any of its sessions surface in the presence plane. A
 * fresh read each call (never cached). */
suspend fun ConsoleClient.crossDomainListPeers(): CrossDomainListPeersResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListPeers), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LIST_PEERS)

/** Untrust a PERSON by owner key: drop the local peer + share state for every Domain they own. */
suspend fun ConsoleClient.crossDomainUntrust(ownerSignPub: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainUntrust(ownerSignPub = ownerSignPub), opId), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNTRUST)
