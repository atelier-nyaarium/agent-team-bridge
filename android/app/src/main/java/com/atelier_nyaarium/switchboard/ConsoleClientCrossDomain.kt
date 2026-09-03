package com.atelier_nyaarium.switchboard

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
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import java.util.UUID

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
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListen), "cross_domain_listen")

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
		"cross_domain_request",
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
		"cross_domain_confirm",
	)

/** RECEIVER: poll the listening window's pairing state. Before a pairing arrives this reports
 * pairingArrived=false; once the requester's exchange lands, it carries the SAS + the friend's
 * keys the receiver phone owner-signs its link over. A fresh read each call (never cached). */
suspend fun ConsoleClient.crossDomainListenState(listeningToken: String): CrossDomainListenStateResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListenState(listeningToken = listeningToken)),
		"cross_domain_listen_state",
	)

/** EITHER ROLE: cancel a listening window (receiver token) and/or a pending pairing (pin)
 * when the owner leaves the pairing screen, so a stale request cannot complete. */
suspend fun ConsoleClient.crossDomainCancel(listeningToken: String? = null, pin: String? = null): CrossDomainCancelResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainCancel(listeningToken = listeningToken, pin = pin)),
		"cross_domain_cancel",
	)

/** Mark a local session shared to an audience (a linked friend Domain, or everyone trusted). */
suspend fun ConsoleClient.crossDomainShare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainShareResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainShare(sessionTarget = sessionTarget, target = target), opId),
		"cross_domain_share",
	)

/** Withdraw a local session's share from an audience. */
suspend fun ConsoleClient.crossDomainUnshare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainUnshareResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainUnshare(sessionTarget = sessionTarget, target = target), opId),
		"cross_domain_unshare",
	)

/** This owner's current shares, so the UI can render the per-session checkmarks. */
suspend fun ConsoleClient.crossDomainListShares(): CrossDomainListSharesResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListShares), "cross_domain_list_shares")

 /**
 * peer is visible (and its detail reachable) before any of its sessions surface in the presence plane. A
 * fresh read each call (never cached). */
suspend fun ConsoleClient.crossDomainListPeers(): CrossDomainListPeersResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListPeers), "cross_domain_list_peers")

/** Untrust a PERSON by owner key: drop the local peer + share state for every Domain they own. */
suspend fun ConsoleClient.crossDomainUntrust(ownerSignPub: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainUntrust(ownerSignPub = ownerSignPub), opId), "cross_domain_untrust")
