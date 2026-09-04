package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceApprovalOpsTest {
	@Test
	fun parsesThePublicApprovalEnvelope() = runBlocking {
		val store = testStore()
		val ops = DeviceApprovalOps(
			MutableStateFlow(ChatState()),
			store,
			TestIdentityPort(store),
			FailingClientPort,
			TestDeviceCollaborators(),
		)
		val scan = ops.parseAuthorizeConsole(
			"""{"type":"authorize-console","domainId":"domain","signPub":"owner","boxPub":"box","approvalId":"approval","nonce":"nonce","reach":"https://router"}""",
		)

		assertEquals("domain", scan?.domainId)
		assertEquals("approval", scan?.approvalId)
	}

	private class TestDeviceCollaborators : DeviceApprovalOpsCollaborators {
		override fun approvalNonces() = mutableMapOf<String, String>()
		override fun homeGatewayId() = "gateway"
		override fun setHomeGatewayId(value: String) = Unit
		override fun installApprovedDevice(
			blob: String,
			domainJson: String?,
			domainVersion: String?,
			gatewayId: String?,
			contentKeys: Map<Int, ByteArray>,
			domainId: String?,
		) = true
		override fun invalidateClients() = Unit
		override suspend fun submitOwnerAdmission(signed: SignedAdmission) = true
		override fun refreshAdmittedGateways() = Unit
		override fun reportError() = null
	}
}
