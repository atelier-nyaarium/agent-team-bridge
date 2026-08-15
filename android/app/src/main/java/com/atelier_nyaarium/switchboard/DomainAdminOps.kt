package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollOp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** This owner's own display name and the guest tenants it hosts: rename/delete the owner's own
 * Domain, and stage/regenerate/remove the hosted-tenant invites (the "Networks you host" surface). */
internal class DomainAdminOps(private val repo: ChatRepository) {
	/** Rename this owner's own display name: owner-sign a SET_ADMIN_NAME op over the admin Domain and
	 * submit it evie-direct. On success cache the new name + reflect it immediately (evie pushes a
	 * domain_update to this owner's gateways, so discovery will confirm it on the next refresh). */
	suspend fun setDisplayName(name: String): Result<Unit> = withContext(Dispatchers.IO) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		val adminDomain = repo.confirmedDomainId()
			?: return@withContext Result.failure(IllegalStateException("Domain not yet confirmed by a local session"))
		runCatchingCancellable {
			val signed = repo.federation.signSetDisplayName(adminDomain, trimmed, System.currentTimeMillis())
			val result = repo.client().enroll(EnrollOp.SetDisplayName(signed))
			if (!result.ok) error(result.error ?: "rename rejected")
			repo.store.displayName = trimmed
			repo._state.update { it.copy(displayName = trimmed) }
		}
	}

	/** Revoke and delete this owner's OWN Domain (the app-only path; admins purge via setup.sh).
	 * Owner-sign the deletion FIRST, while the key still exists, then POST it evie-direct and await the
	 * result under a 30s ceiling. A confirmed purge AND an unconfirmed timeout/unreachable both wipe
	 * local state so the device is never left half-deleted; only an explicit evie rejection keeps state
	 * so the owner key survives a retry. The biometric gate (a destructive owner-key action) is at the
	 * call site, mirroring revoke/admit. */
	suspend fun deleteDomain(): DeleteDomainOutcome = withContext(Dispatchers.IO) {
		val domainId = repo.confirmedDomainId()
			?: runCatching { repo.store.load()?.let { Provisioning.parse(it).pendingTenant?.domainId } }.getOrNull()
		// No resolvable Domain id means nothing was ever rooted server-side; just wipe locally.
		if (domainId.isNullOrEmpty()) {
			repo.clearAll()
			return@withContext DeleteDomainOutcome.WipedUnconfirmed
		}
		val signed = repo.federation.signDeleteDomain(domainId, System.currentTimeMillis())
		// enroll() blocks on an OkHttp call (its own read timeout is the real ceiling) and THROWS when the
		// console bridge is unreachable. A reached-but-refused result keeps the owner key for a retry; a
		// throw (offline) falls to the unconfirmed wipe so a hung POST never strands the user mid-delete.
		val attempt = runCatchingCancellable { repo.client().enroll(EnrollOp.DeleteDomain(signed)) }
		val result = attempt.getOrNull()
		when {
			result?.ok == true -> {
				repo.clearAll()
				DeleteDomainOutcome.Deleted
			}
			attempt.isSuccess -> DeleteDomainOutcome.Rejected(result?.error ?: "delete rejected")
			else -> {
				repo.clearAll()
				DeleteDomainOutcome.WipedUnconfirmed
			}
		}
	}

	////////////////////////////////
	//  Networks you host (guest tenants the admin pre-stages)

	/** The guest tenants this owner has staged, each with its discovery-derived state
	 * (awaiting-setup -> offline -> online). The locally-persisted rows supply the label + the
	 * invite nonce (so a row can re-render its QR before the friend's gateway ever appears);
	 * discovery upgrades the state once the friend roots + brings a gateway online. */
	fun hostedTenants(): List<HostedTenant> {
		val stored = loadHostedTenants()
		val teams = repo._state.value.teams
		return stored.map { it.copy(state = FriendOnboarding.hostedState(it.domainId, teams)) }
	}

	/** Stage a new guest tenant: mint an opaque domainId, owner-sign a provision_tenant op, submit
	 * it evie-direct, and persist the row with the one-time invite nonce evie returns (the QR is
	 * built from it). Returns the new row, or a failure carrying evie's reason. */
	suspend fun provisionTenant(displayName: String): Result<HostedTenant> = withContext(Dispatchers.IO) {
		val label = displayName.trim()
		if (label.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		runCatchingCancellable {
			val domainId = repo.federation.newDomainId()
			val signed = repo.federation.signProvisionTenant(domainId, label, System.currentTimeMillis())
			val result = repo.client().provisionTenant(signed)
			val nonce = if (result.ok) result.nonce else null
			if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
			val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
			upsertHostedTenant(row)
			row
		}
	}

	/** Regenerate a pending tenant's one-time invite: re-submit provision_tenant for the SAME
	 * domainId, which mints a fresh nonce at evie (invalidating the prior one) without a remove +
	 * re-add. Returns the refreshed row. */
	suspend fun regenerateInvite(domainId: String, displayName: String): Result<HostedTenant> =
		withContext(Dispatchers.IO) {
			val label = displayName.trim().ifEmpty { return@withContext Result.failure(IllegalArgumentException("Name cannot be empty")) }
			runCatchingCancellable {
				val signed = repo.federation.signProvisionTenant(domainId, label, System.currentTimeMillis())
				val result = repo.client().provisionTenant(signed)
				val nonce = if (result.ok) result.nonce else null
				if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
				// A regenerated invite is a fresh ceremony: drop the prior handshake secrets so the next
				// buildInviteBlob mints new ones (the old QR's broker window is abandoned with its nonce).
				repo.enrollInvites.remove(domainId)
				val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
				upsertHostedTenant(row)
				row
			}
		}

	/** Build the invite blob a hosted tenant's QR encodes: the CONSOLE-bridge transport creds the
	 * admin was itself provisioned with (this owner's own blob) plus the pending tenant's
	 * {domainId, nonce}. The friend reaches the SAME shared evie console-bridge as the admin and
	 * first-roots over the console-bridge /relay path; the admin's own console-bridge SA +
	 * CONSOLE_BRIDGE_TOKEN is what authorizes the friend's first_root there. The route Gateway's
	 * bootstrap-transport would instead hand over the gateway-bridge SA + BRIDGE_TOKEN, which the
	 * console-bridge service-proxy RBAC-403s and evie token-401s. The blob omits service/port so the
	 * friend defaults to evie-console-bridge:20004. The JSON is what the paste / file-import path
	 * also accepts. */
	suspend fun buildInviteBlob(tenant: HostedTenant): Result<String> = withContext(Dispatchers.IO) {
		runCatching {
			val blob = repo.store.load() ?: error("This device is not provisioned. Re-import your setup blob first.")
			val prov = Provisioning.parse(blob)
			// Mint (once per tenant) the enroll-handshake secrets that seed the in-person compare and
			// embed them in the QR alongside this admin's owner keys + Domain. The pin rides the QR OUT
			// OF BAND (never sent to evie); the handshakeId keys the broker window the admin's leg polls.
			val invite = repo.enrollInvites.computeIfAbsent(tenant.domainId) {
				EnrollInvite(handshakeId = repo.federation.freshHandshakeId(), pin = repo.federation.freshEnrollPin())
			}
			val adminDomain = repo.confirmedDomainId() ?: error("Domain not yet confirmed by a local session")
			val enrollHandshake = JSONObject()
				.put("adminOwnerSignPub", repo.federation.ownerSignPub())
				.put("adminOwnerBoxPub", repo.federation.ownerBoxPub())
				.put("adminDomainId", adminDomain)
				.put("handshakeId", invite.handshakeId)
				.put("pin", invite.pin)
			// The invite carries whichever branch this owner is on, or a direct-mode owner mints
			// an invite pointing at an endpoint the friend cannot reach.
			val obj = JSONObject()
				.put("transport", prov.transport)
				.put("apiUrl", prov.apiUrl)
				.put("saToken", prov.saToken)
				.put("caPem", prov.caPem)
				.put("routerUrl", prov.routerUrl)
				.put("routerCertFp", prov.routerCertFp)
				.put("appToken", prov.appToken)
				.put("pendingTenant", JSONObject().put("domainId", tenant.domainId).put("nonce", tenant.nonce))
				.put("enrollHandshake", enrollHandshake)
			obj.toString()
		}
	}

	/** Drop a hosted tenant: owner-sign a remove_tenant op, submit it evie-direct, and forget the
	 * local row. evie deletes the Domain slice (and evicts a live guest gateway). */
	suspend fun removeHostedTenant(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatchingCancellable {
			val signed = repo.federation.signRemoveTenant(domainId, System.currentTimeMillis())
			val result = repo.client().enroll(EnrollOp.RemoveTenant(signed))
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
		val json = repo.store.loadHostedTenants() ?: return emptyList()
		// Parse skip-and-keep per row: a single malformed entry (a write tear, a manual edit) must not
		// collapse the whole list to empty, because the next upsert/delete would then persist that loss
		// and permanently discard every other staged tenant. One bad row is dropped; the rest survive.
		val arr = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
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
		runCatching { repo.store.saveHostedTenants(arr.toString()) }
	}
}
