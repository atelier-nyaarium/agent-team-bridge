package com.atelier_nyaarium.switchboard.board

/** Kotlin twin of src/shared/board-rank.ts - the same digits, the same midpoint, so a rank minted
 * on either side sorts identically on both. Held equivalent by mirrored unit tests; the rebalance
 * lives gateway-side only (endRank), so a console mint past the bound just falls back to the end. */
object BoardRank {
	private const val DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	const val MAX_LENGTH = 64

	fun isValid(rank: String): Boolean =
		rank.isNotEmpty() && rank.length <= MAX_LENGTH && !rank.endsWith(DIGITS[0]) && rank.all { it in DIGITS }

	/** Mint a rank strictly between two neighbours; null is the open start or end. */
	fun between(before: String?, after: String?): String {
		val a = before ?: ""
		require(after == null || a < after) { "no gap between \"$a\" and \"$after\"" }
		return midpoint(a, after)
	}

	private fun midpoint(a: String, b: String?): String {
		if (b != null) {
			var n = 0
			while (n < b.length && (a.getOrNull(n) ?: DIGITS[0]) == b[n]) n++
			if (n > 0) return b.substring(0, n) + midpoint(a.drop(n), b.drop(n).ifEmpty { null })
		}
		val digitA = if (a.isEmpty()) 0 else DIGITS.indexOf(a[0])
		val digitB = if (b != null) DIGITS.indexOf(b[0]) else DIGITS.length
		if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2.0).toInt()].toString()
		if (b != null && b.length > 1) return b[0].toString()
		return DIGITS[digitA] + midpoint(a.drop(1), null)
	}
}
