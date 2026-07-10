package com.atelier_nyaarium.switchboard.plugins

import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A plugin's identity manifest, the nyaadot source-package identity schema (plans/plugins.md,
 * "nyaadot keep / toss"). Each baked-in plugin folder `assets/plugins/<content_id>/` carries a
 * `manifest.json` shaped like what the plugin's standalone repo would hold, so a later extraction
 * to a real installable is a folder move.
 *
 * `entry_point` is reserved-unused: the app never loads code at runtime, so the entry hook is a
 * compiled [PluginEntry] class named in [PluginCatalog]. The field exists so a manifest written for
 * a future dynamic runtime needs no schema change.
 */
@Serializable
data class PluginManifest(
	val author: String = "",
	@SerialName("content_id") val contentId: String,
	val version: String = "0.0.0",
	@SerialName("display_name") val displayName: String = "",
	val description: String = "",
	val requires: List<PluginRequirement> = emptyList(),
	@SerialName("entry_point") val entryPoint: String = "",
) {
	/** Globally unique id: `<author>.<content_id>`, bare `<content_id>` when authorless
	 * (first-party). This is the id claims are tagged with and the enabled flag is keyed by. */
	val compositeId: String
		get() = if (author.isEmpty()) contentId else "$author.$contentId"

	companion object {
		/** Dotless slug: the composite id joins segments with `.`, so a segment may not contain one. */
		private val SLUG = Regex("^[a-z0-9][a-z0-9-]*$")

		/** Decode + validate a manifest. Unknown keys are ignored (forward compat); a missing or
		 * non-slug `content_id`/`author` refuses. Throws on any failure - a baked-in manifest that
		 * does not parse is a build defect, pinned by the catalog agreement unit test. */
		fun parse(json: String): PluginManifest {
			val manifest = wireJson.decodeFromString(serializer(), json)
			require(SLUG.matches(manifest.contentId)) {
				"manifest content_id \"${manifest.contentId}\" is not a slug ([a-z0-9][a-z0-9-]*)"
			}
			require(manifest.author.isEmpty() || SLUG.matches(manifest.author)) {
				"manifest author \"${manifest.author}\" is not a slug ([a-z0-9][a-z0-9-]*)"
			}
			manifest.requires.forEach {
				require(it.contentId.isNotEmpty()) { "manifest requires entry with empty content_id" }
			}
			return manifest
		}
	}
}

/** A hard dependency on another plugin, by content id (nyaadot's `requires: [{content_id}]`).
 * No semver matching; baked-in plugins version together with the APK. */
@Serializable
data class PluginRequirement(
	@SerialName("content_id") val contentId: String,
)
