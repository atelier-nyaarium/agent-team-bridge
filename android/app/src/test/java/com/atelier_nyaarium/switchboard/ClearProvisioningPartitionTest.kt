package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the clearProvisioning() wipe/keep partition (ProvisioningStore.PROVISIONING_KEYS):
 * the provisioning / identity / transcript keys are wiped, while the settings-owned keys
 * (voice creds + taste, the biometric lock, the one-shot migration latch) are preserved by
 * omission. A key added to the wrong side - e.g. a new identity key forgotten here, or a
 * settings key mistakenly added - breaks one of these assertions. Pure-JVM (asserts the
 * declared key list, not runtime prefs, so no Android Context is needed).
 */
class ClearProvisioningPartitionTest {
	private val wiped = ProvisioningStore.PROVISIONING_KEYS

	@Test
	fun wipesProvisioningIdentityAndTranscript() {
		val mustWipe = listOf(
			"provisioning",
			"federation_identity",
			"federation_owner_identity",
			"federation_domain",
			"federation_domain_version",
			"federation_console_admitted",
			"federation_first_rooted",
			"federation_enroll_ceremony_done",
			"federation_operator_name",
			"federation_hosted_tenants",
			"federation_trusted_owners",
			"threads",
			"labels",
			"drafts",
			"gateway_id",
			"sync_epoch",
			"sync_acked",
			"sync_dropped",
		)
		for (k in mustWipe) assertTrue("$k must be wiped by clearProvisioning", k in wiped)
	}

	@Test
	fun preservesVoiceCredsTasteAndDeviceSettings() {
		val mustKeep = listOf(
			"stts_url",
			"stts_key",
			"stts_migrated",
			"stts_provider",
			"stts_voice",
			"auto_tts",
			"auto_play_summary",
			"biometric_lock",
			"terminal_refresh_ms",
		)
		for (k in mustKeep) assertFalse("$k must survive clearProvisioning (preserved by omission)", k in wiped)
	}
}
