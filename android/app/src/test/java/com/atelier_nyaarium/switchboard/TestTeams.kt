package com.atelier_nyaarium.switchboard

/**
 * A Team for tests, so the presence shape has ONE construction site across the suite rather than a
 * hand-rolled `Team(...)` per file. Defaults to a LIVE row: most suites are about labels, ordering
 * or tombstones and care only that a row exists, while the suites that are about freshness say so.
 */
internal fun testTeam(
	name: String,
	status: String = Presence.ONLINE,
	authority: Authority = Authority.LIVE,
	mode: String = "",
	queueDepth: Int = 0,
	version: String? = null,
	working: Boolean? = null,
	needsLogin: Boolean? = null,
	limitBlocked: Boolean? = null,
	limitDetail: String? = null,
	kind: String = "loose",
	domainId: String? = null,
	displayName: String? = null,
	isAdminDomain: Boolean = false,
	sessionLabel: String? = null,
): Team = Team(
	name = name,
	presence = Presence.reported(
		status = status,
		authority = authority,
		mode = mode,
		queueDepth = queueDepth,
		version = version,
		working = working,
		needsLogin = needsLogin,
		limitBlocked = limitBlocked,
		limitDetail = limitDetail,
	),
	kind = kind,
	domainId = domainId,
	displayName = displayName,
	isAdminDomain = isAdminDomain,
	sessionLabel = sessionLabel,
)
