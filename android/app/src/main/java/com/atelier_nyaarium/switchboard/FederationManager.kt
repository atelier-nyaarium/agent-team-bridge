package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.OwnerBackup
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.Revocation
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import com.atelier_nyaarium.switchboard.proto.SwitchBootstrapBundle
import com.atelier_nyaarium.switchboard.proto.SwitchBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.SwitchTransport
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.json.Json

/**
 * Owns the device's role as the Domain trust anchor: the owner root keypair (sole
 * signer of admissions and revocations) and the console member identity, plus the
 * mirrored keyring the Console resolves peers against. The owner key is generated on
 * first access and never leaves the device except as a passphrase-encrypted backup.
 *
 * Admissions and revocations are signed here and submitted to evie through the
 * Console's enroll channel; the Console verifies every Switch it seals to against this
 * keyring, so trust is symmetric (each peer is admitted by the one owner root).
 */
/** One admitted member, for the management board. */
data class MemberInfo(val kind: String, val switchId: String?, val signPub: String, val boxPub: String, val isSelf: Boolean)

/** Outcome of restoring an owner backup, so the UI can tell a wrong passphrase apart from a
 * backup that belongs to a different owner (which restore refuses). */
enum class OwnerRestoreResult { OK, WRONG_PASSPHRASE, DIFFERENT_OWNER }

class FederationManager(private val store: ProvisioningStore) {
	private val rnd = SecureRandom()
	private val json = Json { ignoreUnknownKeys = true }

	/** The owner root identity, generated and persisted on first access. Synchronized: the
	 * UI (owner-keys card) and background coroutines (connect, admit, poll) all reach this,
	 * and a non-atomic generate-then-persist would let two callers mint different keys and
	 * orphan one - so the operator could root evie at a key the device later discards. */
	@Synchronized
	fun ownerIdentity(): Crypto.Identity =
		store.loadOwnerIdentity() ?: Crypto.generateIdentity().also { store.saveOwnerIdentity(it) }

	/** The console member identity, generated and persisted on first access (atomic for the
	 * same reason as the owner identity). */
	@Synchronized
	fun consoleIdentity(): Crypto.Identity =
		store.loadIdentity() ?: Crypto.generateIdentity().also { store.saveIdentity(it) }

	fun ownerSignPub(): String = ownerIdentity().sign.pub

	fun ownerBoxPub(): String = ownerIdentity().box.pub

	/** The owner key fingerprint the operator confirms when rooting the Domain host-side. */
	fun ownerSas(): String = Crypto.fingerprint(ownerIdentity().sign.pub)

	/** A passphrase-encrypted backup of the owner root key, for offline safekeeping. */
	fun exportOwnerBackup(passphrase: String): String =
		OwnerBackup.export(json.encodeToString(Crypto.Identity.serializer(), ownerIdentity()), passphrase)

	/** Restore the owner root key from a backup blob. Restore is meant for a fresh install
	 * (no owner yet), so it REFUSES to overwrite a DIFFERENT existing owner: a backup carrying
	 * another owner key (passphrase known) must not be able to silently re-root this device
	 * and brick the mesh. Re-importing the same owner is idempotent. Synchronized with
	 * ownerIdentity() so a concurrent generation cannot overwrite the restored key. The
	 * result distinguishes a wrong passphrase from a different-owner rejection. */
	@Synchronized
	fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult {
		val restored = runCatching { json.decodeFromString(Crypto.Identity.serializer(), OwnerBackup.restore(blob, passphrase)) }
			.getOrElse { return OwnerRestoreResult.WRONG_PASSPHRASE }
		val existing = store.loadOwnerIdentity()
		if (existing != null && existing.sign.pub != restored.sign.pub) return OwnerRestoreResult.DIFFERENT_OWNER
		store.saveOwnerIdentity(restored)
		return OwnerRestoreResult.OK
	}

	private fun nonce(): String = Base64.getEncoder().encodeToString(ByteArray(18).also { rnd.nextBytes(it) })

	/** This Console's own owner-signed kind:console admission, to submit to evie so a
	 * Switch will trust its sealed ops. */
	fun consoleAdmission(nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val console = consoleIdentity()
		val admission = Admission("console", console.sign.pub, console.box.pub, null, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a kind:switch admission for a scanned admit-switch identity. */
	fun admitSwitch(switchId: String, signPub: String, boxPub: String, nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val admission = Admission("switch", signPub, boxPub, switchId, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a revocation for a member's signing key. */
	fun revoke(signPub: String, nowMs: Long): SignedRevocation =
		AdmissionCrypto.signRevocation(Revocation(signPub, nowMs, nonce()), ownerIdentity().sign.priv, ownerIdentity().sign.pub)

	/** The current keyring: the stored snapshot, or an owner-only one before any sync. */
	fun keyring(): Keyring = Keyring.parse(store.loadDomain()) ?: Keyring.empty(ownerSignPub())

	/** Seal a bootstrap bundle (transport + the Switch's admission + the current keyring)
	 * to the Switch's box key, signed by this Console, wrapped in a delivery frame. The
	 * Switch verifies the seal, opens it, checks the nonce + the owner-signed admission. */
	fun sealBundle(nonce: String, transport: SwitchTransport, admission: SignedAdmission, recipientBoxPub: String): SwitchBootstrapFrame {
		val console = consoleIdentity()
		val bundle = SwitchBootstrapBundle(nonce = nonce, transport = transport, admission = admission, domain = keyring().snapshot)
		val plain = json.encodeToString(SwitchBootstrapBundle.serializer(), bundle).toByteArray(Charsets.UTF_8)
		val sealed = Crypto.seal(plain, recipientBoxPub, console.sign.priv)
		return SwitchBootstrapFrame(
			v = 1L,
			signerSignPub = console.sign.pub,
			sealed = SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature),
		)
	}

	/** Apply a snapshot synced from a Switch, but ONLY when it is rooted at this device's
	 * own owner key. A relay that tampered with the root (to seat an attacker owner) is
	 * rejected, so the pinned owner can never be swapped out from under the Console. Read
	 * the owner key WITHOUT generating one: a sync arriving before this device has an owner
	 * cannot be verified and must not seat a throwaway root. Locally-merged admissions (a
	 * member the owner just admitted, before evie rebroadcast it) are preserved by folding
	 * the server snapshot over the current one, deduped by signing key + nonce; revocations
	 * are taken canonical from the server. */
	@Synchronized
	fun applyDomainSync(snapshot: DomainSnapshot, version: String): Boolean {
		val ownerPub = store.loadOwnerIdentity()?.sign?.pub ?: return false
		if (snapshot.ownerSignPub != ownerPub) return false
		val local = keyring().snapshot.admissions
		// Sort the merge by issue time so the same set of admissions always yields the same
		// canonical order (the merge order would otherwise depend on when each was added).
		val mergedAdmissions = (snapshot.admissions + local)
			.distinctBy { "${it.admission.signPub}:${it.admission.nonce}" }
			.sortedBy { it.admission.issuedAt }
		val next = snapshot.copy(admissions = mergedAdmissions)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), version)
		return true
	}

	/** The admitted members of the keyring (owner-verified, non-revoked), deduped by
	 * signing key, for the management board. */
	fun members(): List<MemberInfo> {
		val k = keyring()
		val mySign = consoleIdentity().sign.pub
		val out = mutableListOf<MemberInfo>()
		val seen = mutableSetOf<String>()
		for (s in k.snapshot.admissions) {
			if (!seen.add(s.admission.signPub)) continue
			val a = k.resolveSubject(s.admission.signPub) ?: continue
			out.add(MemberInfo(a.kind, a.switchId, a.signPub, a.boxPub, a.signPub == mySign))
		}
		return out
	}

	/** Fold a freshly owner-signed admission into the local keyring so the Console can
	 * seal to a member it just admitted, before evie's snapshot syncs back. Synchronized
	 * with applyDomainSync so a concurrent poll cannot overwrite the merge. */
	@Synchronized
	fun mergeAdmission(signed: SignedAdmission) {
		val current = keyring().snapshot
		val deduped = current.admissions.filterNot {
			it.admission.signPub == signed.admission.signPub && it.admission.nonce == signed.admission.nonce
		}
		val next = current.copy(admissions = deduped + signed)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}
}
