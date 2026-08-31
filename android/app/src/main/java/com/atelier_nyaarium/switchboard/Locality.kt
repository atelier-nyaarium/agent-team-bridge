package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address

internal fun Address.isLocalTo(domainId: String, gatewayIds: Set<String>): Boolean =
	domain == domainId && gateway in gatewayIds
