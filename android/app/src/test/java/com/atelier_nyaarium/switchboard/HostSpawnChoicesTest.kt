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

/**
 * What the create dialog opens on.
 *
 * Nothing, unless a remembered project is still offered. `host` was the default once and is not a
 * neutral one: it is a real target among several, so preselecting it lets a mis-tap spawn on the
 * wrong machine's shell without the owner ever choosing.
 */
class InitialProjectTest {
	private val offered = listOf("windows", "host", "recipe-app")

	@Test
	fun `nothing remembered means nothing selected`() {
		assertEquals(null, initialProject(null, offered))
	}

	@Test
	fun `a remembered project that is still offered is preselected`() {
		assertEquals("windows", initialProject("windows", offered))
		assertEquals("recipe-app", initialProject("recipe-app", offered))
	}

	// The "when valid" half. A project since renamed or removed, or a Windows side no longer
	// detected, must not preselect something that cannot be spawned.
	@Test
	fun `a remembered project the gateway no longer offers selects nothing`() {
		assertEquals(null, initialProject("windows", listOf("host")))
		assertEquals(null, initialProject("old-project", offered))
	}

	// A machine with nothing to offer cannot preselect anything, remembered or not.
	@Test
	fun `an empty project list selects nothing`() {
		assertEquals(null, initialProject("host", emptyList()))
	}
}

/**
 * Which (gateway, project) a spawn target names.
 *
 * The bare case is the whole reason this is a function rather than two lines inside `rememberProject`.
 * `CreateDialogTarget.targetFor` returns a BARE project for the route Gateway, so reading an empty
 * gateway segment as "no gateway" silently disabled remembering for the machine most likely to be
 * spawned on, while working fine for every other machine. That is a defect that tests itself away
 * only if the bare shape is one of the cases.
 */
class SpawnTargetKeyTest {
	@Test
	fun `a bare project is the route gateway's`() {
		assertEquals("sakura" to "recipe-app", spawnTargetKey("recipe-app", "sakura"))
		assertEquals("sakura" to "host", spawnTargetKey("host", "sakura"))
	}

	@Test
	fun `a qualified spawn point names its own gateway`() {
		assertEquals("mikan" to "windows", spawnTargetKey("alice.mikan.windows", "sakura"))
		assertEquals("mikan" to "host", spawnTargetKey("alice.mikan.host", "sakura"))
	}

	// A session address names a session, not a spawn point, and is not what the create dialog builds.
	@Test
	fun `a full session address is not a spawn target`() {
		assertEquals(null, spawnTargetKey("alice.mikan.windows.f7a906", "sakura"))
	}

	@Test
	fun `an unparseable target is not remembered`() {
		assertEquals(null, spawnTargetKey("", "sakura"))
		assertEquals(null, spawnTargetKey("   ", "sakura"))
	}

	// Without a local gateway id there is nothing to attribute a bare target to, and guessing would
	// file it under the empty string where nothing can ever match it.
	@Test
	fun `a bare target with no local gateway is not remembered`() {
		assertEquals(null, spawnTargetKey("recipe-app", ""))
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

	/**
	 * The label a Windows machine's host row must carry.
	 *
	 * Pinned because the closed field and the open menu once disagreed: the menu rows went through
	 * this function while the field rendered the raw wire word, so the same thing read "WSL" in the
	 * list and "host" in the box above it depending on whether the menu was open. Caught from a
	 * screenshot rather than a test.
	 *
	 * This asserts the VALUE only. That both surfaces call this one function is a structural fact a
	 * unit test cannot see; what keeps them together is that neither spells a label of its own.
	 */
	@Test
	fun `a windows machine's host row is WSL`() {
		assertEquals("WSL", hostSpawnLabel("host", listOf("windows", "host", "recipe-app")))
	}
}
