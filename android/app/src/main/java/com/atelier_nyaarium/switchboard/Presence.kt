package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/**
 * How much a presence answer is worth.
 *
 * A session's facts reach this device by TWO channels with very different latency. The presence
 * plane PUSHES the route Gateway's own rows on every poll (`PresenceOps.applyPlanePresence`, and
 * `presence.ts`'s snapshot, which walks only its own session store). Every OTHER machine's rows are
 * PULLED once per `DISCOVERY_REFRESH_MS` (`PresenceOps.refreshDiscovery`, which the poll loop calls
 * "the one thing left with no push mechanism").
 *
 * Nothing on the wire says which channel delivered a row, so a consumer that reads a value alone
 * silently assumes push latency and is wrong for every machine but one. That is the whole reason
 * this type exists, and why the status STRING below is private: the bug was never a wrong value, it
 * was `status == "available"` written at fourteen sites by code with no way to ask how old that was.
 */
enum class Authority {
	/** Pushed by the Gateway that owns this session, so it is current as of this poll. */
	LIVE,

	/** Pulled on the discovery interval, so up to `DISCOVERY_REFRESH_MS` old. Not evidence. */
	POLLED,

	/** That Gateway could not be reached when we last asked. The row is only what it used to be, and
	 * nothing that costs a round trip to that machine should be attempted on the strength of it. */
	UNREACHABLE,

	/** Synthesized locally; no Gateway ever spoke for this row (an ended thread). */
	NONE,
}

/**
 * What this device asked for and has not yet seen confirmed.
 *
 * This device's own action is the freshest fact it will ever hold about a session, and before this
 * type it was thrown away: `wakeSession` fired and then waited to be TOLD what it already knew,
 * which on a non-route Gateway takes up to a discovery interval.
 *
 * It is a RECEIPT, not a status. It is scoped to one operation id, because a wake followed by a
 * relaunch would otherwise let the first one's outcome clear the second one's. It carries an
 * outcome rather than only a time, because "we asked" and "it was accepted" and "it failed" are
 * three different things and a timer can express none of them. And it never outranks a Gateway
 * that has actually spoken (see [Presence.mayHavePane]): an optimistic value that can override real
 * evidence is a UI that lies, which is strictly worse than one that is late.
 */
data class ActionReceipt(
	val opId: String,
	val at: Long,
	val outcome: Outcome = Outcome.REQUESTED,
) {
	enum class Outcome {
		/** Sent; the Gateway has not answered yet. */
		REQUESTED,

		/** The Gateway took it. The session is coming up but nothing has reported it yet. */
		ACCEPTED,

		/** The Gateway refused, or could not be reached. Nothing is coming. */
		FAILED,
	}

	/** Still worth acting on. A FAILED receipt never is; the caller has already surfaced its reason. */
	fun live(now: Long): Boolean = outcome != Outcome.FAILED && now - at < RECEIPT_TTL_MS

	companion object {
		/**
		 * A safety bound, NOT the expiry that matters. The real expiry is evidence: a receipt is
		 * dropped the moment any Gateway reports the session as up.
		 *
		 * Comfortably longer than one discovery interval on purpose. Shorter, and a slow cold boot
		 * expires the receipt before discovery has run even once, which puts the blank terminal
		 * straight back. Longer, and a wake that silently went nowhere keeps saying so.
		 */
		const val RECEIPT_TTL_MS = 90_000L
	}
}

/**
 * Everything a Gateway reports about one session, plus what that report is worth and what this
 * device has asked for since.
 *
 * The status string is PRIVATE and there is no accessor for it. Every question a caller actually has
 * is a member below, which is what stops a new call site from re-deriving `== "available"` and
 * inheriting the assumption that the value is current. A new presence field added here inherits
 * [authority] for free, which is the difference between fixing this defect and fixing its class.
 */
class Presence
private constructor(
	private val status: String,
	val authority: Authority,
	val receipt: ActionReceipt?,
	val mode: String,
	val queueDepth: Int,
	val version: String?,
	// Daemon-derived, from the presence plane. Null means unknown (never observed, or derivation
	// just became impossible), never false - a tile shows no pulse rather than a stale frozen one.
	val working: Boolean?,
	val needsLogin: Boolean?,
	val limitBlocked: Boolean?,
	val limitDetail: String?,
) {
	/** A live socket serves this session: confirmed online, or verifying its handshake (connected but
	 * the LLM has not re-answered, e.g. across a gateway restart). Both count as awake. */
	val isLive: Boolean get() = status == ONLINE || status == VERIFYING

	/** Confirmed registered, the strongest thing any Gateway says. Distinct from [isLive] because a
	 * verifying session is awake but not yet answering. */
	val isOnline: Boolean get() = status == ONLINE

	/** Connected but the handshake has not completed. Awake, not yet answering. */
	val isVerifying: Boolean get() = status == VERIFYING

	/** The session has left the bridge entirely (locally synthesized, never a wire value). */
	val hasEnded: Boolean get() = status == ENDED

	/** The base board/thread word, before any working/waking/login refinement. Display tolerates
	 * staleness: being a discovery interval behind on a label is cosmetic, where being behind on a
	 * gate is the bug this file exists for. Pair with `presenceColor` for the chip colour. */
	val word: String get() = wordFor(status)

	/** A wake this device asked for is still outstanding, so a surface should say "waking" rather
	 * than "asleep". Superseded by any Gateway actually reporting the session up. */
	fun waking(now: Long): Boolean = !isLive && receipt?.live(now) == true

	/**
	 * Whether it is worth peeking a pane for this session.
	 *
	 * NOT "is it online": a fresh tmux pane is peekable well before the CLI inside it registers, and
	 * that gap IS the terminal's job to show. The question is whether there is plausibly something
	 * to look at, and the honest answer depends on what the status is worth:
	 *
	 * - UNREACHABLE peeks nothing. Every attempt is a guaranteed round trip to a machine we already
	 *   know we cannot reach, and this is the bound that stops one wake tap on a powered-off machine
	 *   from becoming hundreds of remote peeks at the terminal's own cadence.
	 * - An asleep session with an outstanding receipt IS worth peeking: we asked for it ourselves.
	 * - Otherwise an "available" row means asleep and idling is right - which is what keeps a warm
	 *   container from being docker-exec'd every cycle for a session that is genuinely down.
	 *
	 * A POLLED row is deliberately NOT trusted enough to skip peeking forever: the caller probes once
	 * per mount when [authority] is not LIVE (see TerminalView), which settles a stale row for the
	 * price of a single op instead of a discovery interval of blank screen.
	 */
	fun mayHavePane(now: Long): Boolean = when (authority) {
		Authority.UNREACHABLE, Authority.NONE -> false
		Authority.LIVE, Authority.POLLED -> status != AVAILABLE || receipt?.live(now) == true
	}

	/** True only when a Gateway that speaks for this session said so THIS poll. A caller that would
	 * act on "there is nothing there" has to consult this, or it is acting on a value that may be a
	 * discovery interval old. */
	val authoritative: Boolean get() = authority == Authority.LIVE

	fun withAuthority(a: Authority): Presence = rebuild(a = a)

	fun withReceipt(r: ActionReceipt?): Presence = rebuild(r = r)

	private fun rebuild(a: Authority = authority, r: ActionReceipt? = receipt): Presence =
		Presence(status, a, r, mode, queueDepth, version, working, needsLogin, limitBlocked, limitDetail)

	override fun equals(other: Any?): Boolean =
		other is Presence &&
			status == other.status &&
			authority == other.authority &&
			receipt == other.receipt &&
			mode == other.mode &&
			queueDepth == other.queueDepth &&
			version == other.version &&
			working == other.working &&
			needsLogin == other.needsLogin &&
			limitBlocked == other.limitBlocked &&
			limitDetail == other.limitDetail

	override fun hashCode(): Int {
		var h = status.hashCode()
		h = 31 * h + authority.hashCode()
		h = 31 * h + (receipt?.hashCode() ?: 0)
		h = 31 * h + mode.hashCode()
		h = 31 * h + queueDepth
		h = 31 * h + (version?.hashCode() ?: 0)
		h = 31 * h + (working?.hashCode() ?: 0)
		h = 31 * h + (needsLogin?.hashCode() ?: 0)
		h = 31 * h + (limitBlocked?.hashCode() ?: 0)
		h = 31 * h + (limitDetail?.hashCode() ?: 0)
		return h
	}

	override fun toString(): String = "Presence($status, $authority, receipt=$receipt)"

	companion object {
		// The wire's own status vocabulary, named ONCE. These four literals were compared against at
		// fourteen call sites; the residue test's whole job is keeping them here.
		const val ONLINE = "online"
		const val VERIFYING = "verifying"
		const val AVAILABLE = "available"
		const val ENDED = "ended"

		/**
		 * The status-word vocabulary, and its only owner.
		 *
		 * Public because the cross-Domain presence plane carries its own session rows with the same
		 * status vocabulary and no Presence of their own (that plane has its own freshness model, see
		 * CrossDomainPresenceUi). Sharing the mapping keeps one vocabulary; it deliberately does NOT
		 * share the gates, since a linked Domain's freshness is a different question from this one.
		 */
		fun wordFor(status: String): String = when (status) {
			ONLINE -> "live"
			VERIFYING -> "verifying"
			AVAILABLE -> "available"
			else -> "ended"
		}

		/** The one construction path from a Gateway's report. */
		fun reported(
			status: String,
			authority: Authority,
			mode: String = "",
			queueDepth: Int = 0,
			version: String? = null,
			working: Boolean? = null,
			needsLogin: Boolean? = null,
			limitBlocked: Boolean? = null,
			limitDetail: String? = null,
		): Presence =
			Presence(status, authority, null, mode, queueDepth, version, working, needsLogin, limitBlocked, limitDetail)

		/** A thread whose session has left the bridge. No Gateway speaks for it, hence NONE. */
		fun ended(): Presence = Presence(ENDED, Authority.NONE, null, "", 0, null, null, null, null, null)
	}
}
