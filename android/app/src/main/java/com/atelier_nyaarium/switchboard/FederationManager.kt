package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.OwnerBackup
import com.atelier_nyaarium.switchboard.crypto.ProvisionOpsCrypto
import com.atelier_nyaarium.switchboard.crypto.XDomainLinkCrypto
import com.atelier_nyaarium.switchboard.crypto.canonicalSnapshot
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DeleteDomain
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.FirstRoot
import com.atelier_nyaarium.switchboard.proto.ProvisionTenant
import com.atelier_nyaarium.switchboard.proto.RemoveTenant
import com.atelier_nyaarium.switchboard.proto.Revocation
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedDeleteDomain
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import com.atelier_nyaarium.switchboard.proto.SignedSetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLink
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.SignedXDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.XDomainLink
import com.atelier_nyaarium.switchboard.proto.XDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.XDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapBundle
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.json.Json

data class MemberInfo(val kind: String, val gatewayId: String?, val signPub: String, val boxPub: String, val isSelf: Boolean)

enum class OwnerRestoreResult { OK, WRONG_PASSPHRASE, DIFFERENT_OWNER }

data class OwnerKeysView(val signPub: String, val boxPub: String, val sas: String)

class FederationManager(private val store: AppStateStore) {
	private val rnd = SecureRandom()
	private val json = Json { ignoreUnknownKeys = true }

	/** Refuses to replace a corrupt owner identity. */
	@Synchronized
	private fun ownerIdentity(): Crypto.Identity =
		when (val load = store.loadOwnerIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> Crypto.generateIdentity().also { store.saveOwnerIdentity(it) }
			IdentityLoad.Corrupt -> error("owner key corrupt - the stored owner root key did not decode; restore from backup or recover the Domain")
		}

	@Synchronized
	fun consoleIdentity(): Crypto.Identity =
		when (val load = store.loadIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> Crypto.generateIdentity().also { store.saveIdentity(it) }
			IdentityLoad.Corrupt -> error("identity corrupt - the stored console key did not decode; restore from backup or re-run setup.sh")
		}

	fun ownerKeysForDisplay(): OwnerKeysView? =
		runCatching { ownerIdentity() }.getOrNull()?.let {
			OwnerKeysView(it.sign.pub, it.box.pub, Crypto.fingerprint(it.sign.pub))
		}

	fun holdsDomainOwnerKey(): Boolean {
		val held = (store.loadOwnerIdentity() as? IdentityLoad.Loaded)?.identity?.sign?.pub ?: return false
		val root = Keyring.parse(store.loadDomain())?.ownerSignPub ?: return true
		return root == held
	}

	fun ownerSignPub(): String = ownerIdentity().sign.pub

	fun ownerBoxPub(): String = ownerIdentity().box.pub

	fun ensureContentEpochs(domainId: String?) {
		if (domainId == null) return
		if (!holdsDomainOwnerKey()) return
		val owner = (store.loadOwnerIdentity() as? IdentityLoad.Loaded)?.identity ?: return
		ContentKeyring(store = store).ensureOwnerEpochs(owner, domainId)
	}

	fun ownerSas(): String = Crypto.fingerprint(ownerIdentity().sign.pub)

	fun exportOwnerBackup(passphrase: String): String =
		OwnerBackup.export(json.encodeToString(Crypto.Identity.serializer(), ownerIdentity()), passphrase)

	@Synchronized
	fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult {
		val restored = runCatching { json.decodeFromString(Crypto.Identity.serializer(), OwnerBackup.restore(blob, passphrase)) }
			.getOrElse { return OwnerRestoreResult.WRONG_PASSPHRASE }
		val existing = store.loadOwnerIdentity()
		val rootedOwner = Keyring.parse(store.loadDomain())?.ownerSignPub
		val refuses = existing is IdentityLoad.Loaded && existing.identity.sign.pub != restored.sign.pub && when {
			rootedOwner == null -> store.firstRooted || store.consoleAdmitted
			else -> restored.sign.pub != rootedOwner
		}
		if (refuses) {
			return OwnerRestoreResult.DIFFERENT_OWNER
		}
		store.saveOwnerIdentity(restored)
		return OwnerRestoreResult.OK
	}

	private fun nonce(): String = Base64.getEncoder().encodeToString(ByteArray(18).also { rnd.nextBytes(it) })

	private enum class RequestSigner { CONSOLE, OWNER }

	private fun <T> signRequest(
		signer: RequestSigner,
		nowMs: Long,
		proof: (String, Long, String, String) -> String,
		build: (String, Long, String, String) -> T,
	): T {
		val identity = if (signer == RequestSigner.CONSOLE) consoleIdentity() else ownerIdentity()
		val n = nonce()
		return build(identity.sign.pub, nowMs, n, proof(identity.sign.pub, nowMs, n, identity.sign.priv))
	}

	/** Owner-signed console admission. */
	fun consoleAdmission(nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val console = consoleIdentity()
		val admission = Admission("console", console.sign.pub, console.box.pub, null, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	fun admitGateway(gatewayId: String, signPub: String, boxPub: String, nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val admission = Admission("gateway", signPub, boxPub, gatewayId, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	fun admitConsole(signPub: String, boxPub: String, nowMs: Long): SignedAdmission {
		val owner = ownerIdentity()
		val admission = Admission("console", signPub, boxPub, null, nowMs, nonce())
		return AdmissionCrypto.signAdmission(admission, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-signs the sealed transport bundle. */
	fun sealConsoleTransport(recipientBoxPub: String, plaintext: ByteArray): SealedEnvelope {
		val owner = ownerIdentity()
		val sealed = Crypto.seal(plaintext, recipientBoxPub, owner.sign.priv)
		return SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature)
	}

	/** Verify owner signature before unsealing. */
	fun unsealConsoleTransport(sealed: SealedEnvelope, ownerSignPub: String): ByteArray {
		val console = consoleIdentity()
		val env = Crypto.SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature)
		return Crypto.unseal(env, console.box.priv, ownerSignPub)
	}

	fun revoke(signPub: String, nowMs: Long): SignedRevocation =
		AdmissionCrypto.signRevocation(Revocation(signPub, nowMs, nonce()), ownerIdentity().sign.priv, ownerIdentity().sign.pub)

	/** Authorize cross-Domain relay. */
	fun signXdomainLinkEdge(
		srcDomainId: String,
		dstDomainId: String,
		nowMs: Long,
		edgeNonce: String? = null,
	): SignedXDomainLinkEdge {
		val owner = ownerIdentity()
		// Pinned nonce preserves retry identity.
		val edge = XDomainLinkEdge(srcDomainId, dstDomainId, nowMs, edgeNonce ?: nonce())
		return XDomainLinkCrypto.signEdge(edge, owner.sign.priv, owner.sign.pub)
	}

	/** Revoke cross-Domain relay. */
	fun signXdomainLinkRevocation(srcDomainId: String, dstDomainId: String, nowMs: Long): SignedXDomainLinkRevocation {
		val owner = ownerIdentity()
		val rev = XDomainLinkRevocation(srcDomainId, dstDomainId, nowMs, nonce())
		return XDomainLinkCrypto.signRevocation(rev, owner.sign.priv, owner.sign.pub)
	}

	/** Sign this owner's cross-Domain link side. */
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

	fun freshLinkNonce(): String = nonce()

	fun signRosterRequest(nowMs: Long): com.atelier_nyaarium.switchboard.proto.RosterRequest {
		return signRequest(RequestSigner.CONSOLE, nowMs, ProvisionOpsCrypto::signRosterRequest) { pub, at, n, signature ->
			com.atelier_nyaarium.switchboard.proto.RosterRequest(pub, at, n, signature)
		}
	}

	/** Owner-signed transport request. */
	fun signTransportRequest(nowMs: Long): com.atelier_nyaarium.switchboard.proto.TransportRequest {
		return signRequest(RequestSigner.OWNER, nowMs, ProvisionOpsCrypto::signTransportRequest) { pub, at, n, signature ->
			com.atelier_nyaarium.switchboard.proto.TransportRequest(pub, at, n, signature)
		}
	}

	/** Owner-signed pending-trust query. */
	fun signTrustPendingRequest(nowMs: Long): com.atelier_nyaarium.switchboard.proto.TrustPendingRequest {
		return signRequest(RequestSigner.OWNER, nowMs, ProvisionOpsCrypto::signTrustPendingRequest) { pub, at, n, signature ->
			com.atelier_nyaarium.switchboard.proto.TrustPendingRequest(pub, at, n, signature)
		}
	}

	fun freshRendezvousId(): String = nonce()

	fun trustParty(domainId: String): com.atelier_nyaarium.switchboard.proto.EnrollParty {
		val owner = ownerIdentity()
		return com.atelier_nyaarium.switchboard.proto.EnrollParty(owner.sign.pub, owner.box.pub, domainId)
	}

	fun freshHandshakeId(): String = nonce()

	fun freshApprovalToken(): String = nonce()

	fun freshEnrollPin(): String = nonce()

	fun freshEnrollSalt(): String = nonce()

	fun keyring(): Keyring = Keyring.parse(store.loadDomain()) ?: Keyring.empty(ownerSignPub())

	fun contentKeyring(): ContentKeyring = ContentKeyring(consoleIdentity().box.priv, store)

	@Synchronized
	fun installContentKeys(envelopes: List<KeyEnvelope>, trust: Keyring): ContentKeyring.Merge {
		val keyring = ContentKeyring(consoleIdentity().box.priv, store)
		return when (val merge = keyring.classify(envelopes, trust)) {
			is ContentKeyring.Merge.Installed ->
				if (keyring.commit(merge)) merge else ContentKeyring.Merge.Refused("content key commit failed")
			else -> merge
		}
	}

	/** Seal Gateway bootstrap keys. */
	fun sealBundle(
		nonce: String,
		transport: GatewayTransport,
		admission: SignedAdmission,
		recipientBoxPub: String,
		domainId: String?,
	): GatewayBootstrapFrame {
		val console = consoleIdentity()
		val keyring = keyring()
		val ring = keyring.snapshot
		val consoleAdmission = keyring.signedConsoleAdmission(console.sign.pub)
			?: if (holdsDomainOwnerKey()) consoleAdmission(System.currentTimeMillis()) else error("this console is not admitted")
		// Include the signer admission for roster-free trust.
		ensureContentEpochs(domainId)
		val bundle = GatewayBootstrapBundle(
			nonce = nonce,
			transport = transport,
			admission = admission,
			domain = DomainSnapshot(
				ownerSignPub = ring.ownerSignPub,
				admissions = listOf(admission, consoleAdmission),
				revocations = emptyList(),
				displayName = ring.displayName,
			),
			domainId = domainId,
			contentKeys = ContentKeyring(store = store).wrapAllFor(recipientBoxPub, console.sign.pub, console.sign.priv),
		)
		val plain = json.encodeToString(GatewayBootstrapBundle.serializer(), bundle).toByteArray(Charsets.UTF_8)
		val sealed = Crypto.seal(plain, recipientBoxPub, console.sign.priv)
		return GatewayBootstrapFrame(
			v = 1L,
			signerSignPub = console.sign.pub,
			sealed = SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature),
		)
	}

	/** Merge local and remote facts only under this owner. */
	@Synchronized
	fun applyDomainSync(snapshot: DomainSnapshot, version: String): Boolean {
		val ownerPub = (store.loadOwnerIdentity() as? IdentityLoad.Loaded)?.identity?.sign?.pub ?: return false
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

	@Synchronized
	fun mergeAdmission(signed: SignedAdmission) {
		val current = keyring().snapshot
		val next = canonicalSnapshot(current.ownerSignPub, current.admissions + signed, current.revocations)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}

	@Synchronized
	fun mergeRevocation(signed: SignedRevocation) {
		val current = keyring().snapshot
		val next = canonicalSnapshot(current.ownerSignPub, current.admissions, current.revocations + signed)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}

	@Synchronized
	fun trustedOwners(): Set<String> {
		val raw = store.loadTrustedOwners() ?: return emptySet()
		return runCatching {
			val arr = org.json.JSONArray(raw)
			(0 until arr.length()).map { arr.getString(it) }.toSet()
		}.getOrDefault(emptySet())
	}

	fun isTrusted(ownerSignPub: String): Boolean = ownerSignPub.isNotEmpty() && trustedOwners().contains(ownerSignPub)

	@Synchronized
	fun addTrustedOwner(ownerSignPub: String) {
		if (ownerSignPub.isEmpty()) return
		persistTrustedOwners(trustedOwners() + ownerSignPub)
	}

	@Synchronized
	fun removeTrustedOwner(ownerSignPub: String) {
		persistTrustedOwners(trustedOwners() - ownerSignPub)
	}

	fun signUntrust(peerOwnerSignPub: String, nowMs: Long): com.atelier_nyaarium.switchboard.proto.SignedXDomainUntrust {
		val owner = ownerIdentity()
		val untrust = com.atelier_nyaarium.switchboard.proto.XDomainUntrust(
			myOwnerSignPub = owner.sign.pub,
			peerOwnerSignPub = peerOwnerSignPub,
			revokedAt = nowMs,
			nonce = nonce(),
		)
		return XDomainLinkCrypto.signUntrust(untrust, owner.sign.priv, owner.sign.pub)
	}

	private fun persistTrustedOwners(owners: Set<String>) {
		val arr = org.json.JSONArray()
		owners.forEach { arr.put(it) }
		store.saveTrustedOwners(arr.toString())
	}

	fun newDomainId(): String {
		val bytes = ByteArray(16).also { rnd.nextBytes(it) }
		return bytes.joinToString("") { "%02x".format(it) }
	}

	/** Self-sign the pending Domain root. */
	fun signFirstRoot(domainId: String, nonce: String, nowMs: Long): SignedFirstRoot {
		val owner = ownerIdentity()
		val firstRoot = FirstRoot(domainId, owner.sign.pub, owner.box.pub, nonce, nowMs)
		return ProvisionOpsCrypto.signFirstRoot(firstRoot, owner.sign.priv)
	}

	fun signProvisionTenant(domainId: String, displayName: String, nowMs: Long): SignedProvisionTenant {
		val owner = ownerIdentity()
		val provision = ProvisionTenant(domainId, displayName, nowMs, nonce())
		return ProvisionOpsCrypto.signProvision(provision, owner.sign.priv, owner.sign.pub)
	}

	fun signRemoveTenant(domainId: String, nowMs: Long): SignedRemoveTenant {
		val owner = ownerIdentity()
		val removal = RemoveTenant(domainId, nowMs, nonce())
		return ProvisionOpsCrypto.signRemove(removal, owner.sign.priv, owner.sign.pub)
	}

	fun signSetDisplayName(domainId: String, displayName: String, nowMs: Long): SignedSetDisplayName {
		val owner = ownerIdentity()
		val rename = SetDisplayName(domainId, displayName, nowMs, nonce())
		return ProvisionOpsCrypto.signSetDisplayName(rename, owner.sign.priv, owner.sign.pub)
	}

	fun signDeleteDomain(domainId: String, nowMs: Long): SignedDeleteDomain {
		val owner = ownerIdentity()
		val deletion = DeleteDomain(domainId, nowMs, nonce())
		return ProvisionOpsCrypto.signDeleteDomain(deletion, owner.sign.priv, owner.sign.pub)
	}
}
