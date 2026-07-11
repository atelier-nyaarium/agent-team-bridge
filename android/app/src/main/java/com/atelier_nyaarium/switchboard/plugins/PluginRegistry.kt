package com.atelier_nyaarium.switchboard.plugins

/**
 * A source-tagged claim table, the one extension-point primitive. Core code owning an extension
 * surface creates a registry via [PluginRuntime.createRegistry]; plugins [claim] keys into it
 * during their registration window and the tag comes from [SourceContext] automatically.
 *
 * A key collision REFUSES loudly instead of shadowing (nyaadot's ShadowIndex was deliberately
 * tossed: last-wins silent override is a modding-ecosystem feature and a first-party-app bug).
 * Convention: plugins namespace their keys `<plugin>:<key>`.
 */
class PluginRegistry<T : Any> internal constructor(
	val name: String,
	private val context: SourceContext,
) {
	private class Claim<T>(val source: String, val value: T)

	private val claims = LinkedHashMap<String, Claim<T>>()

	/** Claim [key]. The claim is tagged with the active source (or [CORE_SOURCE] outside any
	 * registration window) and swept by that source's retract. Throws on a duplicate key. */
	@Synchronized
	fun claim(key: String, value: T) {
		val source = context.current().ifEmpty { CORE_SOURCE }
		val existing = claims[key]
		check(existing == null) {
			"registry \"$name\": key \"$key\" already claimed by \"${existing?.source}\" (claim by \"$source\" refused)"
		}
		claims[key] = Claim(source, value)
	}

	@Synchronized
	fun get(key: String): T? = claims[key]?.value

	@Synchronized
	fun sourceOf(key: String): String? = claims[key]?.source

	@Synchronized
	fun keys(): List<String> = claims.keys.toList()

	@Synchronized
	fun values(): List<T> = claims.values.map { it.value }

	@Synchronized
	fun size(): Int = claims.size

	/** Drop every claim [source] made. Reached only through the lifecycle bus sweep. */
	@Synchronized
	internal fun retractSource(source: String) {
		claims.entries.removeAll { it.value.source == source }
	}
}
