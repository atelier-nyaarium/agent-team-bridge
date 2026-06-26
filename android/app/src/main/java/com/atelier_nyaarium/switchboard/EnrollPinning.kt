package com.atelier_nyaarium.switchboard

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

/**
 * Pinned-TLS delivery of the sealed enroll bundle to the gateway's arming-only LAN listener.
 *
 * The bundle is ALREADY E2E sealed to the gateway box key, so this TLS is not protecting the bundle:
 * it exists only to satisfy Android's no-cleartext policy WITHOUT an app-wide cleartext permit, and to
 * keep the LAN wire metadata-private. Trust is bootstrapped by the cert fingerprint the gateway put in
 * the same admit QR that already roots the bundle seal - no CA, no system trust store, no TOFU.
 */

/**
 * Throw [CertificateException] unless chain[0]'s SHA-256 leaf fingerprint equals [expectedFpHex]
 * (compared constant-time, case-insensitive). The pin IS the trust for the gateway's ephemeral
 * self-signed enroll cert, so this deliberately does NOT delegate to the platform TrustManager - a
 * self-signed leaf has no CA chain and would be rejected. Pinning the exact leaf is the strongest
 * possible check, not the CWE-295 "accept any cert" trap.
 */
internal fun checkPinnedLeaf(chain: Array<X509Certificate>, expectedFpHex: String) {
	val leaf = chain.firstOrNull() ?: throw CertificateException("empty certificate chain")
	val fp = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
	if (!MessageDigest.isEqual(fp.toByteArray(), expectedFpHex.lowercase().toByteArray())) {
		throw CertificateException("enroll cert fingerprint mismatch")
	}
}

/**
 * An OkHttp client that trusts EXACTLY the gateway's enroll cert via [checkPinnedLeaf]. Hostname
 * verification stays the OkHttp DEFAULT - the cert carries the LAN IP in subjectAltName, so a
 * redirected host still fails the standard check (no permissive verifier). Dedicated to the single
 * enroll POST; never shared with the evie client.
 */
internal fun buildLeafFingerprintPinnedClient(certFpHex: String): OkHttpClient {
	val tm: X509TrustManager =
		object : X509TrustManager {
			override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
				throw CertificateException("client authentication is not used")
			}

			override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
				checkPinnedLeaf(chain, certFpHex)

			override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
		}
	val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }
	return OkHttpClient.Builder()
		.sslSocketFactory(ssl.socketFactory, tm)
		.connectTimeout(5, TimeUnit.SECONDS)
		.writeTimeout(10, TimeUnit.SECONDS)
		.readTimeout(10, TimeUnit.SECONDS)
		.build()
}
