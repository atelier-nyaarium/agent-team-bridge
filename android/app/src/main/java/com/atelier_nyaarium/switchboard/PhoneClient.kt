package com.atelier_nyaarium.switchboard

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.util.UUID
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Credential blob the phone holds (pasted once). Reaches the phone bridge through
 * the k8s API service-proxy: the SA token authenticates to the API server, the app
 * token (a separate forwarded header) authenticates to evie.
 */
data class Provisioning(
	val apiUrl: String,
	val caPem: String,
	val saToken: String,
	val appToken: String,
	val namespace: String,
	val service: String,
	val port: Int,
	val device: String,
	val conversationId: String,
) {
	companion object {
		fun parse(blob: String): Provisioning {
			val j = JSONObject(blob)
			return Provisioning(
				apiUrl = j.getString("apiUrl").trimEnd('/'),
				caPem = j.getString("caPem"),
				saToken = j.getString("saToken"),
				appToken = j.optString("appToken", ""),
				namespace = j.optString("namespace", "evie-bot"),
				service = j.optString("service", "evie-phone-bridge"),
				port = j.optInt("port", 20004),
				device = j.optString("device", android.os.Build.MODEL ?: "android"),
				conversationId = j.optString("conversationId", UUID.randomUUID().toString()),
			)
		}
	}
}

/** Talks to the phone bridge through the CA-pinned k8s API service-proxy. */
class PhoneClient(private val prov: Provisioning) {
	private val client = buildPinnedClient(prov.caPem)
	private val proxyBase =
		"${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy"

	/**
	 * Direct CA-pinned GET to the API server with the SA token. Proves the tunnel
	 * (TLS pinning, reachability, auth) works before the phone bridge is deployed.
	 */
	fun apiReachable(): String {
		val req = Request.Builder()
			.url("${prov.apiUrl}/api/v1/namespaces/${prov.namespace}")
			.header("Authorization", "Bearer ${prov.saToken}")
			.get()
			.build()
		client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(300)}")
			return "reachable (HTTP ${resp.code})"
		}
	}

	/** Send a phone op through the service-proxy to the phone bridge. */
	fun relay(opJson: String): String {
		val body = JSONObject()
			.put("device", prov.device)
			.put("conversationId", prov.conversationId)
			.put("opId", UUID.randomUUID().toString())
			.put("op", JSONObject(opJson))
			.toString()
		val req = Request.Builder()
			.url("$proxyBase/relay")
			.header("Authorization", "Bearer ${prov.saToken}")
			.header("X-Android-Bridge-Token", "Bearer ${prov.appToken}")
			.post(body.toRequestBody(JSON))
			.build()
		client.newCall(req).execute().use { resp ->
			val text = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(500)}")
			return text
		}
	}

	fun listTeams(): List<String> {
		val result = JSONObject(relay("""{"kind":"list_teams"}""")).optJSONObject("result") ?: return emptyList()
		val arr = result.optJSONArray("teams") ?: return emptyList()
		return (0 until arr.length()).map { arr.getJSONObject(it).optString("team") }
	}

	companion object {
		private val JSON = "application/json".toMediaType()

		/** Trust ONLY the supplied cluster CA (the API server cert is cluster-signed). */
		private fun buildPinnedClient(caPem: String): OkHttpClient {
			val ca = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(caPem.toByteArray()))
			val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
				load(null, null)
				setCertificateEntry("cluster-ca", ca)
			}
			val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
			val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
			val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }
			return OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, tm).build()
		}
	}
}
