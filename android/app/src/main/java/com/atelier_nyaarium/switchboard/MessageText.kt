package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Functions & Helpers

private val ONE_LINE_WS = Regex("\\s+")

/** Collapse a value for a single ellipsized line. A newline in a title would otherwise render as
 * everything before it and nothing after. Null when nothing is left, which lets a caller fall
 * through to another field rather than paint a blank rung. */
internal fun oneLine(raw: String?): String? = raw?.replace(ONE_LINE_WS, " ")?.trim()?.takeIf { it.isNotEmpty() }

/**
 * What the boundary marker says before a message is read out: which session is about to speak.
 *
 * A peer-mirror row names both parties, since neither is this console's own team, and "someone"
 * stands in for an author the labels cannot resolve so the marker never announces a blank. Spoken
 * form spells words out rather than using glyphs, since engines render symbols unpredictably.
 *
 * Deliberately independent of the message. It depends only on who is speaking, which is what lets
 * one synthesis be cached and reused for every message in that session.
 */
internal fun sentinelText(state: ChatState, msg: Message, team: String): String {
	if (!msg.isPeer) return state.label(team)
	val fromLabel = msg.from?.let { state.label(it) } ?: "someone"
	val toLabel = msg.to?.let { state.label(it) }
	return if (toLabel != null) "$fromLabel on $toLabel" else fromLabel
}

/**
 * A tier's TTS text, attributed only when nothing else will attribute it.
 *
 * An autoplay run speaks [sentinelText] as its own playback first, so prefixing there too would say
 * the speaker twice. A message played by hand gets no such marker, since a boundary marker delimits
 * a run and one message is not a run, so a peer row would otherwise play back as if this console had
 * been addressed.
 */
internal fun ttsTextFramed(
	state: ChatState,
	msg: Message,
	tier: SttsPlayer.Tier,
	attributed: Boolean = false,
): String {
	val text = SttsPlayer.ttsText(msg, tier)
	if (!attributed || !msg.isPeer) return text
	val fromLabel = msg.from?.let { state.label(it) } ?: "someone"
	val toLabel = msg.to?.let { state.label(it) }
	return if (toLabel != null) "$fromLabel to $toLabel: $text" else "$fromLabel: $text"
}

/** A peer-mirror row's notification/TTS text, framed as "from -> to: text" so it never reads as
 * if addressed to this console - neither party in a peer-mirror row is this console's own team,
 * unlike every other row this is applied to. */
internal fun peerFramed(state: ChatState, m: Message, text: String): String {
	if (!m.isPeer) return text
	val fromLabel = m.from?.let { state.label(it) } ?: "?"
	val toLabel = m.to?.let { state.label(it) }
	return if (toLabel != null) "$fromLabel → $toLabel: $text" else "$fromLabel: $text"
}
