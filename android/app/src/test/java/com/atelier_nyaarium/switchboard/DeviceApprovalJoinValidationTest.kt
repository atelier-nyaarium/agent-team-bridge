package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalJoin
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceApprovalJoinValidationTest {
	@Test
	fun verifiesOnlyTheExpectedJoinSignature() {
		val approvalId = "approval"
		val nonce = "nonce"
		val joinIdentity = Crypto.generateIdentity()
		val otherIdentity = Crypto.generateIdentity()
		val signingBytes = Crypto.deviceJoinSigningBytes(
			approvalId,
			nonce,
			joinIdentity.sign.pub,
			joinIdentity.box.pub,
		)
		val signature = Crypto.sign(signingBytes, joinIdentity.sign.priv)
		val otherSigner = Crypto.sign(signingBytes, otherIdentity.sign.priv)
		val wrongNonce = Crypto.sign(
			Crypto.deviceJoinSigningBytes(approvalId, "other-nonce", joinIdentity.sign.pub, joinIdentity.box.pub),
			joinIdentity.sign.priv,
		)

		assertFalse(verifyDeviceJoin(approvalId, nonce, ConsoleApprovalJoin(joinIdentity.sign.pub, joinIdentity.box.pub)))
		assertFalse(
			verifyDeviceJoin(
				approvalId,
				nonce,
				ConsoleApprovalJoin(joinIdentity.sign.pub, joinIdentity.box.pub, otherSigner),
			),
		)
		assertFalse(
			verifyDeviceJoin(
				approvalId,
				nonce,
				ConsoleApprovalJoin(joinIdentity.sign.pub, joinIdentity.box.pub, wrongNonce),
			),
		)
		assertTrue(
			verifyDeviceJoin(
				approvalId,
				nonce,
				ConsoleApprovalJoin(joinIdentity.sign.pub, joinIdentity.box.pub, signature),
			),
		)
	}
}
