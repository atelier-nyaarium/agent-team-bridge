package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which host spawn points the create dialog offers, and how they are labelled.
 *
 * The labelling half matters as much as the list: `host` is an address segment keying session
 * records, resume state, phone threads and board work, so it can never be renamed on the wire. "WSL"
 * exists only in the picker, and only where it is true.
 */
class HostSpawnChoicesTest {
	private val key = GatewayGroupKey("alice", "mikan")

	private fun advertised(vararg spawns: String, gateway: String = "mikan", domain: String? = "alice") =
		listOf(GatewaySpawnPoints(domainId = domain, gatewayId = gateway, hostSpawns = spawns.toList()))

	// The behaviour every console had before this existed, and what an older gateway still produces.
	@Test
	fun `no advertisement yields exactly host`() {
		assertEquals(listOf("host"), hostSpawnChoices(emptyList(), key, "alice"))
	}

	// An affirmative "nothing beyond host" must land the same as silence, since both mean the machine
	// offers only its own shell.
	@Test
	fun `an empty advertisement yields exactly host`() {
		assertEquals(listOf("host"), hostSpawnChoices(advertised(), key, "alice"))
	}

	@Test
	fun `windows is offered before host`() {
		assertEquals(listOf("windows", "host"), hostSpawnChoices(advertised("windows"), key, "alice"))
	}

	// Another machine's answer must not leak into this Gateway's picker: spawning is per machine.
	@Test
	fun `another gateway's advertisement is ignored`() {
		assertEquals(listOf("host"), hostSpawnChoices(advertised("windows", gateway = "sakura"), key, "alice"))
	}

	// A Gateway that has not resolved a Domain sends none, and folds onto the admin Domain exactly as
	// a session row does.
	@Test
	fun `an absent domain folds onto the admin domain`() {
		assertEquals(listOf("windows", "host"), hostSpawnChoices(advertised("windows", domain = null), key, "alice"))
	}

	// A newer gateway may advertise something this console cannot label or reason about. Offering it
	// would put a target in the picker that this build does not understand.
	@Test
	fun `an unknown spawn id is dropped rather than offered`() {
		assertEquals(listOf("host"), hostSpawnChoices(advertised("plan9"), key, "alice"))
	}

	@Test
	fun `host is never duplicated even if advertised`() {
		assertEquals(listOf("host"), hostSpawnChoices(advertised("host"), key, "alice"))
	}
}

class HostSpawnLabelTest {
	// On a Linux machine `host` is just the host. Calling it WSL there would be a lie.
	@Test
	fun `host keeps its name when no windows peer exists`() {
		assertEquals("host", hostSpawnLabel("host", listOf("host", "recipe-app")))
	}

	@Test
	fun `host reads as WSL only alongside windows`() {
		assertEquals("WSL", hostSpawnLabel("host", listOf("windows", "host")))
	}

	@Test
	fun `windows is titled`() {
		assertEquals("Windows", hostSpawnLabel("windows", listOf("windows", "host")))
	}

	// A devcontainer project is shown as itself; only host spawn points are relabelled.
	@Test
	fun `a catalog project is untouched`() {
		assertEquals("recipe-app", hostSpawnLabel("recipe-app", listOf("windows", "host", "recipe-app")))
	}
}
