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
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import java.util.UUID

suspend fun ConsoleClient.crossDomainListen(): CrossDomainListenResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListen), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LISTEN)

// Cross-domain requests carry stable opIds for retry safety.
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

suspend fun ConsoleClient.crossDomainConfirm(
	pin: String,
	mySignedLink: SignedXDomainLink,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainConfirmResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainConfirm(pin = pin, mySignedLink = mySignedLink), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_CONFIRM,
	)

suspend fun ConsoleClient.crossDomainListenState(listeningToken: String): CrossDomainListenStateResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListenState(listeningToken = listeningToken)),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LISTEN_STATE,
	)

suspend fun ConsoleClient.crossDomainCancel(listeningToken: String? = null, pin: String? = null): CrossDomainCancelResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainCancel(listeningToken = listeningToken, pin = pin)),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_CANCEL,
	)

suspend fun ConsoleClient.crossDomainShare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainShareResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainShare(sessionTarget = sessionTarget, target = target), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_SHARE,
	)

suspend fun ConsoleClient.crossDomainUnshare(
	sessionTarget: String,
	target: CrossDomainShareTarget,
	opId: String = UUID.randomUUID().toString(),
): CrossDomainUnshareResult =
	valueResult(
		sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainUnshare(sessionTarget = sessionTarget, target = target), opId),
		Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNSHARE,
	)

suspend fun ConsoleClient.crossDomainListShares(): CrossDomainListSharesResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListShares), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LIST_SHARES)

suspend fun ConsoleClient.crossDomainListPeers(): CrossDomainListPeersResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainListPeers), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_LIST_PEERS)

suspend fun ConsoleClient.crossDomainUntrust(ownerSignPub: String, opId: String = UUID.randomUUID().toString()): CrossDomainUnlinkResult =
	valueResult(sendValueOp(defaultGatewayId(), ConsoleOp.CrossDomainUntrust(ownerSignPub = ownerSignPub), opId), Protocol.Wire.ConsoleOpKind.CROSS_DOMAIN_UNTRUST)
