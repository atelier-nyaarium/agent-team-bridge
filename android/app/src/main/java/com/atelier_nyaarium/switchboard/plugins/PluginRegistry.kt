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

	/** Runs [action] against every claimed value, catching any exception so one broken plugin's
	 * claim costs only itself, never the caller's loop. [onError] receives a claim-identifying
	 * message plus the throwable; the default swallows (kept Android-free so this stays pure-JVM
	 * testable, mirroring PluginManager's injected `log` seam) - callers with a logger should
	 * pass one. */
	@Synchronized
	fun forEachCaught(onError: (String, Throwable) -> Unit = { _, _ -> }, action: (T) -> Unit) {
		claims.forEach { (key, claim) ->
			runCatching { action(claim.value) }
				.onFailure { onError("registry \"$name\": claim \"$key\" (source \"${claim.source}\") threw", it) }
		}
	}

	/** True on the first claimed value for which [predicate] returns true (first-claim-wins).
	 * A throwing claim counts as "did not claim" (reported via [onError], never fatal) and
	 * consultation continues to the next claimant. */
	@Synchronized
	fun anyCaught(onError: (String, Throwable) -> Unit = { _, _ -> }, predicate: (T) -> Boolean): Boolean {
		for ((key, claim) in claims) {
			val matched = runCatching { predicate(claim.value) }
				.onFailure { onError("registry \"$name\": claim \"$key\" (source \"${claim.source}\") threw", it) }
				.getOrDefault(false)
			if (matched) return true
		}
		return false
	}

	/** The first non-null result of [transform] across claimed values (first-claim-wins), or null
	 * when no claim produces one. A throwing claim counts as null (reported via [onError], never
	 * fatal) and consultation continues to the next claimant. */
	@Synchronized
	fun <R : Any> firstNotNullCaught(onError: (String, Throwable) -> Unit = { _, _ -> }, transform: (T) -> R?): R? {
		for ((key, claim) in claims) {
			val result = runCatching { transform(claim.value) }
				.onFailure { onError("registry \"$name\": claim \"$key\" (source \"${claim.source}\") threw", it) }
				.getOrNull()
			if (result != null) return result
		}
		return null
	}

	/** Drop every claim [source] made. Reached only through the lifecycle bus sweep. */
	@Synchronized
	internal fun retractSource(source: String) {
		claims.entries.removeAll { it.value.source == source }
	}
}
