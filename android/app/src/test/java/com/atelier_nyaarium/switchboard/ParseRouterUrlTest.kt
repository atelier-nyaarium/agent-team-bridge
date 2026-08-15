package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for parseRouterUrl: it turns the stored routerUrl back into the two fields the form
 * edits. A wrong split shows the owner an endpoint they are not actually on, which is worse than
 * the blank form it replaced.
 */
class ParseRouterUrlTest {

	private val port = 20001

	@Test
	fun splitsTheStoredFormBackIntoHostAndPort() {
		assertEquals("192.168.1.238" to 20001, parseRouterUrl("https://192.168.1.238:20001", port))
	}

	@Test
	fun keepsANonDefaultPort() {
		assertEquals("router.example.com" to 8443, parseRouterUrl("https://router.example.com:8443", port))
	}

	@Test
	fun fallsBackWhenNoPortIsPresent() {
		assertEquals("router.example.com" to port, parseRouterUrl("https://router.example.com", port))
	}

	@Test
	fun toleratesATrailingSlashAndAMissingScheme() {
		assertEquals("10.0.0.5" to 20001, parseRouterUrl("10.0.0.5:20001/", port))
	}
}
