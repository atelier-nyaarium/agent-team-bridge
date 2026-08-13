package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

////////////////////////////////
//  Voice settings and credentials
//
//  Extensions rather than members: none of this holds state. The one cached field the surface has
//  (ChatRepository.sttsClient) stays declared on the class, since an extension has no backing field.

/** STTS client from the settings-backed creds (NOT the blob), or null when not
 * configured. The cache is invalidated by setSttsCreds() on an in-app edit, the
 * one mutation point - so an edited key takes effect without an app restart. */
// internal (not private): PlaybackOps resolves the client for every actual playback call.
internal fun ChatRepository.sttsClient(): SttsClient? {
	sttsClient?.let { return it.takeIf { c -> c.isConfigured } }
	// Cache only a configured client, so an unconfigured build (fresh install, no key yet)
	// is not retained as an idle OkHttpClient until creds arrive.
	return SttsClient(store.sttsUrl, store.sttsKey).takeIf { it.isConfigured }?.also { sttsClient = it }
}

/** Gates the Play surfaces; true once settings carry sttsUrl + sttsKey AND the
 * bundled catalog parsed (without descriptors there is nothing to play). */
fun ChatRepository.sttsReady(): Boolean = sttsClient() != null && sttsCatalog.isNotEmpty()

/** True when settings carry a non-empty url + key (the Connection block is
 * configured), independent of catalog/health. */
fun ChatRepository.sttsConfigured(): Boolean = store.sttsUrl.isNotEmpty() && store.sttsKey.isNotEmpty()

/** The current in-app voice creds, for seeding the settings Connection fields. */
val ChatRepository.sttsUrl: String get() = store.sttsUrl
val ChatRepository.sttsKey: String get() = store.sttsKey

/** The single mutation choke for the in-app voice creds: validate+normalize the URL
 * (via normalizeSttsUrl, so the key is never persisted to an unvalidated host), store the
 * clean origin + trimmed key, and invalidate the cached client so the next sttsClient()
 * rebuilds. Returns the stored origin, or null if the URL is invalid (nothing persisted),
 * which the caller surfaces. Enforcing validation HERE means no caller can bypass it. */
fun ChatRepository.setSttsCreds(url: String, key: String): String? {
	val origin = normalizeSttsUrl(url) ?: return null
	store.sttsUrl = origin
	store.sttsKey = key.trim()
	sttsClient = null
	return origin
}

/** The provider descriptors for the settings picker. */
fun ChatRepository.sttsProviders(): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = sttsCatalog

/** The selected provider id (the descriptor id, e.g. "XAI"). Unset resolves
 * to XAI when present, else the first descriptor. */
var ChatRepository.sttsProviderId: String
	get() {
		val stored = store.sttsProvider
		if (stored.isNotEmpty()) return stored
		return sttsCatalog.firstOrNull { it.id == "XAI" }?.id ?: sttsCatalog.firstOrNull()?.id ?: ""
	}
	set(value) {
		store.sttsProvider = value
	}

/** The descriptor for the current selection, or null if the stored id is not
 * in the catalog (a removed provider) - the Play surfaces disable loudly
 * rather than silently substituting another voice. */
// internal (not private): PlaybackOps resolves the provider for every actual playback call.
internal fun ChatRepository.currentProvider(): com.atelier_nyaarium.switchboard.proto.SttsProvider? {
	val id = sttsProviderId
	return sttsCatalog.firstOrNull { it.id == id }
}

/** True when the stored provider id is non-empty but absent from the catalog. */
fun ChatRepository.sttsProviderMissing(): Boolean {
	val id = store.sttsProvider
	return id.isNotEmpty() && sttsCatalog.none { it.id == id }
}

/** Per-provider voice; blank uses the descriptor default. */
fun ChatRepository.sttsVoiceFor(providerId: String): String = store.sttsVoiceFor(providerId)

fun ChatRepository.setSttsVoiceFor(providerId: String, voice: String) = store.setSttsVoiceFor(providerId, voice.trim())

/** The run-start sound, as a content Uri. Empty means the bundled asset; [ChatRepository.CHIME_SILENT]
 * means the user chose no sound at all, which is a decision rather than an unset preference. Persisted. */
var ChatRepository.sttsChimeUri: String
	get() = store.chimeUri
	set(value) {
		store.chimeUri = value
	}

/** When on, an incoming message for a followed (open) thread is
 * pre-synthesized before its notification. Persisted in prefs. */
var ChatRepository.sttsAutoGen: Boolean
	get() = store.autoTts
	set(value) {
		store.autoTts = value
	}

/** Which tier of a new message plays aloud automatically the moment it
 * arrives. One of "off", "title", "summary", "full". Independent of
 * sttsAutoGen. Persisted in prefs. */
var ChatRepository.sttsAutoPlay: String
	get() = store.autoPlay
	set(value) {
		store.autoPlay = value
	}

/** TTS playback volume, 0-200% (100 = unchanged). Persisted in prefs. */
var ChatRepository.sttsVolume: Int
	get() = store.sttsVolume
	set(value) {
		store.sttsVolume = value
	}

/** The chime's own volume, 0-200%. Its own control because it is balanced against the speech that
 * follows it, not against whatever else the phone is playing. */
var ChatRepository.sttsChimeVolume: Int
	get() = store.sttsChimeVolume
	set(value) {
		store.sttsChimeVolume = value
	}

/** STTS service liveness WITH the failure cause, for the settings Connection status line. */
suspend fun ChatRepository.sttsProbe(): SttsProbe =
	withContext(Dispatchers.IO) { sttsClient()?.probe() ?: SttsProbe.Unreachable("not configured") }
