package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.OwnerBackup
import com.atelier_nyaarium.switchboard.crypto.XDomainLinkCrypto
import com.atelier_nyaarium.switchboard.crypto.canonicalSnapshot
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.Revocation
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.XDomainLink
import com.atelier_nyaarium.switchboard.proto.XDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.XDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapBundle
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
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
 * Console's enroll channel; the Console verifies every Gateway it seals to against this
 * keyring, so trust is symmetric (each peer is admitted by the one owner root).
 */
/** One admitted member, for the management board. */
data class MemberInfo(val kind: String, val gatewayId: String?, val signPub: String, val boxPub: String, val isSelf: Boolean)

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
	 * Gateway will trust its sealed ops. */
	fun consoleAdmission(nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val console = consoleIdentity()
		val admission = Admission("console", console.sign.pub, console.box.pub, null, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a kind:gateway admission for a scanned admit-gateway identity. */
	fun admitGateway(gatewayId: String, signPub: String, boxPub: String, nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val admission = Admission("gateway", signPub, boxPub, gatewayId, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a revocation for a member's signing key. */
	fun revoke(signPub: String, nowMs: Long): SignedRevocation =
		AdmissionCrypto.signRevocation(Revocation(signPub, nowMs, nonce()), ownerIdentity().sign.priv, ownerIdentity().sign.pub)

	/** Owner-sign a cross-Domain link edge: an attestation that traffic from this owner's
	 * Domain (`srcDomainId`) may relay to a friend Domain (`dstDomainId`) it has linked with.
	 * evie's relay-affinity gate honors a cross-Domain gateway_relay only when this edge
	 * exists. Content-blind: it names only the two Domain ids. */
	fun signXdomainLinkEdge(srcDomainId: String, dstDomainId: String, nowMs: Long): SignedXDomainLinkEdge {
		val owner = ownerIdentity()
		val edge = XDomainLinkEdge(srcDomainId, dstDomainId, nowMs, nonce())
		return XDomainLinkCrypto.signEdge(edge, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a cross-Domain link-edge revocation: withdraws the attestation above so
	 * evie drops the edge and its relay-affinity gate refuses the cross-Domain relay again.
	 * The revocation prefix is distinct from the edge's, so neither signature replays as the
	 * other. */
	fun signXdomainLinkRevocation(srcDomainId: String, dstDomainId: String, nowMs: Long): SignedXDomainLinkRevocation {
		val owner = ownerIdentity()
		val rev = XDomainLinkRevocation(srcDomainId, dstDomainId, nowMs, nonce())
		return XDomainLinkCrypto.signRevocation(rev, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign THIS owner's side of a cross-Domain link, binding the FRIEND Gateway's keys
	 * the SAS confirmed out of band. The owner private key is phone-held, so only the phone can
	 * produce this; the confirming Gateway verifies it under this owner key and the friend's
	 * Gateway persists it as its cross-Domain peer. The friend phone likewise signs THEIR side
	 * (binding this Gateway's keys) - the two sides are symmetric, each signed by its own owner.
	 * `nonce` is supplied (not minted here) so a retried confirm reuses the same signed link
	 * rather than a fresh one the Gateway has not seen. */
	fun signMyLink(
		peerOwnerSignPub: String,
		peerDomainId: String,
		peerGatewayId: String,
		peerSignPub: String,
		peerBoxPub: String,
		nowMs: Long,
		nonce: String,
	): SignedXDomainLink {
		val owner = ownerIdentity()
		val link = XDomainLink(
			myOwnerSignPub = owner.sign.pub,
			peerOwnerSignPub = peerOwnerSignPub,
			peerDomainId = peerDomainId,
			peerGatewayId = peerGatewayId,
			peerSignPub = peerSignPub,
			peerBoxPub = peerBoxPub,
			issuedAt = nowMs,
			nonce = nonce,
		)
		return XDomainLinkCrypto.signLink(link, owner.sign.priv, owner.sign.pub)
	}

	/** A fresh base64 nonce for an owner-signed link side, minted once per confirm so a retry
	 * reuses it (the signed link stays byte-stable across the retry). Exposed so the wizard can
	 * pin it for the lifetime of one pairing. */
	fun freshLinkNonce(): String = nonce()

	/** The current keyring: the stored snapshot, or an owner-only one before any sync. */
	fun keyring(): Keyring = Keyring.parse(store.loadDomain()) ?: Keyring.empty(ownerSignPub())

	/** Seal a bootstrap bundle (transport + the Gateway's admission + the current keyring)
	 * to the Gateway's box key, signed by this Console, wrapped in a delivery frame. The
	 * Gateway verifies the seal, opens it, checks the nonce + the owner-signed admission. */
	fun sealBundle(nonce: String, transport: GatewayTransport, admission: SignedAdmission, recipientBoxPub: String): GatewayBootstrapFrame {
		val console = consoleIdentity()
		val bundle = GatewayBootstrapBundle(nonce = nonce, transport = transport, admission = admission, domain = keyring().snapshot)
		val plain = json.encodeToString(GatewayBootstrapBundle.serializer(), bundle).toByteArray(Charsets.UTF_8)
		val sealed = Crypto.seal(plain, recipientBoxPub, console.sign.priv)
		return GatewayBootstrapFrame(
			v = 1L,
			signerSignPub = console.sign.pub,
			sealed = SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature),
		)
	}

	/** Apply a snapshot synced from a Gateway, but ONLY when it is rooted at this device's
	 * own owner key. A relay that tampered with the root (to seat an attacker owner) is
	 * rejected, so the pinned owner can never be swapped out from under the Console. Read
	 * the owner key WITHOUT generating one: a sync arriving before this device has an owner
	 * cannot be verified and must not seat a throwaway root. The server snapshot is folded
	 * OVER the current one for BOTH admissions and revocations, deduped by signing key +
	 * nonce and ordered by issue time. Both are append-only owner-signed facts (a revocation
	 * is never undone - a later admission supersedes it by timestamp), so the union is safe
	 * and convergent: a member the owner just admitted OR revoked locally survives until evie
	 * rebroadcasts it, then the dedupe makes the rebroadcast idempotent. Taking revocations
	 * canonical-from-server alone would drop a locally-merged revocation on the next poll,
	 * letting a just-revoked member reappear on the board (and be sealed to) until evie caught
	 * up. */
	@Synchronized
	fun applyDomainSync(snapshot: DomainSnapshot, version: String): Boolean {
		val ownerPub = store.loadOwnerIdentity()?.sign?.pub ?: return false
		if (snapshot.ownerSignPub != ownerPub) return false
		val current = keyring().snapshot
		val next = canonicalSnapshot(
			snapshot.ownerSignPub,
			snapshot.admissions + current.admissions,
			snapshot.revocations + current.revocations,
		)
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
			out.add(MemberInfo(a.kind, a.gatewayId, a.signPub, a.boxPub, a.signPub == mySign))
		}
		return out
	}

	/** Fold a freshly owner-signed admission into the local keyring so the Console can
	 * seal to a member it just admitted, before evie's snapshot syncs back. Synchronized
	 * with applyDomainSync so a concurrent poll cannot overwrite the merge. */
	@Synchronized
	fun mergeAdmission(signed: SignedAdmission) {
		val current = keyring().snapshot
		val next = canonicalSnapshot(current.ownerSignPub, current.admissions + signed, current.revocations)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}

	/** Fold a freshly owner-signed revocation into the local keyring so the revoked member
	 * drops off the board immediately, before evie rebroadcasts it. members() honors
	 * revocations, so the member disappears on the next read. Synchronized with
	 * applyDomainSync so a concurrent poll cannot overwrite the merge. */
	@Synchronized
	fun mergeRevocation(signed: SignedRevocation) {
		val current = keyring().snapshot
		val next = canonicalSnapshot(current.ownerSignPub, current.admissions, current.revocations + signed)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}
}
