package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

internal enum class ConnKind {
	/** Needs human action (re-provision, bad creds, app update); surface immediately. */
	TERMINAL,

	/** A network or server blip; retry quietly, so one hiccup never alarms. */
	TRANSIENT,

	/** The device IS admitted, but this Gateway has not re-synced its allowlist, so a sealed op
	 * rejects. Self-heals on the next re-register; escalate only past the grace window. */
	ENROLLING,
}

////////////////////////////////
//  Functions & Helpers

 /**
 * new admission from the Router, which it only does on its next re-register. */
private const val ENROLL_GRACE_MS = 90_000L

/**
 * True when the failure's cause chain carries actual certificate-VALIDATION evidence: the trust
 * check rejected the chain, which Android wraps SSLHandshakeException -> CertificateException ->
 * CertPathValidatorException.
 *
 * A handshake merely dropped mid-flight carries none of these and must NOT be labeled a certificate
 * change: mislabeling it that way sends the user to re-run setup over what is only a plain infra
 * outage.
 */
internal fun certValidationEvidence(e: Throwable): Boolean {
	var t: Throwable? = e
	var hops = 0
	while (t != null && hops < 8) {
		if (t is java.security.cert.CertificateException) return true
		if (t is java.security.cert.CertPathValidatorException) return true
		val msg = t.message ?: ""
		if (msg.contains("trust anchor", ignoreCase = true) || msg.contains("CertPath", ignoreCase = true)) return true
		t = t.cause
		hops++
	}
	return false
}

/**
 * Map a connect or poll failure to a specific, actionable cause and its kind, instead of a blanket
 * "Connection issue". A pure mapping with no new probing: ConsoleClient preserves the real cause in
 * the exception message.
 */
internal fun classifyConnError(e: Throwable): Pair<String, ConnKind> {
	val m = e.message ?: ""
	return when {
		// Kept first, and distinct from the "keys are missing" terminal below, so a normal sync lag
		// can never be mislabeled as "re-run the script".
		m.contains("is not admitted to the Domain", ignoreCase = true) ->
			"Finishing up enrollment..." to ConnKind.ENROLLING
		// A rejected submission will NOT self-heal by waiting, unlike the sync lag above.
		m.contains("admission rejected", ignoreCase = true) ->
			"${m.take(100)} - re-run setup.sh, then re-import the setup blob" to ConnKind.TERMINAL
		// The app fails closed rather than persisting the federation key in cleartext. Re-provisioning
		// does not help; the device's secure storage must work.
		m.contains("secure storage unavailable", ignoreCase = true) ->
			"Secure storage unavailable - turn on a screen lock, then retry" to ConnKind.TERMINAL
		// Re-provisioning does NOT mint over a stored key, so the only fixes are a backup restore or a
		// deliberate recovery. Distinct from "not enrolled", which a re-import does fix.
		m.contains("corrupt", ignoreCase = true) && m.contains("did not decode", ignoreCase = true) ->
			"Stored key unreadable - restore from backup or re-run setup.sh" to ConnKind.TERMINAL
		m.contains("not enrolled", ignoreCase = true) ->
			"Not enrolled - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		// Worded in ConsoleClient WITHOUT the "not admitted" token so it cannot collide with ENROLLING.
		m.contains("keys are missing", ignoreCase = true) || m.contains("not provisioned", ignoreCase = true) ->
			"Gateway not provisioned - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		// ChatState.needsGateway keys the board's Add-a-Gateway CTA off this message's prefix.
		m.contains("not in the keyring", ignoreCase = true) || m.contains("no gateway admitted", ignoreCase = true) ->
			"Add a Gateway to begin" to ConnKind.TERMINAL
		m.startsWith("HTTP 400") ->
			"App is out of date - update the app, or re-run setup.sh" to ConnKind.TERMINAL
		m.startsWith("HTTP 401") ->
			"Sign-in rejected - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		m.startsWith("HTTP 403") ->
			"Access expired - re-run setup.sh" to ConnKind.TERMINAL
		m.startsWith("HTTP 404") ->
			"Server not set up - run setup.sh on the server" to ConnKind.TERMINAL
		m.startsWith("HTTP 409") ->
			"A previous send is still finishing - retrying" to ConnKind.TRANSIENT
		m.startsWith("HTTP 500") ->
			"Server error - retrying" to ConnKind.TRANSIENT
		m.startsWith("HTTP 502") || m.startsWith("HTTP 503") ->
			"Can't reach the server - retrying" to ConnKind.TRANSIENT
		m.startsWith("HTTP 504") ->
			"Server timed out - retrying" to ConnKind.TRANSIENT
		// Terminal ONLY on validation evidence; a bare handshake failure is a dropped connection.
		certValidationEvidence(e) ->
			"Server certificate changed - re-run setup.sh" to ConnKind.TERMINAL
		e is javax.net.ssl.SSLHandshakeException ->
			"Secure connection interrupted - retrying" to ConnKind.TRANSIENT
		// A retry carries a fresh timestamp and nonce, so these clear on the next attempt. Checked
		// after the TLS branch so a handshake-signature error is not mislabeled.
		m.contains("stale", ignoreCase = true) || m.contains("replay", ignoreCase = true) ->
			"Re-syncing the secure channel - retrying" to ConnKind.TRANSIENT
		m.contains("signature", ignoreCase = true) || m.contains("decrypt", ignoreCase = true) ->
			"Secure channel rejected - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		e is java.net.UnknownHostException ->
			"Offline - no network" to ConnKind.TRANSIENT
		e is java.net.ConnectException || e is java.net.SocketTimeoutException || e is java.io.InterruptedIOException ->
			"Can't reach the server - retrying" to ConnKind.TRANSIENT
		else -> "Error: ${m.take(100)}" to ConnKind.TRANSIENT
	}
}

/** Fold an ENROLLING failure: keep showing the calm cause until the grace window lapses, then return
 * a terminal override so a sync that never lands surfaces a real error. Returns the override message
 * (or null) paired with the `enrollingSince` to persist. */
internal fun enrollFold(prevSince: Long): Pair<String?, Long> {
	val since = if (prevSince == 0L) System.currentTimeMillis() else prevSince
	return if (System.currentTimeMillis() - since > ENROLL_GRACE_MS) {
		"Enrollment did not finish - re-run setup.sh and re-import the setup blob." to 0L
	} else {
		null to since
	}
}
