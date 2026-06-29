package com.atelier_nyaarium.switchboard.crypto

import java.security.MessageDigest
import java.util.Base64

/**
 * A stable id for a raw signing public key (base64): the full SHA-256 hex of the DECODED key bytes,
 * lowercase. The Kotlin twin of the gateway's `shared/owner-id.ts:ownerKeyId`; the two MUST agree
 * (pinned by `tests/fixtures/owner-id/vectors.json`) because this keys the owner's shared console
 * inbox and is the console's own address spawn segment - a divergence silently breaks that match.
 * Switchboard-only (evie never keys a console inbox), so it stays out of the evie-synced Crypto core.
 */
fun ownerKeyId(signPubB64: String): String =
	MessageDigest.getInstance("SHA-256")
		.digest(Base64.getDecoder().decode(signPubB64))
		.joinToString("") { "%02x".format(it) }
