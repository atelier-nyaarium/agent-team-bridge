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
import com.atelier_nyaarium.switchboard.proto.SetOperatorName
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedFirstRoot
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import com.atelier_nyaarium.switchboard.proto.SignedSetOperatorName
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
	fun signXdomainLinkEdge(
		srcDomainId: String,
		dstDomainId: String,
		nowMs: Long,
		edgeNonce: String? = null,
	): SignedXDomainLinkEdge {
		val owner = ownerIdentity()
		// A caller may PIN the nonce (the enroll ceremony) so a retry re-signs the same edge identity,
		// which evie dedupes by (srcDomainId, nonce); an unpinned caller mints a fresh one as before.
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

	/** Build a signed cross-tenant roster request: the console proves possession of its admitted
	 * signing key by signing a fresh ROSTER proof, so evie can scope the roster to this owner's
	 * network (and reject a key it cannot place in a Domain). */
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

	/** Build a signed FLOW-2 "who armed trust toward me?" query: the OWNER proves possession of its
	 * owner key (the arms are indexed by owner key, so the owner key - not the console key - signs the
	 * TRUST_PENDING proof). evie verifies + scopes to this owner before listing the arms. */
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

	/** A fresh rendezvous id for a FLOW-2 trust arm (also the SAS pin both sides bind). Unguessable so
	 * a third party cannot target a live rendezvous. */
	fun freshRendezvousId(): String = nonce()

	/** A fresh UNGUESSABLE handshake id, minted by the admin into the enroll QR. Unguessability is
	 * what stops a third party who learned a Domain from targeting a real ceremony window. */
	fun freshHandshakeId(): String = nonce()

	/** A fresh high-entropy enroll pin, minted by the admin into the QR. It rides the QR OUT OF BAND
	 * and is NEVER sent to evie, so the untrusted broker cannot compute a candidate compare code to
	 * grind - the residual is the 6-digit blind online guess, not an offline search. */
	fun freshEnrollPin(): String = nonce()

	/** A fresh per-ceremony commitment salt, so the round-1 commitment is hiding (evie learns the
	 * peer's keys only at reveal, after it has had to commit to its own substitution). */
	fun freshEnrollSalt(): String = nonce()

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

	////////////////////////////////
	//  Friend cross-Domain onboarding (pending tenant + first-root + operator name)

	////////////////////////////////
	//  Trusted owners (the owner-keyed friend graph the Users surface reads)

	/** The owners this owner has completed a trust ceremony with (enroll or link), by ownerSignPub.
	 * This is the persistent FRIEND edge - recorded even for a gateway-less person (the design's Q3=B)
	 * - distinct from the gateway-side relay-affinity edges that enable actual cross-Domain traffic. */
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

	/** A fresh opaque Domain id (a slug: lowercase hex, never shown to the human - pure
	 * plumbing). 16 random bytes hex-encoded is well under the 64-char slug bound and collides
	 * negligibly, so the operator never has to choose or check one. */
	fun newDomainId(): String {
		val bytes = ByteArray(16).also { rnd.nextBytes(it) }
		return bytes.joinToString("") { "%02x".format(it) }
	}

	/** Self-sign this device's first-root of a PENDING Domain at its silently-generated owner key.
	 * No admission exists yet, so the artifact is self-signed by the fresh owner key (the verifier
	 * checks the signature against the embedded ownerSignPub); the one-time invite `nonce` from the
	 * scanned blob is the authorization. evie roots the Domain idempotently on the same key and
	 * refuses a re-root at a different one. */
	fun signFirstRoot(domainId: String, nonce: String, nowMs: Long): SignedFirstRoot {
		val owner = ownerIdentity()
		val firstRoot = FirstRoot(domainId, owner.sign.pub, owner.box.pub, nonce, nowMs)
		return ProvisionOpsCrypto.signFirstRoot(firstRoot, owner.sign.priv)
	}

	/** Owner-sign a request to pre-stage a friend's PENDING tenant: an opaque domainId + a network
	 * display label, NO owner root. The signing nonce is the anti-replay token for this request;
	 * evie mints the SEPARATE one-time invite nonce (carried in the QR) and returns it. */
	fun signProvisionTenant(domainId: String, operatorName: String, nowMs: Long): SignedProvisionTenant {
		val owner = ownerIdentity()
		val provision = ProvisionTenant(domainId, operatorName, nowMs, nonce())
		return ProvisionOpsCrypto.signProvision(provision, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a request to drop a tenant (pending or rooted) by its Domain id. */
	fun signRemoveTenant(domainId: String, nowMs: Long): SignedRemoveTenant {
		val owner = ownerIdentity()
		val removal = RemoveTenant(domainId, nowMs, nonce())
		return ProvisionOpsCrypto.signRemove(removal, owner.sign.priv, owner.sign.pub)
	}

	/** Owner-sign a rename of this owner's own Domain network display name. evie CAS-merges it onto
	 * the Domain record and pushes it to the Domain's gateways. The `domainId` is this owner's own
	 * (rooted home) Domain; evie verifies the signature against the Domain's pinned owner key. */
	fun signSetOperatorName(domainId: String, operatorName: String, nowMs: Long): SignedSetOperatorName {
		val owner = ownerIdentity()
		val rename = SetOperatorName(domainId, operatorName, nowMs, nonce())
		return ProvisionOpsCrypto.signSetOperatorName(rename, owner.sign.priv, owner.sign.pub)
	}
}
