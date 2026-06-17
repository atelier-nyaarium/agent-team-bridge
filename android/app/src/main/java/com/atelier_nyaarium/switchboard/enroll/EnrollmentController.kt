package com.atelier_nyaarium.switchboard.enroll

import com.atelier_nyaarium.switchboard.PhoneClient
import com.atelier_nyaarium.switchboard.ProvisioningStore
import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import java.security.SecureRandom
import java.util.Base64

/**
 * Drives the three enrollment flows after the human has confirmed the scanned
 * payload's SAS. The owner device's identity (minted once, persisted) is the
 * Domain root: enroll-owner redeems with its public keys, and admit-switch /
 * authorize-phone sign an owner admission with its private signing key. The
 * signed artifacts are submitted to evie, which verifies them against the rooted
 * owner key (never trusting the wire).
 */
class EnrollmentController(
	private val store: ProvisioningStore,
	private val client: PhoneClient,
) {
	private val random = SecureRandom()

	/** This device's owner identity, minted + persisted on first use. */
	fun ownerIdentity(): Crypto.Identity = store.loadIdentity() ?: Crypto.generateIdentity().also { store.saveIdentity(it) }

	/** True once evie has ROOTED the Domain at this device. Holding a minted-but-not-
	 * redeemed keypair does NOT count, so a failed/expired redeem never leaves the UI
	 * claiming this device is the owner. */
	fun isEnrolledOwner(): Boolean = store.federationRooted

	/** Redeem evie's enroll-owner nonce, rooting the Domain at this device's keys. The
	 * local rooted flag flips only on evie's ok, not on minting the keypair.
	 * After rooting, self-submit a kind:"phone" admission so the arbiter can resolve
	 * this device's box key and seal replies back to it. A self-admission failure is
	 * non-fatal: the owner can retry by scanning a future admit-phone QR. */
	fun redeemOwner(payload: EnrollmentPayload.EnrollOwner): EnrollResult {
		val identity = ownerIdentity()
		val result = client.enroll(EnrollOp.EnrollRedeem(payload.nonce, identity.sign.pub, identity.box.pub))
		if (result.ok) {
			store.federationRooted = true
			// Self-admit the owner device as a phone so the arbiter resolves its boxPub.
			runCatching {
				val selfAdmission = Admission(
					kind = "phone",
					signPub = identity.sign.pub,
					boxPub = identity.box.pub,
					switchId = null,
					issuedAt = System.currentTimeMillis(),
					nonce = freshNonce(),
				)
				val signed = AdmissionCrypto.signAdmission(selfAdmission, identity.sign.priv, identity.sign.pub)
				client.enroll(EnrollOp.SubmitAdmission(signed))
			}
		}
		return result
	}

	/** Owner-sign a Host admission for a scanned arbiter and submit it to evie.
	 * On success, persist the host's keys so seal/unseal can resolve them by switchId,
	 * AND seed the home Switch id so the FIRST register (which is itself sealed) can
	 * resolve a Switch to seal to before it learns homeSwitch from the register reply. A
	 * later register persists the authoritative id and takes precedence. */
	fun admitSwitch(payload: EnrollmentPayload.AdmitSwitch): EnrollResult {
		val identity = requireOwner()
		val admission = Admission(
			kind = "switch",
			signPub = payload.signPub,
			boxPub = payload.boxPub,
			switchId = payload.switchId,
			issuedAt = System.currentTimeMillis(),
			nonce = freshNonce(),
		)
		val signed = AdmissionCrypto.signAdmission(admission, identity.sign.priv, identity.sign.pub)
		val result = client.enroll(EnrollOp.SubmitAdmission(signed))
		if (result.ok) {
			runCatching {
				store.saveSwitchKeys(payload.switchId, payload.signPub, payload.boxPub)
				if (store.loadSwitchId().isEmpty()) store.saveSwitchId(payload.switchId)
			}
		}
		return result
	}

	/** Owner-sign a phone admission for a second owner device and submit it. */
	fun authorizePhone(payload: EnrollmentPayload.AuthorizePhone): EnrollResult {
		val identity = requireOwner()
		val admission = Admission(
			kind = "phone",
			signPub = payload.signPub,
			boxPub = payload.boxPub,
			switchId = null,
			issuedAt = System.currentTimeMillis(),
			nonce = freshNonce(),
		)
		val signed = AdmissionCrypto.signAdmission(admission, identity.sign.priv, identity.sign.pub)
		return client.enroll(EnrollOp.SubmitAdmission(signed))
	}

	private fun requireOwner(): Crypto.Identity {
		check(store.federationRooted) { "This device is not the enrolled Domain owner yet (scan evie's QR first)." }
		return store.loadIdentity() ?: error("Owner identity missing; re-enroll this device.")
	}

	private fun freshNonce(): String {
		val bytes = ByteArray(18)
		random.nextBytes(bytes)
		return Base64.getEncoder().encodeToString(bytes)
	}
}
