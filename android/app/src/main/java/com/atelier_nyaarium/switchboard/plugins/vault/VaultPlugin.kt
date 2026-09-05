package com.atelier_nyaarium.switchboard.plugins.vault

import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.plugins.AccountWipeHandler
import com.atelier_nyaarium.switchboard.plugins.PluginActionHandler
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.ThreadForgetHandler
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultRetract
import com.atelier_nyaarium.switchboard.wireJson

/** The Vault plugin's entry hook (manifest: `assets/plugins/vault/manifest.json`). */
class VaultPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		val repo = Repo.get(host.applicationContext)
		// The manager drops a redispatched request by id.
		host.pluginActions.claim("vault:request", PluginActionHandler { action ->
			val payload = action.payload ?: return@PluginActionHandler
			val request = runCatching { wireJson.decodeFromJsonElement(VaultRequest.serializer(), payload) }.getOrNull()
				?: return@PluginActionHandler
			repo.vaultOps.onRequest(action.team, request)
		})
		// The request settled elsewhere; an unknown id is nothing to drop.
		host.pluginActions.claim("vault:retract", PluginActionHandler { action ->
			val payload = action.payload ?: return@PluginActionHandler
			val retract = runCatching { wireJson.decodeFromJsonElement(VaultRetract.serializer(), payload) }.getOrNull()
				?: return@PluginActionHandler
			repo.vault.settleRequest(retract.requestId)
		})
		host.threadForgetHandlers.claim("vault:forget", ThreadForgetHandler { _, team -> repo.vault.forgetTeam(team) })
		host.accountWipeHandlers.claim("vault:wipe", AccountWipeHandler { _ -> repo.vault.wipe() })
		// Off leaves nothing to answer.
		host.onRetract { id -> if (id == "vault") repo.vault.clearRequests() }
	}
}
