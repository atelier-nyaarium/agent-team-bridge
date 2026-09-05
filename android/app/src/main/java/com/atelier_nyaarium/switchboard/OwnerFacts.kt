package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

/** What the owner signs, holds and submits: first-rooting a pending Domain, the owner root key and
 * its backup, and every admission / revocation / cross-Domain-link fact submitted through the
 * merge-iff-accepted path, plus the membership that path leaves in the keyring. */
internal class OwnerFacts(private val repo: ChatRepository) {
	/** First-root a pending friend Domain if the imported blob carries one (and it is not yet
	 * rooted). Builds a FirstRoot over this device's silent owner key + the invite nonce, self-signs
	 * it (FederationManager), and POSTs it to the Router's console-bridge firstRoot intake. Returns true to
	 * let connect() proceed (nothing pending, already rooted, or a fresh root just succeeded), false
	 * to abort connect after surfacing a terminal reject (an expired / already-claimed invite, which
	 * does not self-heal). Idempotent: the firstRooted latch skips the round-trip on later connects. */
	suspend fun firstRootIfPending(): Boolean {
		val blob = repo.identity.blob() ?: return true
		val prov = runCatching { ConsoleCredentials.parse(blob, repo.store) }.getOrNull() ?: return true
		return when (val decision = FriendOnboarding.decide(prov, repo.store.firstRooted)) {
			is FirstRootDecision.NotPending -> true
			is FirstRootDecision.Root -> {
				DebugLog.log("FirstRoot", "pending domain=${decision.domainId}; rooting at owner key ${repo.federation.ownerSas()}")
				val signed = repo.federation.signFirstRoot(decision.domainId, decision.nonce, System.currentTimeMillis())
				val result = runCatchingCancellable { repo.client().firstRoot(signed) }.getOrElse {
					// A transport failure here is NOT terminal: the root was not decided, only
					// unreachable. Surface a transient cause and let the poll loop retry.
					val (cause, _) = classifyConnError(it)
					repo._state.update { s -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L) }
					return false
				}
				if (result.ok) {
					repo.identity.markFirstRooted(blob)
					repo.readyOrNull()?.let(repo.identity::ensureContentEpochs)
					DebugLog.log("FirstRoot", "rooted ok domain=${decision.domainId}")
					true
				} else {
					// A transient Router reject (clock skew, CAS persist contention) leaves the latch
					// false and the poll loop re-attempts, so it surfaces as "connecting" (auto-retry),
					// not a terminal "error" that the user reads as a dead end.
					val reject = FriendOnboarding.classifyFirstRootError(result.error)
					DebugLog.log("FirstRoot", "rejected (transient=${reject.transient}): ${result.error?.take(120)}")
					repo._state.update {
						it.copy(
							status = if (reject.transient) "connecting" else "error",
							error = reject.message,
							connected = false,
							enrollingSince = 0L,
						)
					}
					false
				}
			}
		}
	}

	/** Owner public material for the settings cards, or null when the stored owner key is
	 * corrupt. Non-throwing so a corrupt key renders a restore prompt rather than crashing the
	 * card; an absent key still mints (the silent first-gen). */
	fun ownerKeysForDisplay(): OwnerKeysView? = repo.federation.ownerKeysForDisplay()

	/** Whether this device holds the Domain's owner key (see [FederationManager.holdsDomainOwnerKey]).
	 * Non-minting, so a screen may ask it of an admitted second console safely. */
	fun holdsOwnerKey(): Boolean = repo.federation.holdsDomainOwnerKey()

	/** A passphrase-encrypted backup of the owner root key for offline safekeeping. */
	// Runs the scrypt KDF, so it stays off the main thread (the UI dispatches it from a
	// coroutine) - the same posture as importOwnerBackup.
	suspend fun exportOwnerBackup(passphrase: String): String =
		withContext(Dispatchers.IO) { repo.federation.exportOwnerBackup(passphrase) }

	/** Restore the owner root key from a backup blob. The result lets the UI distinguish a
	 * wrong passphrase from a different-owner rejection. */
	suspend fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult =
		withContext(Dispatchers.IO) { repo.identity.importOwnerBackup(blob, passphrase) }

	/** Submit an owner-signed fact to the Router and fold it into the local keyring ONLY if the
	 * Router accepted it, surfacing the error otherwise. The merge-iff-accepted invariant lives in
	 * this one place so an owner action cannot submit without the matching local merge
	 * (otherwise a revoked member could remain visible on the board). Secondary effects (the
	 * route-gateway pin, the console-admitted gate) stay at the call site after a true return. */
	// internal (not private): DeviceApprovalOps.approveDevice submits its own owner-signed admission
	// through this same merge-iff-accepted path.
	internal suspend fun <T> submitOwnerFact(
		signed: T,
		submit: suspend (T) -> EnrollResult,
		merge: (T) -> Unit,
		failLabel: String,
	): Boolean {
		val result = runCatchingCancellable { submit(signed) }.getOrElse {
			// runCatchingCancellable, not plain runCatching: submit() is the network call for all 6
			// owner-fact callers (submitConsoleAdmission, admitGateway, revokeMember, submitXdomainLink,
			// revokeXdomainLink, approveDevice) - a swallowed cancellation here would convert every one
			// of their cancellations into a normal EnrollResult(ok=false) rejection.
			DebugLog.log("Enroll", "$failLabel: submit threw ${it.javaClass.simpleName}: ${it.message?.take(140)}")
			EnrollResult(ok = false, error = it.message)
		}
		if (!result.ok) {
			DebugLog.log("Enroll", "$failLabel: Router rejected: ${result.error?.take(140) ?: "unknown"}")
			repo._state.update { it.copy(error = "$failLabel: ${result.error?.take(120) ?: "unknown"}") }
			return false
		}
		merge(signed)
		// Every owner-signed fold lands here, so the sessions board picks up an admit or a revoke now
		// rather than on the next Domain sync.
		repo.refreshAdmittedGateways()
		return true
	}

	/** Submit this Console's own owner-signed admission to the Router so a Gateway trusts its
	 * sealed ops. The enroll op is bearer-gated (not sealed), so it lands before the
	 * Console is admitted; gated by a flag so connect does not re-issue it every cycle.
	 * The gateway may still be syncing the admission - the ENROLLING grace covers that. */
	suspend fun submitConsoleAdmission() {
		val blob = repo.identity.blob() ?: return
		if (repo.store.consoleAdmitted) {
			// Distinguishes "the app believes it is already admitted and never POSTs" (which would
			// explain zero enroll ops reaching the Router) from "it POSTs and the submit fails".
			DebugLog.log("Enroll", "submit skipped: consoleAdmitted flag already set")
			return
		}
		val signed = repo.federation.consoleAdmission(System.currentTimeMillis())
		DebugLog.log("Enroll", "submitting console admission to the Router (owner ${Crypto.fingerprint(signed.ownerSignPub)})")
		// submitOwnerFact surfaces the real cause (e.g. the Router rooted at a different owner key)
		// so it does not hide behind the generic "finishing enrollment" the register hits next.
		if (submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitAdmission(it)) }, repo.identity::mergeAdmission, "Console admission rejected")) {
			repo.identity.setConsoleAdmitted(true, blob)
		} else {
			DebugLog.log("Federation", "console admission submit failed")
			// Throw so connect() surfaces this SPECIFIC cause and stops; otherwise register() runs
			// next and overwrites it with the generic sync-lag "finishing enrollment", masking it.
			error(repo._state.value.error ?: "Console admission rejected by the server")
		}
	}

	/** Owner-admit a scanned Gateway: owner-sign its admission, submit it to the Router, and
	 * fold it into the local keyring so the Console can seal to it immediately (before
	 * the Router's snapshot syncs back). Returns the signed admission for the caller to seal
	 * into the bootstrap bundle, or null on failure. */
	suspend fun admitGateway(gatewayId: String, signPub: String, boxPub: String): SignedAdmission? =
		withContext(Dispatchers.IO) {
			val signed = repo.federation.admitGateway(gatewayId, signPub, boxPub, System.currentTimeMillis())
			if (!submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitAdmission(it)) }, repo.identity::mergeAdmission, "Admit failed")) {
				return@withContext null
			}
			if (repo.store.loadGatewayId().isEmpty()) {
				repo.store.saveGatewayId(gatewayId)
				repo.homeGatewayId = gatewayId
			}
			signed
		}

	/** Owner-revoke a member by its signing key: sign a revocation, submit it to the Router,
	 * and drop the member from the local keyring. */
	suspend fun revokeMember(signPub: String) = withContext(Dispatchers.IO) {
		val signed = repo.federation.revoke(signPub, System.currentTimeMillis())
		// The local merge folds the revocation into the keyring on success, so the member
		// drops off the board now instead of waiting for the Router to rebroadcast it.
		submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitRevocation(it)) }, repo.identity::mergeRevocation, "Revoke failed")
	}

	/** Owner-sign a cross-Domain link edge (this Domain -> a linked friend Domain) and submit
	 * it to the Router so its relay-affinity gate permits the cross-Domain crosstalk. Called on a
	 * link-handshake confirm. Returns true iff the Router accepted it. There is no local keyring
	 * merge: the edge lives only in the Router's edge set (the cross-Domain peer + its keys are
	 * written by the handshake confirm, not by this edge). */
	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String? = null): Boolean =
		withContext(Dispatchers.IO) {
			val signed = repo.federation.signXdomainLinkEdge(srcDomainId, dstDomainId, System.currentTimeMillis(), edgeNonce)
			submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitXdomainLink(it)) }, {}, "Link failed")
		}

	/** Owner-sign a cross-Domain link-edge revocation and submit it to the Router so its
	 * relay-affinity gate refuses the cross-Domain crosstalk again. Called on unlink. Returns
	 * true iff the Router accepted it. No local keyring merge, for the same reason as the edge. */
	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean = withContext(Dispatchers.IO) {
		val signed = repo.federation.signXdomainLinkRevocation(srcDomainId, dstDomainId, System.currentTimeMillis())
		submitOwnerFact(signed, { repo.client().enroll(EnrollOp.RevokeXdomainLink(it)) }, {}, "Unlink failed")
	}

	/** The admitted members of the keyring, for the management board. */
	fun admittedMembers(): List<MemberInfo> = repo.federation.members()
}
