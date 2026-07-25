package com.atelier_nyaarium.switchboard.plugins

import com.atelier_nyaarium.switchboard.proto.EnabledPlugin

/** One plugin's row for the settings UI. */
data class PluginUiState(
	/** Composite id (the enabled-flag key and claim tag). */
	val id: String,
	val displayName: String,
	val version: String,
	val description: String,
	/** The persisted opt-in flag. */
	val enabled: Boolean,
	/** Whether the plugin is actually loaded this process (enabled AND its load succeeded). */
	val active: Boolean,
	/** Non-null when the plugin cannot load (bad manifest, duplicate id, entry threw); the
	 * settings toggle is disabled and this reason shown. */
	val broken: String?,
)

/**
 * Orchestrates the baked-in plugin lifecycle: nyaadot's INSTALLED -> ENABLED -> LOADED collapsed
 * to one persisted flag (baked = INSTALLED by shipping; enabled = loaded this process). Enabling
 * runs the plugin's [PluginEntry] inside its [SourceContext] window; disabling is one lifecycle
 * retract sweep. `requires` is enforced as a plain assert in both directions (no toposort, no
 * apt-style marks): enable refuses while a dep is off, disable refuses
 * while an enabled plugin still requires this one.
 *
 * All mutation is main-thread (boot + settings toggles); methods are synchronized as a backstop.
 */
class PluginManager(
	private val runtime: PluginRuntime,
	/** Public so extension-point consumers (ThreadScreen's dock slots) reach the registries. */
	val host: PluginHost,
	private val enabledStore: EnabledStore,
	readManifest: (assetDir: String) -> String,
	catalog: List<PluginCatalog.Entry>,
	// Log seam (the app passes DebugLog): android.util.Log is unavailable to the pure-JVM tests
	// that exercise the skip/failure paths, so the manager never touches it directly.
	private val log: (String) -> Unit = {},
) {
	/** Persistence seam so the manager stays pure JVM (the app adapts AppStateStore). */
	interface EnabledStore {
		fun isEnabled(id: String): Boolean

		fun setEnabled(id: String, on: Boolean)
	}

	private class Record(
		val assetDir: String,
		val entry: PluginEntry,
		val manifest: PluginManifest?,
		var broken: String?,
	) {
		val id: String
			get() = manifest?.compositeId ?: assetDir
	}

	private val records: List<Record>
	private val loaded = LinkedHashSet<String>()

	init {
		val seen = mutableSetOf<String>()
		records = catalog.map { entry ->
			val record = runCatching { PluginManifest.parse(readManifest(entry.assetDir)) }.fold(
				{ Record(entry.assetDir, entry.entry, it, broken = null) },
				{ Record(entry.assetDir, entry.entry, manifest = null, broken = "manifest failed to load: ${it.message}") },
			)
			if (record.manifest != null && !seen.add(record.id)) {
				record.broken = "duplicate plugin id \"${record.id}\""
			}
			record
		}
	}

	/** Load every enabled, satisfiable plugin. Passes repeat to a fixpoint so catalog order never
	 * decides correctness: a dependent listed before its dependency simply loads on a later pass.
	 * Within a pass, catalog order holds (deterministic). A genuinely unsatisfiable enabled plugin
	 * is skipped with a log; its flag survives (the opt-in is the user's, never flipped behind
	 * their back) and it activates on a later boot once the dep is on. */
	@Synchronized
	fun boot() {
		var progress = true
		while (progress) {
			progress = false
			records.forEach { record ->
				if (record.broken != null || record.manifest == null) return@forEach
				if (record.id in loaded) return@forEach
				if (!enabledStore.isEnabled(record.id)) return@forEach
				if (missingDep(record.manifest) != null) return@forEach
				if (load(record)) progress = true
			}
		}
		records.forEach { record ->
			val manifest = record.manifest ?: return@forEach
			if (record.broken == null && record.id !in loaded && enabledStore.isEnabled(record.id)) {
				log("boot: ${record.id} enabled but requires \"${missingDep(manifest)}\" (off); skipped")
			}
		}
	}

	/** Flip a plugin. Returns null on success, else the human-readable refusal. */
	@Synchronized
	fun setEnabled(id: String, on: Boolean): String? {
		val record = records.firstOrNull { it.id == id } ?: return "unknown plugin \"$id\""
		if (!on) {
			// Switching OFF is always reachable, broken plugins included - otherwise a flag left
			// on by a failing boot could never be cleared and the user would be locked out of
			// their own opt-out for the life of the install.
			if (record.id in loaded) {
				dependentOf(record)?.let { return "${label(record)} is still required by \"${label(it)}\"" }
				runtime.lifecycle.emitRetract(record.id)
				loaded.remove(record.id)
			}
			enabledStore.setEnabled(record.id, false)
			return null
		}
		record.broken?.let { return it }
		val manifest = record.manifest ?: return "unknown plugin \"$id\""
		if (record.id in loaded) return null
		missingDep(manifest)?.let { return "${label(record)} requires \"$it\", which is off" }
		if (!load(record)) return record.broken
		// Persist only after the load succeeded, so a throwing entry can never strand the flag on.
		enabledStore.setEnabled(record.id, true)
		return null
	}

	@Synchronized
	fun states(): List<PluginUiState> = records.map { record ->
		PluginUiState(
			id = record.id,
			displayName = record.manifest?.displayName?.ifEmpty { record.id } ?: record.assetDir,
			version = record.manifest?.version ?: "",
			description = record.manifest?.description ?: "",
			enabled = enabledStore.isEnabled(record.id),
			active = record.id in loaded,
			broken = record.broken,
		)
	}

	@Synchronized
	fun isActive(id: String): Boolean = id in loaded

	/**
	 * What this device reports to the gateway, so an agent's tools match what the owner can
	 * actually render. LOADED, not merely enabled: a plugin whose entry threw is switched on in
	 * settings but renders nothing, and promising an agent a surface that is broken here is worse
	 * than not offering it.
	 */
	@Synchronized
	fun reportable(): List<EnabledPlugin> = records.mapNotNull { record ->
		val manifest = record.manifest ?: return@mapNotNull null
		if (record.id !in loaded) return@mapNotNull null
		EnabledPlugin(id = record.id, instructions = manifest.agentInstructions.ifEmpty { null })
	}

	/** Run the entry hook inside the plugin's source window. A throwing entry may have landed
	 * partial claims, so the failure path retract-sweeps before marking the plugin broken -
	 * a half-registered plugin never stays half-live. */
	private fun load(record: Record): Boolean {
		val result = runCatching { runtime.context.with(record.id) { record.entry.register(host) } }
		return result.fold(
			{
				loaded.add(record.id)
				true
			},
			{
				runtime.lifecycle.emitRetract(record.id)
				record.broken = "failed to load: ${it.message}"
				log("load ${record.id} failed: ${it.message}")
				false
			},
		)
	}

	/** First `requires` entry not currently loaded, matching a dep by bare content id or
	 * composite id. Null when satisfied. */
	private fun missingDep(manifest: PluginManifest): String? =
		manifest.requires.firstOrNull { req ->
			records.none { r ->
				r.id in loaded && (r.manifest?.contentId == req.contentId || r.id == req.contentId)
			}
		}?.contentId

	/** A loaded plugin that requires [record], matched by bare content id OR composite id -
	 * symmetric with [missingDep], so the disable gate cannot be dodged by a `requires` entry
	 * naming its dep the other way. */
	private fun dependentOf(record: Record): Record? {
		val contentId = record.manifest?.contentId ?: return null
		return records.firstOrNull { r ->
			r.id != record.id && r.id in loaded &&
				r.manifest?.requires?.any { it.contentId == contentId || it.contentId == record.id } == true
		}
	}

	private fun label(record: Record): String = record.manifest?.displayName?.ifEmpty { record.id } ?: record.id
}
