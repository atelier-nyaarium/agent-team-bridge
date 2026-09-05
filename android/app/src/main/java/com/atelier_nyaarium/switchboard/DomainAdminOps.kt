package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SignedDeleteDomain
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetDisplayName
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal interface DomainAdminOpsCollaborators {
	fun enrollInvites(): MutableMap<String, EnrollInvite>
	fun ownerBoxPub(): String
	fun freshHandshakeId(): String
	fun freshEnrollPin(): String
	fun newDomainId(): String
	fun signSetDisplayName(domainId: String, name: String, nowMs: Long): SignedSetDisplayName
	fun signDeleteDomain(domainId: String, nowMs: Long): SignedDeleteDomain
	fun signProvisionTenant(domainId: String, name: String, nowMs: Long): SignedProvisionTenant
	fun signRemoveTenant(domainId: String, nowMs: Long): SignedRemoveTenant
	suspend fun clearAll()
}

internal class DomainAdminOps(
	private val state: MutableStateFlow<ChatState>,
	private val store: AppStateStore,
	private val identity: IdentityPort,
	private val client: ClientPort,
	private val collaborators: DomainAdminOpsCollaborators,
) {
	suspend fun setDisplayName(name: String): Result<Unit> = withContext(Dispatchers.IO) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		val adminDomain = identity.readyOrNull()?.domainId
			?: return@withContext Result.failure(IllegalStateException("Domain not yet confirmed by a local session"))
		runCatchingCancellable {
			val signed = collaborators.signSetDisplayName(adminDomain, trimmed, System.currentTimeMillis())
			val result = client.client().enroll(EnrollOp.SetDisplayName(signed))
			if (!result.ok) error(result.error ?: "rename rejected")
			store.displayName = trimmed
			state.update { it.copy(displayName = trimmed) }
		}
	}

	// Owner-sign before deletion can remove the key.
	suspend fun deleteDomain(): DeleteDomainOutcome = withContext(Dispatchers.IO) {
		val domainId = identity.readyOrNull()?.domainId
			?: runCatching { store.load()?.let { ConsoleCredentials.parse(it, store).pendingTenant?.domainId } }.getOrNull()
		if (domainId.isNullOrEmpty()) {
			collaborators.clearAll()
			return@withContext DeleteDomainOutcome.WipedUnconfirmed
		}
		val signed = collaborators.signDeleteDomain(domainId, System.currentTimeMillis())
		val attempt = runCatchingCancellable { client.client().enroll(EnrollOp.DeleteDomain(signed)) }
		val result = attempt.getOrNull()
		// Refusals preserve the owner key; unreachable deletion wipes local state.
		when {
			result?.ok == true -> {
				collaborators.clearAll()
				DeleteDomainOutcome.Deleted
			}
			attempt.isSuccess -> DeleteDomainOutcome.Rejected(result?.error ?: "delete rejected")
			else -> {
				collaborators.clearAll()
				DeleteDomainOutcome.WipedUnconfirmed
			}
		}
	}

	// Forget is local-only and sends no Router operation.
		suspend fun forgetDomain() = withContext(Dispatchers.IO) { collaborators.clearAll() }

	fun hostedTenants(): List<HostedTenant> {
		val stored = loadHostedTenants()
		val teams = state.value.teams
		return stored.map { it.copy(state = FriendOnboarding.hostedState(it.domainId, teams)) }
	}

	suspend fun provisionTenant(displayName: String): Result<HostedTenant> = withContext(Dispatchers.IO) {
		val label = displayName.trim()
		if (label.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		runCatchingCancellable {
				val domainId = collaborators.newDomainId()
				val signed = collaborators.signProvisionTenant(domainId, label, System.currentTimeMillis())
				val result = client.client().provisionTenant(signed)
			val nonce = if (result.ok) result.nonce else null
			if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
			val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
			upsertHostedTenant(row)
			row
		}
	}

	suspend fun regenerateInvite(domainId: String, displayName: String): Result<HostedTenant> =
		withContext(Dispatchers.IO) {
			val label = displayName.trim().ifEmpty { return@withContext Result.failure(IllegalArgumentException("Name cannot be empty")) }
			runCatchingCancellable {
				val signed = collaborators.signProvisionTenant(domainId, label, System.currentTimeMillis())
				val result = client.client().provisionTenant(signed)
				val nonce = if (result.ok) result.nonce else null
				if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
				// Re-enrollment uses the same Domain with fresh invite secrets.
				collaborators.enrollInvites().remove(domainId)
				val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
				upsertHostedTenant(row)
				row
			}
		}

	suspend fun buildInviteBlob(tenant: HostedTenant): Result<String> = withContext(Dispatchers.IO) {
		runCatching {
			val blob = store.load() ?: error("This device is not provisioned. Re-import your setup blob first.")
			val prov = ConsoleCredentials.parse(blob, store)
			// The pin stays out of the Router; the invite carries the admin endpoint.
			val invite = collaborators.enrollInvites().getOrPut(tenant.domainId) {
				EnrollInvite(handshakeId = collaborators.freshHandshakeId(), pin = collaborators.freshEnrollPin())
			}
			val boot = identity.readyOrNull() ?: error("Domain not yet confirmed by a local session")
			val adminDomain = boot.domainId
			val enrollHandshake = JSONObject()
				.put("adminOwnerSignPub", boot.ownerSignPub)
				.put("adminOwnerBoxPub", collaborators.ownerBoxPub())
				.put("adminDomainId", adminDomain)
				.put("handshakeId", invite.handshakeId)
				.put("pin", invite.pin)
			val obj = JSONObject()
				.put("routerUrl", prov.routerUrl)
				.put("routerCertFp", prov.routerCertFp)
				.put("appToken", prov.appToken)
				.put("pendingTenant", JSONObject().put("domainId", tenant.domainId).put("nonce", tenant.nonce))
				.put("enrollHandshake", enrollHandshake)
			obj.toString()
		}
	}

	suspend fun removeHostedTenant(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
		val signed = collaborators.signRemoveTenant(domainId, System.currentTimeMillis())
			val result = client.client().enroll(EnrollOp.RemoveTenant(signed))
			if (!result.ok) error(result.error ?: "remove rejected")
			deleteHostedTenant(domainId)
		}
	}

	private fun upsertHostedTenant(row: HostedTenant) {
		val rows = loadHostedTenants().filterNot { it.domainId == row.domainId } + row
		persistHostedTenants(rows)
	}

	private fun deleteHostedTenant(domainId: String) {
		persistHostedTenants(loadHostedTenants().filterNot { it.domainId == domainId })
	}

	private fun loadHostedTenants(): List<HostedTenant> {
		val json = store.loadHostedTenants() ?: return emptyList()
		val arr = runCatching { JSONArray(json) }.getOrNull()
		if (arr == null) {
			DebugLog.log("Persist", "hosted-tenants blob unparseable (${json.length} chars), treating as none")
			return emptyList()
		}
		// Skip malformed rows without discarding valid tenants.
		return (0 until arr.length()).mapNotNull { i ->
			runCatching {
				val o = arr.getJSONObject(i)
				HostedTenant(
					domainId = o.getString("domainId"),
					displayName = o.getString("displayName"),
					nonce = o.getString("nonce"),
					state = HostedTenantState.AWAITING_SETUP,
				)
			}.getOrNull()
		}
	}

	private fun persistHostedTenants(rows: List<HostedTenant>) {
		val arr = JSONArray()
		for (r in rows) {
			arr.put(JSONObject().put("domainId", r.domainId).put("displayName", r.displayName).put("nonce", r.nonce))
		}
		runCatching { store.saveHostedTenants(arr.toString()) }
	}
}
