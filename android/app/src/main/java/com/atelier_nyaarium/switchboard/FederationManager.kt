package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.crypto.OwnerBackup
import com.atelier_nyaarium.switchboard.crypto.ProvisionOpsCrypto
import com.atelier_nyaarium.switchboard.crypto.XDomainLinkCrypto
import com.atelier_nyaarium.switchboard.crypto.canonicalSnapshot
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.FirstRoot
import com.atelier_nyaarium.switchboard.proto.ProvisionTenant
import com.atelier_nyaarium.switchboard.proto.RemoveTenant
import com.atelier_nyaarium.switchboard.proto.Revocation
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import com.atelier_nyaarium.switchboard.proto.SetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
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
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.json.Json

/**
 * The Domain trust anchor: the owner root keypair (sole signer of admissions and
 * revocations), the console member identity, and the mirrored keyring the Console
 * resolves peers against. The owner key never leaves the device except as a
 * passphrase-encrypted backup. Admissions and revocations are signed here and submitted
 * to evie; the Console verifies every Gateway it seals to against this keyring.
 */
/** One admitted member, for the management board. */
data class MemberInfo(val kind: String, val gatewayId: String?, val signPub: String, val boxPub: String, val isSelf: Boolean)

/** Outcome of restoring an owner backup, so the UI can tell a wrong passphrase apart from a
 * backup that belongs to a different owner (which restore refuses). */
enum class OwnerRestoreResult { OK, WRONG_PASSPHRASE, DIFFERENT_OWNER }

/** Owner public material for the settings cards (no private key). */
data class OwnerKeysView(val signPub: String, val boxPub: String, val sas: String)

class FederationManager(private val store: ProvisioningStore) {
	private val rnd = SecureRandom()
	private val json = Json { ignoreUnknownKeys = true }

	/** The owner root identity, generated and persisted on first access. Synchronized because a
	 * non-atomic generate-then-persist would let two concurrent callers mint different keys and
	 * orphan one. Mints ONLY on an absent key; a corrupt stored key throws rather than minting
	 * over it, so a transient decode fault never silently re-roots the device. */
	@Synchronized
	fun ownerIdentity(): Crypto.Identity =
		when (val load = store.loadOwnerIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> Crypto.generateIdentity().also { store.saveOwnerIdentity(it) }
			IdentityLoad.Corrupt -> error("owner key corrupt - the stored owner root key did not decode; restore from backup or recover the Domain")
		}

	/** The console member identity, generated and persisted on first access (atomic, and
	 * mint-on-absent-only, for the same reasons as the owner identity). */
	@Synchronized
	fun consoleIdentity(): Crypto.Identity =
		when (val load = store.loadIdentity()) {
			is IdentityLoad.Loaded -> load.identity
			IdentityLoad.Absent -> Crypto.generateIdentity().also { store.saveIdentity(it) }
			IdentityLoad.Corrupt -> error("identity corrupt - the stored console key did not decode; restore from backup or re-run provision-admin-domain.sh")
		}

	/** Owner public material for display, or null when the stored owner key is corrupt. Never
	 * throws and never mints over a corrupt key, so a settings card shows a restore prompt
	 * instead of crashing. An absent key still mints, matching [ownerIdentity]. */
	fun ownerKeysForDisplay(): OwnerKeysView? =
		runCatching { ownerIdentity() }.getOrNull()?.let {
			OwnerKeysView(it.sign.pub, it.box.pub, Crypto.fingerprint(it.sign.pub))
		}

	fun ownerSignPub(): String = ownerIdentity().sign.pub

	fun ownerBoxPub(): String = ownerIdentity().box.pub

	/** The owner key fingerprint the admin confirms when rooting the Domain host-side. */
	fun ownerSas(): String = Crypto.fingerprint(ownerIdentity().sign.pub)

	/** A passphrase-encrypted backup of the owner root key, for offline safekeeping. */
	fun exportOwnerBackup(passphrase: String): String =
		OwnerBackup.export(json.encodeToString(Crypto.Identity.serializer(), ownerIdentity()), passphrase)

	/** Restore the owner root key from a backup blob. Refuses to overwrite a DIFFERENT existing
	 * owner so a backup carrying another owner key cannot silently re-root this device and brick
	 * the mesh; re-importing the same owner is idempotent. Synchronized with ownerIdentity() so a
	 * concurrent generation cannot overwrite the restored key. */
	@Synchronized
	fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult {
		val restored = runCatching { json.decodeFromString(Crypto.Identity.serializer(), OwnerBackup.restore(blob, passphrase)) }
			.getOrElse { return OwnerRestoreResult.WRONG_PASSPHRASE }
		// Only a decodable existing owner with a different key blocks the restore. An absent or
		// corrupt stored key is what restore recovers, so it proceeds.
		val existing = store.loadOwnerIdentity()
		if (existing is IdentityLoad.Loaded && existing.identity.sign.pub != restored.sign.pub) {
			return OwnerRestoreResult.DIFFERENT_OWNER
		}
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
	fun signXdomainLinkEdge(
		srcDomainId: String,
		dstDomainId: String,
		nowMs: Long,
		edgeNonce: String? = null,
	): SignedXDomainLinkEdge {
		val owner = ownerIdentity()
		// A caller may pin the nonce so a retry re-signs the same edge identity, which evie dedupes
		// by (srcDomainId, nonce); an unpinned caller mints a fresh one.
		val edge = XDomainLinkEdge(srcDomainId, dstDomainId, nowMs, edgeNonce ?: nonce())
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

	/** Owner-sign this owner's side of a cross-Domain link, binding the friend Gateway's keys the
	 * SAS confirmed out of band. The two sides are symmetric, each signed by its own phone-held
	 * owner key; the friend's Gateway verifies this side under this owner key and persists it as
	 * its cross-Domain peer. `nonce` is supplied so a retried confirm reuses the same signed link
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

	/** A fresh base64 nonce for an owner-signed link side. Exposed so the wizard can pin it for
	 * the lifetime of one pairing, keeping the signed link byte-stable across a retry. */
	fun freshLinkNonce(): String = nonce()

	/** Build a signed cross-tenant roster request: the console proves possession of its admitted
	 * signing key so evie can scope the roster to this owner's network. */
	fun signRosterRequest(nowMs: Long): com.atelier_nyaarium.switchboard.proto.RosterRequest {
		val console = consoleIdentity()
		val n = nonce()
		return com.atelier_nyaarium.switchboard.proto.RosterRequest(
			signerSignPub = console.sign.pub,
			proofAt = nowMs,
			nonce = n,
			proof = ProvisionOpsCrypto.signRosterRequest(console.sign.pub, nowMs, n, console.sign.priv),
		)
	}

	/** Build a signed gateway-bridge transport request. The owner key (not the console key) signs
	 * the TRANSPORT_REQUEST proof, because evie resolves the signer to a rooted owner and returns
	 * that network's transport after verifying and scoping to this owner. */
	fun signTransportRequest(nowMs: Long): com.atelier_nyaarium.switchboard.proto.TransportRequest {
		val owner = ownerIdentity()
		val n = nonce()
		return com.atelier_nyaarium.switchboard.proto.TransportRequest(
			signerSignPub = owner.sign.pub,
			proofAt = nowMs,
			nonce = n,
			proof = ProvisionOpsCrypto.signTransportRequest(owner.sign.pub, nowMs, n, owner.sign.priv),
		)
	}

	/** Build a signed "who armed trust toward me?" query. The arms are indexed by owner key, so the
	 * owner key (not the console key) signs the TRUST_PENDING proof; evie verifies and scopes to
	 * this owner before listing the arms. */
	fun signTrustPendingRequest(nowMs: Long): com.atelier_nyaarium.switchboard.proto.TrustPendingRequest {
		val owner = ownerIdentity()
		val n = nonce()
		return com.atelier_nyaarium.switchboard.proto.TrustPendingRequest(
			signerSignPub = owner.sign.pub,
			proofAt = nowMs,
			nonce = n,
			proof = ProvisionOpsCrypto.signTrustPendingRequest(owner.sign.pub, nowMs, n, owner.sign.priv),
		)
	}

	/** A fresh rendezvous id for a trust arm (also the SAS pin both sides bind). Unguessable so a
	 * third party cannot target a live rendezvous. */
	fun freshRendezvousId(): String = nonce()

	/** This owner's party for a trust compare: the owner keys plus the given local Domain. Reuses
	 * the EnrollParty shape so the SAS/commitment machinery is shared. */
	fun trustParty(domainId: String): com.atelier_nyaarium.switchboard.proto.EnrollParty {
		val owner = ownerIdentity()
		return com.atelier_nyaarium.switchboard.proto.EnrollParty(owner.sign.pub, owner.box.pub, domainId)
	}

	/** A fresh handshake id, minted by the admin into the enroll QR. Unguessable so a third party
	 * who learned a Domain cannot target a real ceremony window. */
	fun freshHandshakeId(): String = nonce()

	/** A fresh high-entropy enroll pin, minted by the admin into the QR. It rides the QR out of band
	 * and is never sent to evie, so the untrusted broker cannot grind a candidate compare code; the
	 * residual is the 6-digit blind online guess, not an offline search. */
	fun freshEnrollPin(): String = nonce()

	/** A fresh per-ceremony commitment salt, so the round-1 commitment is hiding (evie learns the
	 * peer's keys only at reveal, after it has had to commit to its own substitution). */
	fun freshEnrollSalt(): String = nonce()

	/** The current keyring: the stored snapshot, or an owner-only one before any sync. */
	fun keyring(): Keyring = Keyring.parse(store.loadDomain()) ?: Keyring.empty(ownerSignPub())

	/** Seal a bootstrap bundle (transport, the Gateway's admission, the current keyring, the network
	 * id) to the Gateway's box key, signed by this Console, wrapped in a delivery frame. The Gateway
	 * verifies the seal, checks the nonce and the owner-signed admission, and adopts `domainId` as
	 * its Domain id (it boots arming and learns the id from here). */
	fun sealBundle(
		nonce: String,
		transport: GatewayTransport,
		admission: SignedAdmission,
		recipientBoxPub: String,
		domainId: String?,
	): GatewayBootstrapFrame {
		val console = consoleIdentity()
		val bundle = GatewayBootstrapBundle(
			nonce = nonce,
			transport = transport,
			admission = admission,
			domain = keyring().snapshot,
			domainId = domainId,
		)
		val plain = json.encodeToString(GatewayBootstrapBundle.serializer(), bundle).toByteArray(Charsets.UTF_8)
		val sealed = Crypto.seal(plain, recipientBoxPub, console.sign.priv)
		return GatewayBootstrapFrame(
			v = 1L,
			signerSignPub = console.sign.pub,
			sealed = SealedEnvelope(sealed.ephemeralPub, sealed.nonce, sealed.ciphertext, sealed.signature),
		)
	}

	/** Apply a snapshot synced from a Gateway, but ONLY when it is rooted at this device's own owner
	 * key, so a relay that tampered with the root cannot swap the pinned owner out from under the
	 * Console. The server snapshot is folded OVER the current one for both admissions and
	 * revocations, deduped by signing key plus nonce and ordered by issue time. Both are append-only
	 * owner-signed facts, so the union is safe and convergent: a member the owner just admitted or
	 * revoked locally survives until evie rebroadcasts it, then the dedupe makes the rebroadcast
	 * idempotent. Taking revocations canonical-from-server alone would drop a locally-merged
	 * revocation on the next poll, letting a just-revoked member reappear until evie caught up. */
	@Synchronized
	fun applyDomainSync(snapshot: DomainSnapshot, version: String): Boolean {
		// Read the owner key without minting one. A sync arriving before this device has an owner,
		// or over a corrupt one, cannot be verified and must not seat a throwaway root.
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

	/** Fold a freshly owner-signed admission into the local keyring so the Console can seal to a
	 * member it just admitted, before evie's snapshot syncs back. Synchronized with applyDomainSync
	 * so a concurrent poll cannot overwrite the merge. */
	@Synchronized
	fun mergeAdmission(signed: SignedAdmission) {
		val current = keyring().snapshot
		val next = canonicalSnapshot(current.ownerSignPub, current.admissions + signed, current.revocations)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}

	/** Fold a freshly owner-signed revocation into the local keyring so the revoked member drops off
	 * the board immediately, before evie rebroadcasts it. Synchronized with applyDomainSync so a
	 * concurrent poll cannot overwrite the merge. */
	@Synchronized
	fun mergeRevocation(signed: SignedRevocation) {
		val current = keyring().snapshot
		val next = canonicalSnapshot(current.ownerSignPub, current.admissions, current.revocations + signed)
		store.saveDomain(json.encodeToString(DomainSnapshot.serializer(), next), store.loadDomainVersion())
	}

	////////////////////////////////
	//  Friend cross-Domain onboarding (pending tenant + first-root + display name)

	////////////////////////////////
	//  Trusted owners (the owner-keyed friend graph the Users surface reads)

	/** The owners this owner has completed a trust ceremony with, by ownerSignPub. The persistent
	 * friend edge, recorded even for a gateway-less person, distinct from the gateway-side
	 * relay-affinity edges that enable actual cross-Domain traffic. */
	@Synchronized
	fun trustedOwners(): Set<String> {
		val raw = store.loadTrustedOwners() ?: return emptySet()
		return runCatching {
			val arr = org.json.JSONArray(raw)
			(0 until arr.length()).map { arr.getString(it) }.toSet()
		}.getOrDefault(emptySet())
	}

	/** True iff this owner has trusted the given owner key. */
	fun isTrusted(ownerSignPub: String): Boolean = ownerSignPub.isNotEmpty() && trustedOwners().contains(ownerSignPub)

	/** Record a trust edge to an owner (idempotent). Called on a completed trust ceremony. */
	@Synchronized
	fun addTrustedOwner(ownerSignPub: String) {
		if (ownerSignPub.isEmpty()) return
		persistTrustedOwners(trustedOwners() + ownerSignPub)
	}

	/** Drop a trust edge to an owner (the untrust friend-graph half; the relay-edge revoke is separate). */
	@Synchronized
	fun removeTrustedOwner(ownerSignPub: String) {
		persistTrustedOwners(trustedOwners() - ownerSignPub)
	}

	/** Owner-sign an untrust tombstone withdrawing trust in a peer owner (myOwner -> peerOwner). */
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

	/** A fresh opaque Domain id (lowercase hex, never shown to the human). 16 random bytes is well
	 * under the 64-char slug bound and collides negligibly, so the admin never has to choose one. */
	fun newDomainId(): String {
		val bytes = ByteArray(16).also { rnd.nextBytes(it) }
		return bytes.joinToString("") { "%02x".format(it) }
	}

	/** Self-sign this device's first-root of a PENDING Domain at its owner key. No admission exists
	 * yet, so the artifact is self-signed (the verifier checks the signature against the embedded
	 * ownerSignPub) and the one-time invite `nonce` from the scanned blob is the authorization. evie
	 * roots the Domain idempotently on the same key and refuses a re-root at a different one. */
	fun signFirstRoot(domainId: String, nonce: String, nowMs: Long): SignedFirstRoot {
		val owner = ownerIdentity()
		val firstRoot = FirstRoot(domainId, owner.sign.pub, owner.box.pub, nonce, nowMs)
		return ProvisionOpsCrypto.signFirstRoot(firstRoot, owner.sign.priv)
	}

	/** Owner-sign a request to pre-stage a friend's PENDING tenant (an opaque domainId plus the
	 * friend's display name, no owner root). The signing nonce is this request's anti-replay token;
	 * evie mints the separate one-time invite nonce carried in the QR and returns it. */
	fun signProvisionTenant(domainId: String, displayName: String, nowMs: Long): SignedProvisionTenant {
		val owner = ownerIdentity()
		val provision = ProvisionTenant(domainId, displayName, nowMs, nonce())
		return ProvisionOpsCrypto.signProvision(provision, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a request to drop a tenant (pending or rooted) by its Domain id. */
	fun signRemoveTenant(domainId: String, nowMs: Long): SignedRemoveTenant {
		val owner = ownerIdentity()
		val removal = RemoveTenant(domainId, nowMs, nonce())
		return ProvisionOpsCrypto.signRemove(removal, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a rename of this owner's own display name. evie CAS-merges it onto the Domain
	 * record and pushes it to the Domain's gateways. The `domainId` is this owner's own rooted
	 * Domain; evie verifies the signature against the Domain's pinned owner key. */
	fun signSetDisplayName(domainId: String, displayName: String, nowMs: Long): SignedSetDisplayName {
		val owner = ownerIdentity()
		val rename = SetDisplayName(domainId, displayName, nowMs, nonce())
		return ProvisionOpsCrypto.signSetDisplayName(rename, owner.sign.priv, owner.sign.pub)
	}
}
