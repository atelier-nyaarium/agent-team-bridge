package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the clearProvisioning() wipe/keep partition (AppStateStore.PROVISIONING_KEYS):
 * the provisioning / identity / transcript keys are wiped, while the settings-owned keys
 * (voice creds + taste, the biometric lock, the one-shot migration latch) are preserved by
 * omission. A key added to the wrong side - e.g. a new identity key forgotten here, or a
 * settings key mistakenly added - breaks one of these assertions. Pure-JVM (asserts the
 * declared key list, not runtime prefs, so no Android Context is needed).
 */
class ClearProvisioningPartitionTest {
	private val wiped = AppStateStore.PROVISIONING_KEYS

	@Test
	fun wipesProvisioningIdentityAndTranscript() {
		val mustWipe = listOf(
			"provisioning",
			"federation_identity",
			"federation_owner_identity",
			"federation_content_keys",
			"federation_content_keys_corrupt",
			"router_reach",
			"federation_domain",
			"federation_domain_version",
			"federation_console_admitted",
			"federation_first_rooted",
			"federation_enroll_ceremony_done",
			"federation_profile_name",
			"federation_hosted_tenants",
			"federation_pending_enrolls",
			"federation_trusted_owners",
			"threads",
			"read_anchors",
			"labels",
			"drafts",
			"scheduled_sends",
			"goals",
			"gateway_id",
			"sync_epoch",
			"sync_acked",
			"sync_dropped",
			"team_absence_streak",
			"task_board",
			"create_last_project_by_gateway",
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
