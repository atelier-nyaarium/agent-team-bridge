package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

internal class OwnerFacts(private val repo: ChatRepository) {
	/** First-root only after Router acceptance. */
	suspend fun firstRootIfPending(): Boolean {
		val blob = repo.identity.blob() ?: return true
		val prov = runCatching { ConsoleCredentials.parse(blob, repo.store) }.getOrNull() ?: return true
		return when (val decision = FriendOnboarding.decide(prov, repo.store.firstRooted)) {
			is FirstRootDecision.NotPending -> true
			is FirstRootDecision.Root -> {
				DebugLog.log("FirstRoot", "pending domain=${decision.domainId}; rooting at owner key ${repo.federation.ownerSas()}")
				val signed = repo.federation.signFirstRoot(decision.domainId, decision.nonce, System.currentTimeMillis())
				val result = runCatchingCancellable { repo.client().firstRoot(signed) }.getOrElse {
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
					// Transient rejects retry. Terminal rejects stop connect.
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

	fun ownerKeysForDisplay(): OwnerKeysView? = repo.federation.ownerKeysForDisplay()

	fun holdsOwnerKey(): Boolean = repo.federation.holdsDomainOwnerKey()

	// Scrypt stays off the main thread.
	suspend fun exportOwnerBackup(passphrase: String): String =
		withContext(Dispatchers.IO) { repo.federation.exportOwnerBackup(passphrase) }

	suspend fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult =
		withContext(Dispatchers.IO) { repo.identity.importOwnerBackup(blob, passphrase) }

	// Merge locally after Router acceptance while preserving cancellation.
	internal suspend fun <T> submitOwnerFact(
		signed: T,
		submit: suspend (T) -> EnrollResult,
		merge: (T) -> Unit,
		failLabel: String,
	): Boolean {
		val result = runCatchingCancellable { submit(signed) }.getOrElse {
			DebugLog.log("Enroll", "$failLabel: submit threw ${it.javaClass.simpleName}: ${it.message?.take(140)}")
			EnrollResult(ok = false, error = it.message)
		}
		if (!result.ok) {
			DebugLog.log("Enroll", "$failLabel: Router rejected: ${result.error?.take(140) ?: "unknown"}")
			repo._state.update { it.copy(error = "$failLabel: ${result.error?.take(120) ?: "unknown"}") }
			return false
		}
		merge(signed)
		repo.refreshAdmittedGateways()
		return true
	}

	suspend fun submitConsoleAdmission() {
		val blob = repo.identity.blob() ?: return
		if (repo.store.consoleAdmitted) {
			DebugLog.log("Enroll", "submit skipped: consoleAdmitted flag already set")
			return
		}
		val signed = repo.federation.consoleAdmission(System.currentTimeMillis())
		DebugLog.log("Enroll", "submitting console admission to the Router (owner ${Crypto.fingerprint(signed.ownerSignPub)})")
		if (submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitAdmission(it)) }, repo.identity::mergeAdmission, "Console admission rejected")) {
			repo.identity.setConsoleAdmitted(true, blob)
		} else {
			DebugLog.log("Federation", "console admission submit failed")
			error(repo._state.value.error ?: "Console admission rejected by the server")
		}
	}

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

	suspend fun revokeMember(signPub: String) = withContext(Dispatchers.IO) {
		val signed = repo.federation.revoke(signPub, System.currentTimeMillis())
		submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitRevocation(it)) }, repo.identity::mergeRevocation, "Revoke failed")
	}

	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String? = null): Boolean =
		withContext(Dispatchers.IO) {
			val signed = repo.federation.signXdomainLinkEdge(srcDomainId, dstDomainId, System.currentTimeMillis(), edgeNonce)
			submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitXdomainLink(it)) }, {}, "Link failed")
		}

	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean = withContext(Dispatchers.IO) {
		val signed = repo.federation.signXdomainLinkRevocation(srcDomainId, dstDomainId, System.currentTimeMillis())
		submitOwnerFact(signed, { repo.client().enroll(EnrollOp.RevokeXdomainLink(it)) }, {}, "Unlink failed")
	}

	fun admittedMembers(): List<MemberInfo> = repo.federation.members()
}
