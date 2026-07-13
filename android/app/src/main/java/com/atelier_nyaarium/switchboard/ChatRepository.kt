package com.atelier_nyaarium.switchboard

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerKeyId
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalJoin
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.EnrollHandshakeOp
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import com.atelier_nyaarium.switchboard.proto.TrustHandshakeOp
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import com.atelier_nyaarium.switchboard.proto.parseTarget
import java.io.File
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/** A rendered attachment on a message. `src` is what the WebView loads (a data URI
 * or an appassets-proxied local path); a null `src` renders as a download chip. */
data class MessageFile(val name: String, val mime: String, val src: String? = null)

/** A data-plane consumer of new inbound messages, invoked once per message at the drain gate. */
fun interface InboundSubscriber {
	fun onMessage(team: String, msg: Message)
}

/** A consumer of arrived `plugin_action` mailbox entries, invoked once per entry at the drain gate.
 * Neutral shape (no plugin types here) - the plugin-framework bridge maps `pluginId`/`actionType`/
 * `payload` onto its own claim-keyed dispatch. */
fun interface PluginActionSubscriber {
	fun onAction(team: String, pluginId: String, actionType: String, payload: JsonObject?)
}

/** A scanned admit-gateway QR: the Gateway identity the owner is about to admit, plus the
 * optional LAN target + one-time nonce for delivering the sealed bootstrap bundle. */
data class ScannedGateway(
	val gatewayId: String,
	val signPub: String,
	val boxPub: String,
	val sas: String,
	val lanHost: String? = null,
	val lanPort: Int? = null,
	val nonce: String? = null,
	// SHA-256 of the gateway's ephemeral self-signed enroll TLS leaf (the QR's lan.certFp). Present ->
	// deliver over pinned HTTPS; absent -> paste only, never cleartext.
	val certFp: String? = null,
)

/** The outcome of enrolling a Gateway: whether it was admitted, a human message, and the
 * sealed bundle to hand-carry when LAN delivery was not possible (paste fallback). */
data class EnrollDelivery(val admitted: Boolean, val message: String, val pasteBundle: String?)

/** A held device's armed "Add a device" window: the rendezvous token, its one-time nonce, and the
 * authorize-console QR text (public material only) the new device scans. */
data class DeviceApprovalArmed(val approvalId: String, val nonce: String, val qr: String)

/** A scanned authorize-console QR on the NEW device: the held network's owner keys + Domain (the
 * owner signPub is pinned to verify the sealed reply), plus the rendezvous reach + token + nonce. */
data class ScannedDeviceApproval(
	val domainId: String,
	val ownerSignPub: String,
	val ownerBoxPub: String,
	val approvalId: String,
	val nonce: String,
	val reach: String,
	val sas: String,
)

/** The console transport a held device seals to a freshly-approved device: the provisioning creds
 * (so the new device reaches evie) plus the owner's synced keyring + route Gateway (so it can seal
 * to the Gateway the owner already admitted, without holding the owner key to re-sync). */
@kotlinx.serialization.Serializable
data class ConsoleTransport(
	val apiUrl: String,
	val caPem: String,
	val saToken: String,
	val appToken: String,
	val namespace: String,
	val service: String,
	val port: Long,
	val domainId: String? = null,
	val gatewayId: String? = null,
	val domainVersion: String? = null,
	val domain: com.atelier_nyaarium.switchboard.proto.DomainSnapshot? = null,
)

/** Outcome of "Revoke and Delete Domain", so the UI can tell a confirmed purge from one it
 * wiped locally without reaching evie (warn the human) from an evie rejection (keep local
 * state so the owner key survives for a retry). */
sealed class DeleteDomainOutcome {
	/** evie verified the owner and dropped the slice; local state was wiped. */
	object Deleted : DeleteDomainOutcome()

	/** evie was unreachable or did not answer in time; local state was wiped anyway, but the
	 * server-side purge is unconfirmed - tell the human to have the admin purge it if it survived. */
	object WipedUnconfirmed : DeleteDomainOutcome()

	/** evie answered but refused the deletion; local state is intact (the owner key still exists) so
	 * the human can retry. */
	data class Rejected(val error: String) : DeleteDomainOutcome()
}

/** A linked friend Domain row for the Federation hub: the Domain id, the friend's self-set
 * display name (propagated over discovery, null until a peer session carries it), how many of its
 * sessions are visible to me, and whether any is online. */
data class LinkedDomain(
	val domainId: String,
	val displayName: String?,
	val sessionCount: Int,
	val online: Boolean,
	// The friend OWNER's signing key (from the cross-Domain peer set), so a linked Domain joins the
	// owner-keyed roster. Null for a Domain seen only via discovery (no peer entry yet).
	val ownerSignPub: String?,
)

/** A requester-side pairing in flight: the one-time pin the requester minted (passed back to
 * confirm) and the Gateway's request result (the SAS + both sides' keys). */
data class CrossDomainPairing(val pin: String, val result: com.atelier_nyaarium.switchboard.proto.CrossDomainRequestResult)

/** A receiver-side pairing learned from a cross_domain_listen_state poll: the SAS to compare and
 * the friend (requester) keys the receiver owner-signs its own link over for confirm. The pin is
 * not here (the requester minted it); the receiver passes its own listening token, which the
 * gateway resolves to the pairing's pin. */
data class CrossDomainReceiverPairing(
	val sas: String,
	val friendOwnerSignPub: String,
	val friendDomainId: String,
	val friendGatewayId: String,
	val friendGatewaySignPub: String,
	val friendGatewayBoxPub: String,
)

/** `id` is a per-thread, local-only row key for the WebView DOM (lets the renderer
 * replace a row in place). It is NOT the mailbox seq; mailbox dedupe is owned by SyncCursor.
 * Stamped on append; reassigned from list order on load so old transcripts still work. */
data class Message(
	val fromMe: Boolean,
	val text: String,
	val at: Long,
	val id: Long = 0,
	val files: List<MessageFile> = emptyList(),
	/** Reply/send state: wire "running"/"error", local "pending" (echo in flight)
	 * and "waking" (the cold-wake placeholder), or null for a settled message. */
	val status: String? = null,
	/** The relay opId this send was first delivered under. A retry reuses it so
	 * the gateway's idempotency cache replays a lost reply instead of double-
	 * delivering to the agent (the console protocol contract). */
	val opId: String? = null,
	/** Notification-bar line for broadcast notices. Notification-only: the thread
	 * renders the body as usual and never shows this. */
	val title: String? = null,
	/** The Short tier of a notice, persisted but not yet read by any UI. */
	val summary: String? = null,
	/** The spoken copy of the body: what the FULL play tier speaks in `text`'s place. */
	val fullSpoken: String? = null,
	/** Mailbox coordinates of the entry that produced this row, used to dedupe an
	 * at-least-once re-drain so the same (epoch, seq) renders exactly once. 0 for
	 * local/optimistic rows and legacy persisted rows. */
	val epoch: Long = 0,
	val seq: Long = 0,
	/** The canonical `domain.gateway.spawn.session` author header shown for an inbound (agent) row. Null
	 * for our own rows (rendered as "you"). Not persisted for an ordinary row: every thread has one
	 * fixed peer, so it is re-derived from the thread key on load. A `to`-bearing (peer-mirror) row
	 * is the exception - its own `from`/`to` are the real two parties, independent of the thread it's
	 * filed under, so those are persisted verbatim instead of re-derived. */
	val from: String? = null,
	/** The other party a peer-mirror row was addressed to, when it resolved to an address - never
	 * set for a message addressed to this console. May be null even on a peer row (an unresolvable
	 * wire `to`), so `isPeer`, not this field's presence, is the persistence/rendering discriminator. */
	val to: String? = null,
	/** Whether this row is a `"peer"` mailbox entry (an agent-to-agent exchange mirrored into this
	 * thread) rather than a message addressed to this console. Drives persistence (keep `from`/`to`
	 * verbatim instead of re-deriving from the thread key) and rendering (label both parties, since
	 * neither is "you" and `from` alone can't be assumed to mean "sent to this thread's owner"). */
	val isPeer: Boolean = false,
	/** Whether this row arrived while the app was visible. Process-transient - NEVER persisted (a
	 * loaded row always defaults true/don't-care, since a persisted row only ever reaches a
	 * renderer through a setMessages snap/hold path driven by the read anchor, not this flag).
	 * Drives the arrival-suppression rule in thread.js: a batch containing an unread-eligible row
	 * that arrived while NOT visible holds the reader's position instead of auto-following. */
	val arrivedVisible: Boolean = true,
)


/** The tier-field invariant, applied at Message's two construction boundaries (the mailbox
 * drain and the persisted-thread load): a tier is null or non-blank, never "". The wire below
 * the tool schemas is deliberately lenient (mixed-version grace), so a blank tier from a raw
 * caller or a legacy persisted row is normalized HERE, letting every consumer (the speech
 * coalesce, notification lines, snippets) chain plain `?:` with no per-site blank guards. */
internal fun String?.tierOrNull(): String? = this?.takeIf { it.isNotBlank() }

/** The rendered `from`/`to`/`isPeer` for a non-`"sent"` mailbox entry. */
internal data class MessageAttribution(val from: String?, val to: String?, val isPeer: Boolean)

/** The rendered attribution for a non-`"sent"` mailbox entry. An ordinary entry collapses to the
 * thread's own fixed peer (`team`, no `to`, not a peer row) - the single-peer-per-thread invariant.
 * A `"peer"` mirror entry's own `from`/`to` are the real two parties of an agent-to-agent exchange,
 * independent of which participant's thread it's filed under, so those are resolved and used
 * instead of the thread's peer - `isPeer` is set whenever `kind` says so, even if `to` itself fails
 * to resolve, so a peer row's real `from` is never mistaken for an ordinary row downstream just
 * because its `to` came back null. `canonicalize` stands in for address resolution (`fromCanonical`)
 * so this stays pure/testable. */
internal fun resolveMessageAttribution(
	kind: String,
	entryFrom: String?,
	entryTo: String?,
	team: String,
	canonicalize: (String) -> String?,
): MessageAttribution =
	if (kind == "peer") {
		MessageAttribution(entryFrom?.let(canonicalize) ?: team, entryTo?.let(canonicalize), isPeer = true)
	} else {
		MessageAttribution(team, null, isPeer = false)
	}

/** What a Message's `from`/`to` should be written as in persisted JSON: both null for an ordinary
 * row (re-derived from the thread key on load instead, so persisting them there is dead weight),
 * or the real `from`/`to` verbatim for a peer-mirror row. Keyed on `isPeer`, not `to`'s presence -
 * a peer row's `to` can be null (an unresolvable wire address) while its `from` is still real and
 * worth keeping. */
internal fun persistedAttribution(m: Message): Pair<String?, String?> =
	if (m.isPeer) m.from to m.to else null to null

/** A loaded row's `from`/`to`, given what was actually persisted (both null for an ordinary row),
 * whether the row was persisted as a peer row, and the thread's own canonical key to fall back to.
 * A peer-mirror row's persisted `from`/`to` are kept verbatim; an ordinary row's author re-derives
 * from the thread key instead (the single-peer-per-thread invariant). */
internal fun loadedAttribution(
	persistedFrom: String?,
	persistedTo: String?,
	isPeer: Boolean,
	isMe: Boolean,
	canonicalKey: String,
): Pair<String?, String?> =
	when {
		isMe -> null to null
		isPeer -> (persistedFrom ?: canonicalKey) to persistedTo
		else -> canonicalKey to null
	}

/** The thread map after forgetting `key`: drops its own thread, then sweeps every remaining
 * thread for a peer-mirror row that names `key` as either real party. The gateway mirrors an
 * agent-to-agent exchange into BOTH participants' mailboxes as separate thread keys, so dropping
 * only `threads[key]` would leave the identical row (real address, message text, attachments)
 * fully intact in the other participant's thread, defeating what "drop a peer from this device"
 * is supposed to mean. */
internal fun threadsAfterForget(threads: Map<String, List<Message>>, key: String): Map<String, List<Message>> =
	(threads - key).mapValues { (_, msgs) -> msgs.filterNot { it.isPeer && (it.from == key || it.to == key) } }

/** Whether a peer-mirrored exchange's auto-play should be suppressed because an identical
 * `(from, to)` pair already claimed this poll pass's one auto-play slot. The gateway mirrors an
 * agent-to-agent exchange into BOTH participants' mailboxes as separate thread keys (see
 * `threadsAfterForget` above), so one exchange otherwise reaches the burst loop twice - once per
 * thread - and gets spoken twice over if both threads are followed at once. `seenPairs`
 * accumulates across one pass over `burst`, so the first thread to claim a pair wins and the
 * second is suppressed. Always false for a non-peer message: an ordinary entry lands in exactly
 * one thread and never duplicates. */
internal fun isDuplicatePeerAutoPlay(lastAgent: Message?, seenPairs: MutableSet<String>): Boolean {
	val pair = lastAgent?.takeIf { it.isPeer }?.let { "${it.from}|${it.to}" } ?: return false
	return !seenPairs.add(pair)
}

/** A tier's TTS text, framed as "from to to: text" for a peer-mirror row so it never plays back
 * as if addressed to this console - neither party in a peer-mirror row is this console's own
 * team, unlike every other message this reads aloud. Spoken form spells out "to" rather than an
 * arrow glyph, since TTS engines render symbols unpredictably. */
internal fun ttsTextFramed(state: ChatState, msg: Message, tier: SttsPlayer.Tier): String {
	val text = SttsPlayer.ttsText(msg, tier)
	if (!msg.isPeer) return text
	val fromLabel = msg.from?.let { state.label(it, state.localGatewayId) } ?: "someone"
	val toLabel = msg.to?.let { state.label(it, state.localGatewayId) }
	return if (toLabel != null) "$fromLabel to $toLabel: $text" else "$fromLabel: $text"
}

/** The thread index a `sent` echo should replace, or -1 to append as a new row. Folds an
 * at-least-once re-drain by (epoch, seq), then on the sending device matches this owner message's
 * row by opId whatever its current seq. Matching by opId alone (not just the seq-0 optimistic row)
 * means a duplicate echo (same opId, a fresh seq from a reconcile re-send across a gateway restart)
 * folds onto the already-upgraded row instead of stranding a second copy. */
internal fun sentEchoMatch(thread: List<Message>, echo: Message): Int {
	if (echo.seq > 0) {
		val bySeq = thread.indexOfFirst { it.seq == echo.seq && it.epoch == echo.epoch }
		if (bySeq >= 0) return bySeq
	}
	if (echo.opId != null) return thread.indexOfFirst { it.fromMe && it.opId == echo.opId }
	return -1
}

////////////////////////////////
//  Read anchor (scroll-driven unread tracking)
//
//  A row counts toward unread when it is inbound (an agent row) with real mailbox coordinates - a
//  `sent` echo also carries seq > 0 (it is the owner's own message mirrored to their devices), so
//  this is never a bare seq check.

internal fun Message.countsUnread(): Boolean = !fromMe && seq > 0L

/** The persisted per-team read anchor: a mailbox journal coordinate. Resolved to its row by
 * EQUALITY only - mailbox epochs are random per instance (device-mailbox.ts) and never ordered,
 * so comparing them numerically is unsound. `at` rides along for diagnostics only. */
data class ReadAnchor(val epoch: Long, val seq: Long, val at: Long)

/** The anchor's row index in `thread` (arrival/persisted order - never re-sorted), by (epoch, seq)
 * equality. -1 when there is no anchor, or its row is gone (a forgotten sweep, a corrupt store) -
 * every inbound row then counts, and any receipt is treated as a genuine advance. */
internal fun anchorIndex(thread: List<Message>, anchor: ReadAnchor?): Int {
	if (anchor == null) return -1
	return thread.indexOfFirst { it.epoch == anchor.epoch && it.seq == anchor.seq }
}

/** Unread count: inbound rows positioned strictly after the anchor's row. */
internal fun unreadCount(thread: List<Message>, anchor: ReadAnchor?): Int {
	val idx = anchorIndex(thread, anchor)
	return thread.withIndex().count { (i, m) -> i > idx && m.countsUnread() }
}

/** The unread rows themselves, in thread order - the notification's preview lines and Play
 * actions derive from this, never a stale burst list, so a mid-drain refresh stays accurate. */
internal fun unreadRows(thread: List<Message>, anchor: ReadAnchor?): List<Message> {
	val idx = anchorIndex(thread, anchor)
	return thread.filterIndexed { i, m -> i > idx && m.countsUnread() }
}

/** The first unread row's id, or null when there is none. */
internal fun firstUnreadId(thread: List<Message>, anchor: ReadAnchor?): Long? {
	val idx = anchorIndex(thread, anchor)
	return thread.withIndex().firstOrNull { (i, m) -> i > idx && m.countsUnread() }?.value?.id
}

/** Resolve a reported "read up to" row (by id, with an `at` sanity check so an id reused after a
 * forget sweep can never wrongly credit) to the anchor it implies: the row itself if it counts,
 * else walk BACK to the nearest earlier inbound row (a reported fromMe/seq==0 bottom row - the
 * user's own pending send - still marks everything above it read). Null when unresolvable (absent
 * id, mismatched `at`, or nothing above the report counts yet). */
internal fun resolveReportedAnchor(thread: List<Message>, rowId: Long, reportedAt: Long): ReadAnchor? {
	val idx = thread.indexOfFirst { it.id == rowId }
	if (idx < 0 || thread[idx].at != reportedAt) return null
	for (i in idx downTo 0) {
		val m = thread[i]
		if (m.countsUnread()) return ReadAnchor(m.epoch, m.seq, m.at)
	}
	return null
}

/** The last inbound row's coordinates, or null if the thread has none - the anchor a deliberate
 * "mark read" (notification swipe-away) advances to. */
internal fun lastInboundAnchor(thread: List<Message>): ReadAnchor? =
	thread.lastOrNull { it.countsUnread() }?.let { ReadAnchor(it.epoch, it.seq, it.at) }

/** Whether `candidate` is a genuine advance over `current`: its row must resolve, and sit at a
 * later index. An unresolvable `current` is index -1, so a receipt for ANY resolvable row always
 * advances - no deadlock. */
internal fun isAnchorAdvance(thread: List<Message>, current: ReadAnchor?, candidate: ReadAnchor): Boolean {
	val candidateIdx = thread.indexOfFirst { it.epoch == candidate.epoch && it.seq == candidate.seq }
	if (candidateIdx < 0) return false
	return candidateIdx > anchorIndex(thread, current)
}

/** After forgetting a team, re-anchor a SIBLING thread whose anchor row `threadsAfterForget` swept
 * away (a peer-mirror row naming the forgotten team). A no-op when the anchor still resolves, or
 * there was none. Falls back to the nearest surviving inbound row at-or-before the old anchor's
 * timestamp - the removed row's exact position no longer exists in `newThread`, so `at` (not list
 * position) is the only order still comparable across the sweep. */
internal fun reanchorAfterForget(newThread: List<Message>, anchor: ReadAnchor?): ReadAnchor? {
	if (anchor == null || anchorIndex(newThread, anchor) >= 0) return anchor
	return newThread.lastOrNull { it.countsUnread() && it.at <= anchor.at }?.let { ReadAnchor(it.epoch, it.seq, it.at) }
}

data class ChatState(
	val provisioned: Boolean = false,
	val teams: List<Team> = emptyList(),
	val threads: Map<String, List<Message>> = emptyMap(),
	val unread: Map<String, Int> = emptyMap(),
	/** Per-team read anchor (a mailbox journal coordinate) - the single source of truth `unread` is
	 * derived from. Persisted; see `persistReadAnchors`/`loadPersistedReadAnchors`. */
	val readAnchors: Map<String, ReadAnchor> = emptyMap(),
	val openTabs: List<String> = emptyList(),
	/** Teams explicitly closed via Close Tab, cleared again the moment that team's tab is reopened.
	 * Gates full notification treatment (banner + TTS) down to a quiet mailbox/unread-count bump:
	 * a team NEVER opened is not in this set either, so a brand-new session still notifies normally -
	 * only an explicit close (not merely being absent from `openTabs`, which a never-opened session
	 * is too) should downgrade a team's pings. */
	val closedTeams: Set<String> = emptySet(),
	/** Per-session working truth from a tmux peek (the spinner marker), keyed like working()'s
	 * argument. Takes precedence over the message-status heuristic once a peek has landed. */
	val sessionWorking: Map<String, Boolean> = emptyMap(),
	/** Per-session not-logged-in truth from a tmux peek (the auth footer). A logged-out session still
	 * renders a composer, so this is tracked apart from working/live and drives the check-terminal chip. */
	val sessionNeedsLogin: Map<String, Boolean> = emptyMap(),
	val status: String = "",
	val error: String? = null,
	val gap: Boolean = false,
	val biometricLock: Boolean = false,
	val deviceName: String = "",
	val labels: Map<String, String> = emptyMap(),
	/** Consecutive fresh-teams observations a locally-labeled team has been missing entirely from
	 * (as opposed to present with no server label yet). Feeds withFreshTeams' prune rule; a team
	 * present in `labels` is never in this map until it first goes missing. */
	val teamAbsenceStreaks: Map<String, Int> = emptyMap(),
	val connected: Boolean = false,
	val pollFailStreak: Int = 0,
	/** Connected Gateway id, learned from the register result. Empty before the first
	 * federation-aware connect; bare names resolve to the local Gateway in that case. */
	val localGatewayId: String = "",
	/** Non-zero (epoch ms) while a post-enrollment allowlist sync is in progress: the device
	 * is admitted but the route Gateway has not re-synced yet, so sealed ops transiently reject.
	 * Drives the calm SYNCING header; cleared the moment an op succeeds or the grace lapses. */
	val enrollingSince: Long = 0L,
	/** The linked friend Domains the route Gateway reports from its cross-Domain peer set
	 * (cross_domain_list_peers). Unioned with the discovery-derived Domains in linkedDomains() so a
	 * freshly-linked peer is visible (and its detail reachable) even while its gateway is offline and
	 * has shared nothing back. Refreshed alongside teams; an empty set falls back to discovery-only. */
	val linkedPeerOwners: Map<String, String> = emptyMap(),
	/** This owner's own display name, for the profile field and the MY NETWORK card. Seeded from the
	 * local cache and refreshed from discovery's local-session displayName; empty until set. */
	val displayName: String = "",
	/** True once this device has first-rooted a pending friend Domain from its invite blob. Lets the
	 * empty board tell a friend who is set up but has no host yet (the Setting-up-a-host pointer)
	 * from an admin who has not admitted a Gateway. */
	val firstRooted: Boolean = false,
	/** A one-shot message for a transient event (a create/close/wake failure) to show as a Snackbar.
	 * Deliberately separate from `error`, which drives the STICKY connection-health header/EmptyBoard
	 * cause - writing a one-off message there would bleed into an unrelated later health render.
	 * Consumed via consumeTransientMessage(). */
	val transientMessage: String? = null,
	/** (project, label) pairs with a spawnSession() call currently in flight. Distinct from the
	 * longer-lived opId retry window (recentSpawnOpIds): this is only "has not settled yet", so the
	 * spawn dialog can refuse a second identical submission while the first is still resolving rather
	 * than silently reattaching to it (see spawnSession's opId-reuse doc comment). */
	val pendingSpawns: Set<Pair<String, String>> = emptySet(),
) {
	/** Sessions shows live teams plus any team we already have a thread with
	 * (agent-initiated). A thread-only peer is gone from the bridge and cannot be
	 * woken, so it is synthesized as an ended loose session with no mode.
	 * Both sides are compared by their canonical key so a bare vs qualified form
	 * of the same team never produces a phantom "ended" entry. */
	fun sessions(localGatewayId: String): List<Team> {
		// Team names and thread keys are both the canonical address string now, so the join is a
		// direct set membership test - no per-key re-canonicalization (the grammar is already
		// canonical, and a one-shot schema wipe cleared any old-grammar persisted keys).
		val known = teams.mapTo(HashSet()) { it.name }
		val extra = threads.keys.filter { it !in known }.map { Team(it, "ended", "", 0) }
		return teams + extra
	}

	/** Replace the live teams list from a fresh fetch, folding in the two rules that keep a LOCAL
	 * label override (`labels`) from outliving its reason to exist:
	 *  - the moment the server reports its own non-null sessionLabel for a team, the local override
	 *    is dropped - whatever that server value is - self-healing a stale edit, including one this
	 *    same device made once the server catches up to it.
	 *  - a locally-labeled team missing from the fresh list ENTIRELY (forgotten or TTL-swept
	 *    elsewhere, which the rule above can never observe since it never appears to report a label
	 *    at all) accumulates a streak; only once it crosses ABSENCE_PRUNE_STREAK consecutive misses is
	 *    the local override dropped too. A single miss is deliberately not enough - a momentary gap
	 *    must never wipe a legitimate pending edit - and reappearing (labeled or not) resets it. */
	fun withFreshTeams(freshTeams: List<Team>): ChatState {
		val fresh = freshTeams.associateBy { it.name }
		val nextLabels = mutableMapOf<String, String>()
		val nextStreak = mutableMapOf<String, Int>()
		for ((team, label) in labels) {
			val server = fresh[team]
			when {
				server?.sessionLabel != null -> {}
				server != null -> nextLabels[team] = label
				else -> {
					val streak = (teamAbsenceStreaks[team] ?: 0) + 1
					if (streak < ABSENCE_PRUNE_STREAK) {
						nextLabels[team] = label
						nextStreak[team] = streak
					}
				}
			}
		}
		return copy(teams = freshTeams, labels = nextLabels, teamAbsenceStreaks = nextStreak)
	}

	/** Whether the agent is actively working a turn: a tmux peek (the spinner marker) when one has
	 * landed, else a message-status heuristic (a pending/sent tail, or a waking/running placeholder). */
	fun working(team: String): Boolean {
		sessionWorking[team]?.let { return it }
		val last = threads[team]?.lastOrNull() ?: return false
		return (last.fromMe && (last.status == null || last.status == "pending")) ||
			last.status == "running" || last.status == "waking"
	}

	/** Whether the agent's session is logged out (its tmux auth footer shows "Not logged in"), from a
	 * peek. Independent of working/live: a logged-out session still presents a composer. */
	fun needsLogin(team: String): Boolean = sessionNeedsLogin[team] == true

	/** Bridge link health for the dashboard header: green once registered and polling
	 * cleanly, blue while finishing enrollment (allowlist syncing), amber while a poll-failure
	 * streak is building, red when offline. */
	enum class Health { ONLINE, SYNCING, DEGRADED, OFFLINE }

	val health: Health
		get() = when {
			connected && pollFailStreak == 0 -> Health.ONLINE
			enrollingSince != 0L && !connected -> Health.SYNCING
			pollFailStreak >= 2 -> Health.OFFLINE
			connected -> Health.DEGRADED
			else -> Health.OFFLINE
		}

	/** Terminal "no Gateway admitted yet": the board shows the Add-a-Gateway onboarding CTA rather
	 * than a connection error. Keyed off the classified cause; classifyConnError emits the
	 * "Add a Gateway ..." message for the no-gateway / empty-keyring case, so keep that prefix in
	 * sync with the one match site. */
	val needsGateway: Boolean
		get() = error?.startsWith("Add a Gateway") == true

	/** Which no-gateway empty-board guidance applies: the friend's just-set-up "bring up a host"
	 * state vs the admin's Add-a-Gateway onboarding, split off the first-root latch. */
	val noGatewayState: NoGatewayState
		get() = FriendOnboarding.noGatewayState(needsGateway, firstRooted)

	/** Last local activity time for a thread, for the session card subtitle. */
	fun lastActivity(team: String): Long? = threads[team]?.maxByOrNull { it.at }?.at

	/** One-line preview from the thread tail. Prefers a notice's title over its long report
	 * body, the same as the notification line. */
	fun snippet(team: String): String? = threads[team]?.lastOrNull()?.let { it.title ?: it.text }
		?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }

	/** A team's label without address disambiguation: a local rename wins, then the gateway's
	 * sessionLabel. Null when neither exists (an older gateway, or a thread-only ended peer). The
	 * single owner of the label precedence. */
	fun labelOrNull(team: String): String? = labels[team] ?: teams.firstOrNull { it.name == team }?.sessionLabel

	/** The friendly name for a team, falling back to the session leaf of the canonical address. The
	 * board nests under a spawn-point header, so the leaf alone identifies the session. The raw
	 * canonical key is never shown. */
	fun label(team: String, localGatewayId: String = ""): String = labelOrNull(team) ?: sessionLeaf(team)
}

/** Recompute `team`'s unread count from `thread` and this state's OWN current anchor for it - the
 * single derivation every writer (append, receipt, markRead, forget, startup) converges on, so
 * `unread` can never drift from `threads`/`readAnchors`. */
internal fun ChatState.recomputeUnread(team: String, thread: List<Message>): ChatState =
	copy(unread = unread + (team to unreadCount(thread, readAnchors[team])))

/** Consecutive fresh-teams observations a locally-labeled team may miss entirely before
 * withFreshTeams prunes its local override. More than one so a single transient gap in a fetch
 * (not the team itself being gone) cannot wipe a legitimate pending edit. */
private const val ABSENCE_PRUNE_STREAK = 2

/** A just-enrolled device's first ops can transiently reject while the route Gateway
 * re-syncs the new admission from evie (it only re-syncs on its next re-register). We
 * show a calm "Finishing up enrollment..." and retry, escalating to a real error only if
 * the sync never lands within this grace window. */
private const val ENROLL_GRACE_MS = 90_000L

/** How often each phone re-polls the evie broker for the peer's commit/reveal frame during the
 * in-person enroll ceremony. A short cadence (the peer is on screen beside you) without hammering
 * the relay. */
private const val ENROLL_POLL_MS = 2_000L

/** Max poll attempts per handshake round before giving up (2s * 150 = 5 min, comfortably under the
 * broker's 10-min window TTL). A vanished peer fails with a timeout rather than hanging forever. */
private const val ENROLL_POLL_MAX = 150

/** FLOW-2 rendezvous sides: who ARMED (initiator) vs who JOINED a highlighted arm (target). Distinct
 * from the SAS role (ADMIN/ENROLLEE by sorted owner key) - the side picks the broker frame, the role
 * orders the SAS. Must match the TrustHandshakeOp.Reveal `side` literals on the wire. */
internal const val TRUST_SIDE_INITIATOR = "INITIATOR"
internal const val TRUST_SIDE_TARGET = "TARGET"

/** Three-way classification of a connect/poll/relay failure. */
internal enum class ConnKind {
	/** Needs human action (re-provision, bad creds, app update); surface immediately. */
	TERMINAL,

	/** A network or server blip; retry quietly (one hiccup never alarms). */
	TRANSIENT,

	/** The device IS admitted, but this Gateway has not re-synced its allowlist yet, so a
	 * sealed op rejects with "...is not admitted to the Domain". Self-heals on the next
	 * re-register; show "Finishing up enrollment..." and escalate only past the grace window. */
	ENROLLING,
}

/**
 * Map a connect/poll failure to a SPECIFIC, actionable cause + its kind, instead of a
 * blanket "Connection issue". ConsoleClient preserves the real cause in the exception
 * message ("This device is not enrolled...", "HTTP 404: ...", a TLS exception), so this is
 * a pure mapping - no new probing.
 */
internal fun classifyConnError(e: Throwable): Pair<String, ConnKind> {
	val m = e.message ?: ""
	return when {
		// The server sealer rejecting an admitted device whose admission this Gateway has not
		// synced yet (console OR cross-Gateway federation). NOT terminal - it converges. Kept
		// first, and distinct from the local "keys are missing" terminal below, so a normal
		// sync lag can never be mislabeled "re-run the script".
		m.contains("is not admitted to the Domain", ignoreCase = true) ->
			"Finishing up enrollment..." to ConnKind.ENROLLING
		// A rejected admission submission (e.g. the app's owner key does not match the Domain evie is
		// rooted at) will NOT self-heal by waiting - surface it instead of the calm sync-lag above.
		m.contains("admission rejected", ignoreCase = true) ->
			"${m.take(100)} - re-run setup.sh, then re-import the setup blob" to ConnKind.TERMINAL
		// The Keystore-backed store failed to initialize, so the app fails closed (refuses to
		// persist the federation key in cleartext). Re-running provision does not help; the device's
		// secure storage must work. Distinct from "not enrolled" (which sounds fixable by re-running).
		m.contains("secure storage unavailable", ignoreCase = true) ->
			"Secure storage unavailable - turn on a screen lock, then retry" to ConnKind.TERMINAL
		// A stored key whose bytes are present but did not decode. Re-provisioning does NOT mint
		// over it (fail closed), so the only fixes are a backup restore or a deliberate recovery -
		// distinct from "not enrolled" (which a re-import does fix).
		m.contains("corrupt", ignoreCase = true) && m.contains("did not decode", ignoreCase = true) ->
			"Stored key unreadable - restore from backup or re-run setup.sh" to ConnKind.TERMINAL
		m.contains("not enrolled", ignoreCase = true) ->
			"Not enrolled - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		// A local provisioning gap (the blob did not carry the Gateway keys/id). Worded in
		// ConsoleClient WITHOUT the "not admitted" token so it cannot collide with ENROLLING.
		m.contains("keys are missing", ignoreCase = true) || m.contains("not provisioned", ignoreCase = true) ->
			"Gateway not provisioned - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		// The Console has no Gateway admitted yet (fresh setup), or none for this target in its
		// keyring. The fix is to admit a Gateway from the management UI, not to re-provision.
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
		e is javax.net.ssl.SSLHandshakeException || e is java.security.cert.CertificateException ||
			m.contains("trust anchor", ignoreCase = true) || m.contains("CertPath", ignoreCase = true) ->
			"Server certificate changed - re-run setup.sh" to ConnKind.TERMINAL
		// Freshness/replay rejects clear on the next attempt (a retry carries a fresh
		// timestamp + new nonce), so they are transient. Checked AFTER the TLS branch so a
		// handshake-signature error is not mislabeled.
		m.contains("stale", ignoreCase = true) || m.contains("replay", ignoreCase = true) ->
			"Re-syncing the secure channel - retrying" to ConnKind.TRANSIENT
		// A genuine key mismatch (bad signature / cannot decrypt) is terminal.
		m.contains("signature", ignoreCase = true) || m.contains("decrypt", ignoreCase = true) ->
			"Secure channel rejected - re-run setup.sh and re-import the setup blob" to ConnKind.TERMINAL
		e is java.net.UnknownHostException ->
			"Offline - no network" to ConnKind.TRANSIENT
		e is java.net.ConnectException || e is java.net.SocketTimeoutException || e is java.io.InterruptedIOException ->
			"Can't reach the server - retrying" to ConnKind.TRANSIENT
		else -> "Error: ${m.take(100)}" to ConnKind.TRANSIENT
	}
}

/** Fold an ENROLLING (sync-lag) failure: start/keep the grace timer so we keep showing the
 * calm "Finishing up enrollment..." cause, but once the window lapses return a terminal
 * override message (and clear the timer) so a sync that never lands surfaces a real error.
 * Returns (overrideMessage-or-null, enrollingSince-to-persist). */
private fun enrollFold(prevSince: Long): Pair<String?, Long> {
	val since = if (prevSince == 0L) System.currentTimeMillis() else prevSince
	return if (System.currentTimeMillis() - since > ENROLL_GRACE_MS) {
		"Enrollment did not finish - re-run setup.sh and re-import the setup blob." to 0L
	} else {
		null to since
	}
}

/** The leaf (session) segment of a canonical address string - the natural per-session label. A
 * spawn-point (arity 3) yields its spawn segment; an unparseable value degrades to "?" rather than
 * echoing the raw string back, so a corrupted or malformed canonical key can never surface a full
 * internal domain/gateway address where a safe placeholder belongs. */
internal fun sessionLeaf(canonical: String): String =
	runCatching {
		when (val t = parseTarget(canonical, "", "")) {
			is Address -> t.session
			else -> canonical.substringAfterLast('.')
		}
	}.getOrDefault("?")

/** Wraps a drained MailboxEntry as a SyncEntry so the SyncCursor rules can dedupe/advance
 * by seq while the poll loop keeps the full entry to render. */
private data class Drained(val entry: MailboxEntry) : SyncEntry {
	override val seq: Long get() = entry.seq
}

/**
 * Chat state over a ConsoleClient. Holds per-team threads, an unread tally, the open
 * tab set, and a poll loop that drains the device mailbox, dedupes by mailbox seq,
 * and routes each reply to its team (parsed from the `conv.<id>.<domain>.<gateway>.<spawn>.<session>`
 * session id or the entry's `from`). Transcripts persist encrypted so history survives restarts.
 */
class ChatRepository(
	private val store: AppStateStore,
	private val filesDir: File,
	private val contentResolver: ContentResolver,
	// STTS provider catalog, parsed + validated once from the bundled asset by
	// Repo.get. Empty only if the asset is missing/corrupt (Play stays dark).
	private val sttsCatalog: List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = emptyList(),
) {
	/** TTS playback engine; cache lives under filesDir/stts/<team>/. Declared before the migration
	 * init block so the one-shot wipe can purge its cache root. */
	val stts = SttsPlayer(filesDir)

	// One-shot grammar-version wipe. MUST run before the first thread/label load-parse below, so a
	// stale-grammar persisted key (`gateway/name`) never reaches the new parser. Kotlin runs init
	// blocks and property initializers top-to-bottom, so this clears the old keys before _state's
	// loadPersistedThreads()/loadPersistedLabels() read them.
	init {
		if (store.migrateSchemaIfNeeded()) {
			// The prefs wipe never touched filesDir, so the matching grammar-era caches (attachment
			// bytes + TTS audio) would otherwise stay stranded. Purge them on the same one-shot latch.
			stts.purgeAll()
			Attachments.purgeAll(filesDir)
		}
	}

	// Declared before _state so loadPersistedThreads/Labels/ReadAnchors read them in order. Kotlin
	// initializes fields in declaration order.
	@Volatile private var localGatewayId: String = store.loadGatewayId()
	private val loadedThreadsAtStartup: Map<String, List<Message>> = loadPersistedThreads()
	private val loadedReadAnchorsAtStartup: Map<String, ReadAnchor> = loadPersistedReadAnchors(loadedThreadsAtStartup)

	private val _state = MutableStateFlow(
		ChatState(
			provisioned = store.load() != null,
			threads = loadedThreadsAtStartup,
			readAnchors = loadedReadAnchorsAtStartup,
			unread = loadedThreadsAtStartup.mapValues { (team, msgs) -> unreadCount(msgs, loadedReadAnchorsAtStartup[team]) },
			biometricLock = store.biometricLock,
			deviceName = currentDeviceName(),
			labels = loadPersistedLabels(),
			teamAbsenceStreaks = loadPersistedAbsenceStreaks(),
			localGatewayId = localGatewayId,
			displayName = store.displayName,
			firstRooted = store.firstRooted,
		),
	)
	val state: StateFlow<ChatState> = _state

	////////////////////////////////
	//  Address helpers
	//
	//  The store grammar is the canonical Address (`domain.gateway.spawn.session`); thread/team keys
	//  ARE that canonical string. These resolve a wire/local target to it, mirroring the gateway's own
	//  minting so a console-derived key is byte-equal to a gateway-derived session_id.

	/** The local Domain id for minting/comparing local addresses, learned from a local session. Empty
	 * (arming mode / not yet confirmed) is passed through to parseTarget, which maps it to the sentinel
	 * - the same fallback the gateway uses. */
	private fun localDomain(): String = confirmedDomainId() ?: ""

	/** Canonicalize a target to its full address key. Accepts a local `spawn`/`spawn.session` (from the
	 * spawn dialog) or an already-canonical address (from the board). Guarded so a malformed value
	 * falls back to itself rather than throwing into the UI. */
	private fun canonicalTarget(team: String): String =
		runCatching { parseTarget(team, localDomain(), localGatewayId).canonical }.getOrDefault(team)

	/** A `from` field (a canonical address or a local team field) resolved to its canonical address
	 * for thread attribution, or null when it is not an address (a free-form Device Name). Null lets
	 * the caller fall back to the store-key sender instead of keying a thread by a non-address - which
	 * would otherwise become an unsendable ghost chat. */
	private fun fromCanonical(from: String): String? =
		runCatching { parseTarget(from, localDomain(), localGatewayId).canonical }.getOrNull()

	/** This device's own session address. The spawn segment is the OWNER id (matching the gateway's
	 * consoleSelfAddress), NOT the free-form device name, so a device name with spaces/capitals no
	 * longer breaks the self-thread check. Null only when the owner key is not yet available. */
	private fun thisDeviceAddress(): Address? =
		runCatching {
			Address.local(localDomain(), localGatewayId, ownerKeyId(federation.ownerSignPub()), Protocol.DEFAULT_SESSION)
		}.getOrNull()

	// Read and invalidated across threads (poll loop, main, the player's daemon thread);
	// @Volatile gives the writes visibility. A rare double-construct race is harmless
	// (last writer wins, cheap build).
	@Volatile private var client: ConsoleClient? = null
	// The mailbox cursor is console-owned and durable: MailboxSync loads it from the store
	// and the console resumes from its own consumption point, never re-adopting a server-
	// dictated cursor that would ack away the offline backlog on the next poll.
	private val mailboxSync = MailboxSync(store)
	// The Domain trust anchor: owner root key, console member identity, and the keyring
	// the Console resolves every Gateway against before sealing to it.
	private val federation = FederationManager(store)
	// RECEIVER link state: the requester-minted pin learned from a listen-state poll, keyed by the
	// receiver's listening token. The receiver needs it to confirm its pairing (the gateway resolves
	// the window by the pin), but the wizard only holds the token, so the poll stashes it here.
	private val receiverPin = mutableMapOf<String, String>()
	// ADMIN-side enroll-invite secrets (handshakeId + pin) minted per staged tenant when the invite
	// blob is built, reused to drive the admin's leg of the in-person compare. Transient like the link
	// ceremony's linkNonce: the in-person flow keeps the detail screen open, and regenerating the
	// invite mints fresh secrets (abandoning the old QR's window).
	private val enrollInvites = java.util.concurrent.ConcurrentHashMap<String, EnrollInvite>()
	private var pollFails = 0
	private var pollJob: Job? = null
	// The poll loop's scope, reused to launch auto-TTS preloads that gate the
	// notification (so the audio is cached before the user is pinged).
	private var pollScope: CoroutineScope? = null

	@Volatile private var sttsClient: SttsClient? = null

	/** True while the Activity is started; drives the poll cadence (5s visible,
	 * 60s AFK burst). The mailbox accumulates server-side either way. */
	@Volatile private var visible = false
	val isVisible: Boolean get() = visible
	// Set alongside `visible = true`: onForeground front-runs the resume-kicked drain, so every
	// message still sitting in the mailbox at resume would otherwise tag arrivedVisible=true (the
	// user never actually saw it). Cleared once the first poll pass since the transition commits,
	// so only the genuinely-backgrounded backlog is tagged not-visible; a live message the NEXT
	// pass drains while still foregrounded tags normally.
	@Volatile private var resumeBacklogPending = false
	private val kick = Channel<Unit>(Channel.CONFLATED)
	@Volatile private var forceTeamsRefresh = false
	// Rows already given their one reconcile attempt this process. Synchronized:
	// the service's start and the Activity's foreground transition can race here.
	private val reconciled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	/** Set by the service: called per poll with the new inbound messages of one
	 * team, so a background burst can become a notification. */
	var onInbound: ((team: String, messages: List<Message>) -> Unit)? = null

	/** Data-plane subscribers, invoked once per genuinely-new inbound message at the drain gate
	 * (see the poll loop). Delivery is synchronous and pre-commit, so a subscriber inherits the
	 * mailbox cursor's exactly-once + crash-safety; it must be fast, non-blocking, and idempotent. */
	private val inboundSubscribers = java.util.concurrent.CopyOnWriteArrayList<InboundSubscriber>()

	/** Register a data-plane subscriber. Add-once per process (the caller is a singleton); a
	 * duplicate add would double-deliver. */
	fun addInboundSubscriber(subscriber: InboundSubscriber) {
		inboundSubscribers.addIfAbsent(subscriber)
	}

	/** Plugin-action subscribers, invoked once per `plugin_action` mailbox entry at the drain gate.
	 * Delivery is at-least-once (this entry never renders a chat message, so it has no persisted
	 * fold to dedupe a redraw against); a subscriber must be fast, non-blocking, and idempotent. */
	private val pluginActionSubscribers = java.util.concurrent.CopyOnWriteArrayList<PluginActionSubscriber>()

	/** Register a plugin-action subscriber. Add-once per process, same as [addInboundSubscriber]. */
	fun addPluginActionSubscriber(subscriber: PluginActionSubscriber) {
		pluginActionSubscribers.addIfAbsent(subscriber)
	}

	/** The Activity came on screen: gateway to the fast cadence, optimistically
	 * clear a doze-corpse failure banner (the kicked poll re-raises it within
	 * seconds if the bridge is genuinely down), and poll right now. */
	fun onForeground() {
		visible = true
		resumeBacklogPending = true
		pollFails = 0
		_state.update { it.copy(error = null, pollFailStreak = 0, enrollingSince = 0L) }
		forceTeamsRefresh = true
		kick.trySend(Unit)
	}

	fun onBackground() {
		visible = false
	}

	private fun client(): ConsoleClient {
		client?.let { return it }
		val blob = store.load() ?: error("not provisioned")
		return ConsoleClient(Provisioning.parse(blob), store).also { client = it }
	}

	/** STTS client from the settings-backed creds (NOT the blob), or null when not
	 * configured. The cache is invalidated by setSttsCreds() on an in-app edit, the
	 * one mutation point - so an edited key takes effect without an app restart. */
	private fun sttsClient(): SttsClient? {
		sttsClient?.let { return it.takeIf { c -> c.isConfigured } }
		// Cache only a configured client, so an unconfigured build (fresh install, no key yet)
		// is not retained as an idle OkHttpClient until creds arrive.
		return SttsClient(store.sttsUrl, store.sttsKey).takeIf { it.isConfigured }?.also { sttsClient = it }
	}

	/** Gates the Play surfaces; true once settings carry sttsUrl + sttsKey AND the
	 * bundled catalog parsed (without descriptors there is nothing to play). */
	fun sttsReady(): Boolean = sttsClient() != null && sttsCatalog.isNotEmpty()

	/** True when settings carry a non-empty url + key (the Connection block is
	 * configured), independent of catalog/health. */
	fun sttsConfigured(): Boolean = store.sttsUrl.isNotEmpty() && store.sttsKey.isNotEmpty()

	/** The current in-app voice creds, for seeding the settings Connection fields. */
	val sttsUrl: String get() = store.sttsUrl
	val sttsKey: String get() = store.sttsKey

	/** The single mutation choke for the in-app voice creds: validate+normalize the URL
	 * (via normalizeSttsUrl, so the key is never persisted to an unvalidated host), store the
	 * clean origin + trimmed key, and invalidate the cached client so the next sttsClient()
	 * rebuilds. Returns the stored origin, or null if the URL is invalid (nothing persisted),
	 * which the caller surfaces. Enforcing validation HERE means no caller can bypass it. */
	fun setSttsCreds(url: String, key: String): String? {
		val origin = normalizeSttsUrl(url) ?: return null
		store.sttsUrl = origin
		store.sttsKey = key.trim()
		sttsClient = null
		return origin
	}

	/** The provider descriptors for the settings picker. */
	fun sttsProviders(): List<com.atelier_nyaarium.switchboard.proto.SttsProvider> = sttsCatalog

	/** The selected provider id (the descriptor id, e.g. "XAI"). Unset resolves
	 * to XAI when present, else the first descriptor. */
	var sttsProviderId: String
		get() {
			val stored = store.sttsProvider
			if (stored.isNotEmpty()) return stored
			return sttsCatalog.firstOrNull { it.id == "XAI" }?.id ?: sttsCatalog.firstOrNull()?.id ?: ""
		}
		set(value) {
			store.sttsProvider = value
		}

	/** The descriptor for the current selection, or null if the stored id is not
	 * in the catalog (a removed provider) - the Play surfaces disable loudly
	 * rather than silently substituting another voice. */
	private fun currentProvider(): com.atelier_nyaarium.switchboard.proto.SttsProvider? {
		val id = sttsProviderId
		return sttsCatalog.firstOrNull { it.id == id }
	}

	/** True when the stored provider id is non-empty but absent from the catalog. */
	fun sttsProviderMissing(): Boolean {
		val id = store.sttsProvider
		return id.isNotEmpty() && sttsCatalog.none { it.id == id }
	}

	/** Per-provider voice; blank uses the descriptor default. */
	fun sttsVoiceFor(providerId: String): String = store.sttsVoiceFor(providerId)

	fun setSttsVoiceFor(providerId: String, voice: String) = store.setSttsVoiceFor(providerId, voice.trim())

	/**
	 * Speak one message tier (notification action or thread button). The whole
	 * resolution (credential decrypt, message lookup, text prep) hops to the
	 * player's daemon thread so a broadcast receiver's main thread does zero
	 * disk or crypto work. Cache and single-flight live in SttsPlayer, so
	 * impatient multi-taps synthesize once; tapping the playing message stops
	 * it. No-op when unconfigured or the message is gone.
	 */
	fun playMessage(team: String, at: Long, tier: SttsPlayer.Tier) {
		stts.post {
			val client = sttsClient() ?: return@post
			val provider = currentProvider() ?: return@post
			val msg = _state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return@post
			val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			stts.play(client, provider, voice, team, at, tier, ttsTextFramed(_state.value, msg, tier), sttsVolume)
		}
	}

	fun isMessagePlaying(team: String, at: Long): Boolean = stts.isPlayingMessage(team, at)

	fun stopPlayback() = stts.stop()

	/** When on, an incoming message for a followed (open) thread is
	 * pre-synthesized before its notification. Persisted in prefs. */
	var sttsAutoGen: Boolean
		get() = store.autoTts
		set(value) {
			store.autoTts = value
		}

	/** Which tier of a new message plays aloud automatically the moment it
	 * arrives. One of "off", "title", "summary", "full". Independent of
	 * sttsAutoGen. Persisted in prefs. */
	var sttsAutoPlay: String
		get() = store.autoPlay
		set(value) {
			store.autoPlay = value
		}

	/** TTS playback volume, 0-200% (100 = unchanged). Persisted in prefs. */
	var sttsVolume: Int
		get() = store.sttsVolume
		set(value) {
			store.sttsVolume = value
		}

	/** Map the autoPlay pref string to its tier, or null for "off"/unknown. */
	private fun autoPlayTier(value: String): SttsPlayer.Tier? = when (value) {
		"title" -> SttsPlayer.Tier.TITLE
		"summary" -> SttsPlayer.Tier.SUMMARY
		"full" -> SttsPlayer.Tier.FULL
		else -> null
	}

	/** Pre-synthesize both tiers of a message into the cache so a later Play is
	 * instant. Blocking; runs off the poll loop on an IO thread. Silent on any
	 * failure - the notification fires regardless and Play falls back to live
	 * synthesis. No-op when unconfigured or the message is gone. */
	private fun preloadMessage(team: String, at: Long) {
		val client = sttsClient() ?: return
		val provider = currentProvider() ?: return
		val msg = _state.value.threads[team]?.lastOrNull { it.at == at && !it.fromMe } ?: return
		val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
		stts.preloadBoth(
			client,
			provider,
			voice,
			team,
			at,
			ttsTextFramed(_state.value, msg, SttsPlayer.Tier.SUMMARY),
			ttsTextFramed(_state.value, msg, SttsPlayer.Tier.FULL),
		)
	}

	/** Settings voice preview with the current provider/voice. */
	fun playSttsSample() {
		stts.post {
			val client = sttsClient() ?: return@post
			val provider = currentProvider() ?: return@post
			val voice = sttsVoiceFor(provider.id).takeIf { it.isNotEmpty() }
			stts.playSample(client, provider, voice, "This is your switchboard voice.", sttsVolume)
		}
	}

	/** STTS service liveness WITH the failure cause, for the settings Connection status line. */
	suspend fun sttsProbe(): SttsProbe =
		withContext(Dispatchers.IO) { sttsClient()?.probe() ?: SttsProbe.Unreachable("not configured") }

	suspend fun provision(blob: String) = withContext(Dispatchers.IO) {
		// Strict wire parse: reject before persisting. Surfaced as state.error
		// rather than thrown - callers launch this from coroutines with no
		// catch, and the strict kotlinx parse rejects blobs the old lenient
		// org.json parser would have coerced (single quotes, stringy numbers).
		val prov = try {
			Provisioning.parse(blob)
		} catch (e: Exception) {
			_state.update { it.copy(error = "Invalid provisioning blob: ${e.message?.take(160) ?: "unparseable"}") }
			return@withContext
		}
		store.save(blob)
		// The blob is transport-only: the Console owns its locally-generated identity and resolves
		// every Gateway's keys from the synced keyring, so nothing cryptographic is imported. A
		// re-import is a fresh enrollment against a possibly re-rooted Domain, so clear the
		// console-admitted gate to re-submit this Console's admission on the next connect.
		store.consoleAdmitted = false
		// A re-import may carry a fresh invite (a friend re-onboarding, or a regenerated QR), so clear
		// the first-root latch: the next connect re-evaluates the blob's pendingTenant and re-roots if
		// present. An ordinary already-rooted blob (no pendingTenant) skips the step.
		store.firstRooted = false
		// A fresh invite is a fresh trust ceremony: re-offer the in-person compare on the next connect.
		store.enrollCeremonyDone = false
		client = null
		sttsClient = null
		// firstRooted=false in the state mirrors the latch reset so a re-imported fresh invite does not
		// show the "already set up" host pointer before the next connect re-evaluates the pendingTenant.
		_state.update { it.copy(provisioned = true, error = null, deviceName = prov.device, firstRooted = false) }
	}

	suspend fun connect() = withContext(Dispatchers.IO) {
		// DEBUG: wire the ingest sender from the blob up front, BEFORE any enroll step can fail, then
		// flush on every exit path (the finally below). Otherwise a pre-register failure (admission
		// submit, register) strands its trace on-device until a poll cycle that never starts. The
		// attach + flush + every DebugLog.log here compile out of release builds (BuildConfig.DEBUG).
		runCatching { store.load()?.let { DebugLog.attachIngest(Provisioning.parse(it)) } }
		DebugLog.log("Connect", "start gateway=${localGatewayId.ifEmpty { "?" }} admitted=${store.consoleAdmitted}")
		try {
			// Preflight the cluster path (API server + SA token + TLS) before blaming the
			// bridge or enrollment, so a stale blob says "re-provision" and a missing
			// identity says "not enrolled" - two different fixes that used to look identical.
			runCatching { client().apiReachable() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				_state.update {
					if (kind == ConnKind.TERMINAL) {
						it.copy(status = "error", error = "Cluster: $cause", connected = false, enrollingSince = 0L)
					} else {
						it.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
					}
				}
				return@withContext
			}
			DebugLog.log("Connect", "apiReachable ok")
			// First-root step (friend invite): a blob carrying a pendingTenant means this app must
			// root that pending Domain at its silently-generated owner key BEFORE submitting its own
			// admission (evie only trusts the owner-signed admission once the Domain is rooted at that
			// owner key). A reject (expired / already-claimed invite) is terminal: the root was
			// decided, not dropped, so stop with the friendly guidance.
			if (!firstRootIfPending()) return@withContext
			// Reflect the first-root latch into the UI state now, so if the steps below fail with the
			// no-gateway cause (a freshly-rooted friend has no host yet) the empty board shows the
			// "set up, now bring up a host" guidance rather than the admin Add-a-Gateway CTA.
			if (store.firstRooted && !_state.value.firstRooted) _state.update { it.copy(firstRooted = true) }
			// Submit this Console's own admission before the sealed register, so the Gateway
			// has an owner-signed reason to trust its sealed ops. Bearer-gated, so it lands
			// even though the Console is not admitted yet. A THROW here (e.g. the Keystore-backed
			// store is unavailable, so the member identity cannot be persisted) is the REAL cause;
			// surface it instead of falling through to register()'s generic "not enrolled".
			runCatching { submitConsoleAdmission() }.onFailure { e ->
				val (cause, kind) = classifyConnError(e)
				_state.update {
					it.copy(
						status = if (kind == ConnKind.TERMINAL) "error" else "connecting",
						error = cause,
						connected = false,
						enrollingSince = 0L,
					)
				}
				return@withContext
			}
			// MailboxSync owns the durable cursor, so register's cursor/epoch are not adopted. We
			// still register to learn gatewayId, claim the mailbox, and get the epoch the box is on;
			// the poll loop's advance() reconciles any epoch change.
			val reg = client().register()
			DebugLog.log("Connect", "register ok gateway=${reg.gatewayId}")
			val id = reg.gatewayId
			if (id.isNotEmpty() && id != localGatewayId) {
				localGatewayId = id
				store.saveGatewayId(id)
			}
			// Pin every subsequent relay to this route Gateway so the Gateway routes there
			// even once other Gateways join the mesh.
			client().routeGateway = localGatewayId.ifEmpty { null }
			// A teams refresh failure is not a connect failure: register succeeded, so we
			// are connected. Log and proceed with the prior team list rather than masking
			// the error as an empty board (which would blank live sessions).
			val teams = runCatching { client().teams(localGatewayId) }.getOrElse {
				DebugLog.log("Connect", "teams refresh failed: ${it.message?.take(120)}")
				_state.value.teams
			}
			_state.update {
				it.copy(
					teams = teams,
					status = "connected",
					error = null,
					connected = true,
					pollFailStreak = 0,
					localGatewayId = localGatewayId,
					enrollingSince = 0L,
				)
			}
			refreshDisplayNameFromTeams()
			DebugLog.log("Connect", "connected gateway=${localGatewayId.ifEmpty { "?" }}")
		} catch (e: Exception) {
			val (cause, kind) = classifyConnError(e)
			// "is not admitted" means the Gateway holds no admission for this Console. If we believed
			// we were admitted, the flag is stale (the submit never landed in evie) - clear it so the
			// next connect re-submits the admission instead of waiting forever on a calm sync-lag.
			if (kind == ConnKind.ENROLLING) store.consoleAdmitted = false
			_state.update { s ->
				when (kind) {
					// Post-enroll sync lag: calm "Finishing up enrollment..." (the poll loop
					// keeps retrying + clears it on the first success), escalating past the grace.
					ConnKind.ENROLLING -> {
						val (override, since) = enrollFold(s.enrollingSince)
						s.copy(
							status = if (override != null) "error" else "connecting",
							error = override ?: cause,
							connected = false,
							enrollingSince = since,
						)
					}
					ConnKind.TERMINAL -> s.copy(status = "error", error = cause, connected = false, enrollingSince = 0L)
					ConnKind.TRANSIENT -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
				}
			}
		} finally {
			// DEBUG: stream whatever this attempt logged, even on the failure paths that return before
			// the poll loop's own flush would run. No-op in release (flushToIngest is BuildConfig.DEBUG).
			DebugLog.flushToIngest()
		}
	}

	/** First-root a pending friend Domain if the imported blob carries one (and it is not yet
	 * rooted). Builds a FirstRoot over this device's silent owner key + the invite nonce, self-signs
	 * it (FederationManager), and POSTs it to evie's console-bridge firstRoot intake. Returns true to
	 * let connect() proceed (nothing pending, already rooted, or a fresh root just succeeded), false
	 * to abort connect after surfacing a terminal reject (an expired / already-claimed invite, which
	 * does not self-heal). Idempotent: the firstRooted latch skips the round-trip on later connects. */
	private fun firstRootIfPending(): Boolean {
		val prov = runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull() ?: return true
		return when (val decision = FriendOnboarding.decide(prov, store.firstRooted)) {
			is FirstRootDecision.NotPending -> true
			is FirstRootDecision.Root -> {
				DebugLog.log("FirstRoot", "pending domain=${decision.domainId}; rooting at silent owner key")
				val signed = federation.signFirstRoot(decision.domainId, decision.nonce, System.currentTimeMillis())
				val result = runCatching { client().firstRoot(signed) }.getOrElse {
					// A transport failure here is NOT terminal: the root was not decided, only
					// unreachable. Surface a transient cause and let the poll loop retry.
					val (cause, _) = classifyConnError(it)
					_state.update { s -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L) }
					return false
				}
				if (result.ok) {
					store.firstRooted = true
					DebugLog.log("FirstRoot", "rooted ok domain=${decision.domainId}")
					true
				} else {
					// A transient evie reject (clock skew, CAS persist contention) leaves the latch
					// false and the poll loop re-attempts, so it surfaces as "connecting" (auto-retry),
					// not a terminal "error" that the user reads as a dead end.
					val reject = FriendOnboarding.classifyFirstRootError(result.error)
					DebugLog.log("FirstRoot", "rejected (transient=${reject.transient}): ${result.error?.take(120)}")
					_state.update {
						it.copy(
							status = if (reject.transient) "connecting" else "error",
							error = reject.message,
							connected = false,
							enrollingSince = 0L,
						)
					}
					false
				}
			}
		}
	}

	/** The owner key fingerprint the admin confirms when rooting the Domain on the
	 * host. Reading it mints the owner + console identities on first call. */
	fun ownerSas(): String = federation.ownerSas()

	fun ownerSignPub(): String = federation.ownerSignPub()

	fun ownerBoxPub(): String = federation.ownerBoxPub()

	/** Owner public material for the settings cards, or null when the stored owner key is
	 * corrupt. Non-throwing so a corrupt key renders a restore prompt rather than crashing the
	 * card; an absent key still mints (the silent first-gen). */
	fun ownerKeysForDisplay(): OwnerKeysView? = federation.ownerKeysForDisplay()

	/** This owner's display name, falling back to the local Domain id
	 * before discovery has stamped a name. Shown as "YOU" on the Users surface. */
	fun displayName(): String = state.value.displayName.ifEmpty { confirmedDomainId().orEmpty() }

	/** A passphrase-encrypted backup of the owner root key for offline safekeeping. */
	// Runs the scrypt KDF, so it stays off the main thread (the UI dispatches it from a
	// coroutine) - the same posture as importOwnerBackup.
	suspend fun exportOwnerBackup(passphrase: String): String =
		withContext(Dispatchers.IO) { federation.exportOwnerBackup(passphrase) }

	/** Restore the owner root key from a backup blob. The result lets the UI distinguish a
	 * wrong passphrase from a different-owner rejection. */
	suspend fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult =
		withContext(Dispatchers.IO) { federation.importOwnerBackup(blob, passphrase) }

	/** Submit an owner-signed fact to evie and fold it into the local keyring ONLY if evie
	 * accepted it, surfacing the error otherwise. The merge-iff-accepted invariant lives in
	 * this one place so an owner action cannot submit without the matching local merge (the
	 * class of bug that once left a revoked member on the board). Secondary effects (the
	 * route-gateway pin, the console-admitted gate) stay at the call site after a true return. */
	private fun <T> submitOwnerFact(
		signed: T,
		submit: (T) -> EnrollResult,
		merge: (T) -> Unit,
		failLabel: String,
	): Boolean {
		val result = runCatching { submit(signed) }.getOrElse {
			DebugLog.log("Enroll", "$failLabel: submit threw ${it.javaClass.simpleName}: ${it.message?.take(140)}")
			EnrollResult(ok = false, error = it.message)
		}
		if (!result.ok) {
			DebugLog.log("Enroll", "$failLabel: evie rejected: ${result.error?.take(140) ?: "unknown"}")
			_state.update { it.copy(error = "$failLabel: ${result.error?.take(120) ?: "unknown"}") }
			return false
		}
		merge(signed)
		return true
	}

	/** Submit this Console's own owner-signed admission to evie so a Gateway trusts its
	 * sealed ops. The enroll op is bearer-gated (not sealed), so it lands before the
	 * Console is admitted; gated by a flag so connect does not re-issue it every cycle.
	 * The gateway may still be syncing the admission - the ENROLLING grace covers that. */
	private fun submitConsoleAdmission() {
		if (store.consoleAdmitted) {
			// Distinguishes "the app believes it is already admitted and never POSTs" (which would
			// explain zero enroll ops reaching evie) from "it POSTs and the submit fails".
			DebugLog.log("Enroll", "submit skipped: consoleAdmitted flag already set")
			return
		}
		DebugLog.log("Enroll", "submitting console admission to evie")
		val signed = federation.consoleAdmission(System.currentTimeMillis())
		// submitOwnerFact surfaces the real cause (e.g. evie rooted at a different owner key)
		// so it does not hide behind the generic "finishing enrollment" the register hits next.
		if (submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitAdmission(it)) }, federation::mergeAdmission, "Console admission rejected")) {
			store.consoleAdmitted = true
		} else {
			DebugLog.log("Federation", "console admission submit failed")
			// Throw so connect() surfaces this SPECIFIC cause and stops; otherwise register() runs
			// next and overwrites it with the generic sync-lag "finishing enrollment", masking it.
			error(_state.value.error ?: "Console admission rejected by the server")
		}
	}

	/** Owner-admit a scanned Gateway: owner-sign its admission, submit it to evie, and
	 * fold it into the local keyring so the Console can seal to it immediately (before
	 * evie's snapshot syncs back). Returns the signed admission for the caller to seal
	 * into the bootstrap bundle, or null on failure. */
	suspend fun admitGateway(gatewayId: String, signPub: String, boxPub: String): SignedAdmission? =
		withContext(Dispatchers.IO) {
			val signed = federation.admitGateway(gatewayId, signPub, boxPub, System.currentTimeMillis())
			if (!submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitAdmission(it)) }, federation::mergeAdmission, "Admit failed")) {
				return@withContext null
			}
			// The first admitted Gateway becomes the route Gateway the Console seals to.
			if (store.loadGatewayId().isEmpty()) {
				store.saveGatewayId(gatewayId)
				localGatewayId = gatewayId
			}
			signed
		}

	/** Owner-revoke a member by its signing key: sign a revocation, submit it to evie,
	 * and drop the member from the local keyring. */
	suspend fun revokeMember(signPub: String) = withContext(Dispatchers.IO) {
		val signed = federation.revoke(signPub, System.currentTimeMillis())
		// The local merge folds the revocation into the keyring on success, so the member
		// drops off the board now instead of waiting for evie to rebroadcast it.
		submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitRevocation(it)) }, federation::mergeRevocation, "Revoke failed")
	}

	/** Owner-sign a cross-Domain link edge (this Domain -> a linked friend Domain) and submit
	 * it to evie so its relay-affinity gate permits the cross-Domain crosstalk. Called on a
	 * link-handshake confirm. Returns true iff evie accepted it. There is no local keyring
	 * merge: the edge lives only in evie's edge set (the cross-Domain peer + its keys are
	 * written by the handshake confirm, not by this edge). */
	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String? = null): Boolean =
		withContext(Dispatchers.IO) {
			val signed = federation.signXdomainLinkEdge(srcDomainId, dstDomainId, System.currentTimeMillis(), edgeNonce)
			submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitXdomainLink(it)) }, {}, "Link failed")
		}

	/** Owner-sign a cross-Domain link-edge revocation and submit it to evie so its
	 * relay-affinity gate refuses the cross-Domain crosstalk again. Called on unlink. Returns
	 * true iff evie accepted it. No local keyring merge, for the same reason as the edge. */
	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean = withContext(Dispatchers.IO) {
		val signed = federation.signXdomainLinkRevocation(srcDomainId, dstDomainId, System.currentTimeMillis())
		submitOwnerFact(signed, { client().enroll(EnrollOp.RevokeXdomainLink(it)) }, {}, "Unlink failed")
	}

	/** The admitted members of the keyring, for the management board. */
	fun admittedMembers(): List<MemberInfo> = federation.members()

	////////////////////////////////
	//  Add a device (USER self-enroll: the owner authorizes their OWN fresh device, no admin)

	/** evie's public device-approval reach for the authorize-console QR, or null when this network has
	 * no public ingress (the Add-a-device entry is then shown disabled). */
	fun deviceApprovalReach(): String? =
		runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull()?.deviceApprovalReach?.takeIf { it.isNotEmpty() }

	/** HELD device: arm a one-time approval window and build the authorize-console QR. The QR carries
	 * PUBLIC material only (owner keys + Domain + the reach/token/nonce), never an SA token. Fails when
	 * the network has no public ingress or its Domain is not yet confirmed by a local session. */
	suspend fun armDeviceApproval(): Result<DeviceApprovalArmed> = withContext(Dispatchers.IO) {
		runCatching {
			val reach = deviceApprovalReach() ?: error("This network has no device-approval reach configured.")
			val domainId = confirmedDomainId() ?: error("Your Domain isn't confirmed yet - open a session first.")
			val approvalId = federation.freshApprovalToken()
			val nonce = federation.freshApprovalToken()
			val result = client().postConsoleApproval(ConsoleApprovalOp.Arm(approvalId = approvalId, nonce = nonce))
			if (!result.ok) error(result.error ?: "Couldn't arm the approval window.")
			val qr = JSONObject()
				.put("type", "authorize-console")
				.put("domainId", domainId)
				.put("signPub", federation.ownerSignPub())
				.put("boxPub", federation.ownerBoxPub())
				.put("approvalId", approvalId)
				.put("nonce", nonce)
				.put("reach", reach)
				.toString()
			DeviceApprovalArmed(approvalId, nonce, qr)
		}
	}

	/** HELD device: poll the window for the fresh device's join (its generated console keys). Null
	 * until it joins, so the screen keeps polling. */
	suspend fun pollDeviceApproval(approvalId: String): Result<ConsoleApprovalJoin?> = withContext(Dispatchers.IO) {
		runCatching {
			val result = client().postConsoleApproval(ConsoleApprovalOp.Poll(approvalId = approvalId))
			if (!result.ok) error(result.error ?: "approval window closed")
			result.join
		}
	}

	/** HELD device: approve the joined device. Owner-signs a kind:console admission for its keys and
	 * submits it (the existing submit_admission path), then seals the console transport to its box key
	 * and parks it for the device to fetch. The biometric gate is applied at the UI call site. */
	suspend fun approveDevice(approvalId: String, join: ConsoleApprovalJoin): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			val signed = federation.admitConsole(join.newSignPub, join.newBoxPub, System.currentTimeMillis())
			if (!submitOwnerFact(signed, { client().enroll(EnrollOp.SubmitAdmission(it)) }, federation::mergeAdmission, "Approve failed")) {
				error(_state.value.error ?: "The server rejected the new device.")
			}
			val transport = buildConsoleTransport()
			val plain = wireJson.encodeToString(ConsoleTransport.serializer(), transport).toByteArray(Charsets.UTF_8)
			val sealed = federation.sealConsoleTransport(join.newBoxPub, plain)
			val result = client().postConsoleApproval(ConsoleApprovalOp.Approve(approvalId = approvalId, sealed = sealed))
			if (!result.ok) error(result.error ?: "Couldn't deliver the sealed transport.")
			Unit
		}
	}

	/** HELD device: tear down the approval window when the owner leaves the screen (best-effort). */
	suspend fun cancelDeviceApproval(approvalId: String) {
		withContext(Dispatchers.IO) {
			runCatching { client().postConsoleApproval(ConsoleApprovalOp.Cancel(approvalId = approvalId)) }
		}
	}

	/** The console transport the held device seals to a new device: its own provisioning creds plus the
	 * owner's synced keyring + route Gateway, so the new device can seal to the Gateway the owner
	 * already admitted without holding the owner key to re-sync the keyring itself. */
	private fun buildConsoleTransport(): ConsoleTransport {
		val prov = Provisioning.parse(store.load() ?: error("not provisioned"))
		return ConsoleTransport(
			apiUrl = prov.apiUrl,
			caPem = prov.caPem,
			saToken = prov.saToken,
			appToken = prov.appToken,
			namespace = prov.namespace,
			service = prov.service,
			port = prov.port.toLong(),
			domainId = confirmedDomainId(),
			gatewayId = localGatewayId.takeIf { it.isNotEmpty() } ?: store.loadGatewayId().takeIf { it.isNotEmpty() },
			domainVersion = store.loadDomainVersion().ifEmpty { null },
			domain = federation.keyring().snapshot,
		)
	}

	/** Parse a scanned authorize-console QR, or null if it is not one. The owner signPub is pinned to
	 * verify the sealed reply; its fingerprint is shown so the human confirms the network. */
	suspend fun parseAuthorizeConsole(scanned: String): ScannedDeviceApproval? = withContext(Dispatchers.IO) {
		runCatching {
			val j = JSONObject(scanned.trim())
			require(j.optString("type") == "authorize-console")
			ScannedDeviceApproval(
				domainId = j.getString("domainId"),
				ownerSignPub = j.getString("signPub"),
				ownerBoxPub = j.getString("boxPub"),
				approvalId = j.getString("approvalId"),
				nonce = j.getString("nonce"),
				reach = j.getString("reach"),
				// N's OWN console key fingerprint - the SAME value the held device renders (it shows
				// fingerprint(newSignPub)) so the human can cross-check the two screens. An attacker who
				// saw the QR and joined first then shows a different code and is caught. The owner key
				// (signPub) is NOT shown here; it is only the unseal pin.
				sas = Crypto.fingerprint(federation.consoleIdentity().sign.pub),
			)
		}.getOrNull()
	}

	/** NEW device: announce this device's freshly-generated console keys to the held device by POSTing a
	 * join to the public ingress (nonce-gated, no creds). consoleIdentity() mints+persists the keys on
	 * first call, so the keys sent here are the SAME ones this device later unseals with. */
	suspend fun newDeviceJoin(scan: ScannedDeviceApproval): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			val id = federation.consoleIdentity()
			val op = ConsoleApprovalOp.Join(
				approvalId = scan.approvalId,
				nonce = scan.nonce,
				newSignPub = id.sign.pub,
				newBoxPub = id.box.pub,
				device = android.os.Build.MODEL,
			)
			val result = ConsoleClient.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The held device didn't accept this join.")
			Unit
		}
	}

	/** NEW device: poll the public ingress for the held device's sealed reply. Returns true once it
	 * arrives - unseals it (verifying the owner signPub pinned from the QR) and installs the transport;
	 * false while still pending, so the caller keeps polling. */
	suspend fun newDeviceFetch(scan: ScannedDeviceApproval): Result<Boolean> = withContext(Dispatchers.IO) {
		runCatching {
			val op = ConsoleApprovalOp.Fetch(approvalId = scan.approvalId, nonce = scan.nonce)
			val result = ConsoleClient.postPublicApproval(scan.reach, op)
			if (!result.ok) error(result.error ?: "The approval window expired.")
			val sealed = result.sealed ?: return@runCatching false
			val plain = federation.unsealConsoleTransport(sealed, scan.ownerSignPub)
			val transport = wireJson.decodeFromString(ConsoleTransport.serializer(), plain.toString(Charsets.UTF_8))
			installApprovedDevice(transport)
			true
		}
	}

	/** NEW device: install the unsealed transport. Writes the provisioning blob through the EXISTING
	 * provisioning store write, adopts the owner's synced keyring + route Gateway, and marks this device
	 * admitted - the held device already owner-signed + submitted its admission, and this device holds
	 * no owner key, so it must NEVER self-sign. provisioned flips LAST so the poll loop starts only
	 * after consoleAdmitted is set, never racing a self-admission with a throwaway owner key. */
	private fun installApprovedDevice(transport: ConsoleTransport) {
		val prov = com.atelier_nyaarium.switchboard.proto.Provisioning(
			apiUrl = transport.apiUrl,
			caPem = transport.caPem,
			saToken = transport.saToken,
			appToken = transport.appToken,
			namespace = transport.namespace,
			service = transport.service,
			port = transport.port,
		)
		val blob = wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(), prov)
		store.save(blob)
		store.consoleAdmitted = true
		store.firstRooted = true
		store.enrollCeremonyDone = true
		transport.domain?.let { snap ->
			store.saveDomain(
				wireJson.encodeToString(com.atelier_nyaarium.switchboard.proto.DomainSnapshot.serializer(), snap),
				transport.domainVersion ?: "",
			)
		}
		transport.gatewayId?.takeIf { it.isNotEmpty() }?.let {
			store.saveGatewayId(it)
			localGatewayId = it
		}
		client = null
		sttsClient = null
		val parsed = Provisioning.parse(blob)
		_state.update { it.copy(provisioned = true, error = null, deviceName = parsed.device, firstRooted = true) }
	}

	/** Fetch the cross-tenant roster (the Users surface): every member on this evie, by name +
	 * presence. evie-direct + signed-proof scoped; a non-member or auth failure surfaces as a
	 * failure with evie's opaque reason. The rendering surface consumes the rows. */
	suspend fun fetchRoster(): Result<List<com.atelier_nyaarium.switchboard.proto.RosterMember>> =
		withContext(Dispatchers.IO) {
			runCatching {
				val result = client().roster(federation.signRosterRequest(System.currentTimeMillis()))
				if (!result.ok) error(result.error ?: "roster unavailable")
				result.members ?: emptyList()
			}
		}

	////////////////////////////////
	//  Cross-Domain trust (the link/share/unlink surface the Federation UI drives)

	/** This owner's own Domain id, learned from a LOCAL session in the current board (the local
	 * listing stamps domainId = the connected Gateway's Domain). Null until a local session confirms
	 * it: the signing + cross-Domain routing sites refuse to act on a guessed id, so a frame never
	 * names a Domain this device has not actually joined. */
	fun confirmedDomainId(): String? {
		val gw = localGatewayId
		return _state.value.teams.firstOrNull { (it.gatewayId.ifEmpty { gw }) == gw && !it.domainId.isNullOrEmpty() }?.domainId
	}

	/** The confirmed local Domain id, or throw - for the signing/routing ops that run inside a
	 * runCatching so a not-yet-confirmed Domain surfaces as a clean failure instead of a guessed id. */
	private fun confirmedDomainIdOrThrow(): String =
		confirmedDomainId() ?: error("Domain not yet confirmed by a local session")

	/** True only when a LOCAL session confirms this device owns the ADMIN Domain (the one that runs
	 * evie and provisions others), so it can host guest networks. evie stamps isAdminDomain on the
	 * register reply and the gateway carries it onto the local TeamInfo. A guest (its own non-admin
	 * Domain) returns false, and so does a device whose Domain is not yet confirmed - so the
	 * Guest-networks admin section is hidden rather than shown as a dead button evie would reject
	 * (provision_tenant is gated on the admin key, so "not admin-signed" for anyone else). */
	fun isAdmin(): Boolean {
		val gw = localGatewayId
		return _state.value.teams.any { (it.gatewayId.ifEmpty { gw }) == gw && it.isAdminDomain }
	}

	/** Whether to show "Revoke and Delete Domain": a CONFIRMED app-only user only. Never an admin (they
	 * purge via setup.sh), and never while the Domain is unconfirmed. Both flags read the SAME local
	 * session, so an unconfirmed id (offline, no teams) hides the action rather than letting an admin
	 * whose gateway is down read the unknown state as "not admin" and delete their whole Domain. */
	fun canDeleteOwnDomain(): Boolean = !isAdmin() && confirmedDomainId() != null

	////////////////////////////////
	//  Display name (this owner's display name)

	/** This owner's current display name, for the profile field + the MY NETWORK card. The
	 * cache (refreshed from discovery) is authoritative for display; empty until the owner sets one. */
	fun localDisplayName(): String = _state.value.displayName

	/** Refresh the cached display name from discovery's LOCAL session (the gateway stamps each
	 * session's displayName; the local Gateway's is this owner's own). A no-op when no local session
	 * carries one yet, so a board with only peer sessions never blanks the cached name. */
	private fun refreshDisplayNameFromTeams() {
		val gw = localGatewayId
		val local = _state.value.teams.firstOrNull {
			(it.gatewayId.ifEmpty { gw }) == gw && !it.displayName.isNullOrEmpty()
		}?.displayName ?: return
		if (local != store.displayName) store.displayName = local
		if (local != _state.value.displayName) _state.update { it.copy(displayName = local) }
	}

	/** Rename this owner's own display name: owner-sign a SET_ADMIN_NAME op over the admin Domain and
	 * submit it evie-direct. On success cache the new name + reflect it immediately (evie pushes a
	 * domain_update to this owner's gateways, so discovery will confirm it on the next refresh). */
	suspend fun setDisplayName(name: String): Result<Unit> = withContext(Dispatchers.IO) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		val adminDomain = confirmedDomainId()
			?: return@withContext Result.failure(IllegalStateException("Domain not yet confirmed by a local session"))
		runCatching {
			val signed = federation.signSetDisplayName(adminDomain, trimmed, System.currentTimeMillis())
			val result = client().enroll(EnrollOp.SetDisplayName(signed))
			if (!result.ok) error(result.error ?: "rename rejected")
			store.displayName = trimmed
			_state.update { it.copy(displayName = trimmed) }
		}
	}

	/** Revoke and delete this owner's OWN Domain (the app-only path; admins purge via setup.sh).
	 * Owner-sign the deletion FIRST, while the key still exists, then POST it evie-direct and await the
	 * result under a 30s ceiling. A confirmed purge AND an unconfirmed timeout/unreachable both wipe
	 * local state so the device is never left half-deleted; only an explicit evie rejection keeps state
	 * so the owner key survives a retry. The biometric gate (a destructive owner-key action) is at the
	 * call site, mirroring revoke/admit. */
	suspend fun deleteDomain(): DeleteDomainOutcome = withContext(Dispatchers.IO) {
		val domainId = confirmedDomainId()
			?: runCatching { store.load()?.let { Provisioning.parse(it).pendingTenant?.domainId } }.getOrNull()
		// No resolvable Domain id means nothing was ever rooted server-side; just wipe locally.
		if (domainId.isNullOrEmpty()) {
			clearAll()
			return@withContext DeleteDomainOutcome.WipedUnconfirmed
		}
		val signed = federation.signDeleteDomain(domainId, System.currentTimeMillis())
		// enroll() returns an EnrollResult when evie is reached (ok or reject) and THROWS when the
		// console bridge is unreachable. Race it against a 30s ceiling so a hung POST never strands the
		// user mid-delete: a null (timeout) and a failure (transport) both fall to the unconfirmed wipe.
		// enroll() blocks on an OkHttp call (its own read timeout is the real ceiling) and THROWS when the
		// console bridge is unreachable. A reached-but-refused result keeps the owner key for a retry; a
		// throw (offline) falls to the unconfirmed wipe so a hung POST never strands the user mid-delete.
		val attempt = runCatching { client().enroll(EnrollOp.DeleteDomain(signed)) }
		val result = attempt.getOrNull()
		when {
			result?.ok == true -> {
				clearAll()
				DeleteDomainOutcome.Deleted
			}
			attempt.isSuccess -> DeleteDomainOutcome.Rejected(result?.error ?: "delete rejected")
			else -> {
				clearAll()
				DeleteDomainOutcome.WipedUnconfirmed
			}
		}
	}

	////////////////////////////////
	//  Networks you host (guest tenants the admin pre-stages)

	/** The guest tenants this owner has staged, each with its discovery-derived state
	 * (awaiting-setup -> offline -> online). The locally-persisted rows supply the label + the
	 * invite nonce (so a row can re-render its QR before the friend's gateway ever appears);
	 * discovery upgrades the state once the friend roots + brings a gateway online. */
	fun hostedTenants(): List<HostedTenant> {
		val stored = loadHostedTenants()
		val teams = _state.value.teams
		return stored.map { it.copy(state = FriendOnboarding.hostedState(it.domainId, teams)) }
	}

	/** Stage a new guest tenant: mint an opaque domainId, owner-sign a provision_tenant op, submit
	 * it evie-direct, and persist the row with the one-time invite nonce evie returns (the QR is
	 * built from it). Returns the new row, or a failure carrying evie's reason. */
	suspend fun provisionTenant(displayName: String): Result<HostedTenant> = withContext(Dispatchers.IO) {
		val label = displayName.trim()
		if (label.isEmpty()) return@withContext Result.failure(IllegalArgumentException("Name cannot be empty"))
		runCatching {
			val domainId = federation.newDomainId()
			val signed = federation.signProvisionTenant(domainId, label, System.currentTimeMillis())
			val result = client().provisionTenant(signed)
			val nonce = if (result.ok) result.nonce else null
			if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
			val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
			upsertHostedTenant(row)
			row
		}
	}

	/** Regenerate a pending tenant's one-time invite: re-submit provision_tenant for the SAME
	 * domainId, which mints a fresh nonce at evie (invalidating the prior one) without a remove +
	 * re-add. Returns the refreshed row. */
	suspend fun regenerateInvite(domainId: String, displayName: String): Result<HostedTenant> =
		withContext(Dispatchers.IO) {
			val label = displayName.trim().ifEmpty { return@withContext Result.failure(IllegalArgumentException("Name cannot be empty")) }
			runCatching {
				val signed = federation.signProvisionTenant(domainId, label, System.currentTimeMillis())
				val result = client().provisionTenant(signed)
				val nonce = if (result.ok) result.nonce else null
				if (nonce.isNullOrEmpty()) error(result.error ?: "no invite nonce returned")
				// A regenerated invite is a fresh ceremony: drop the prior handshake secrets so the next
				// buildInviteBlob mints new ones (the old QR's broker window is abandoned with its nonce).
				enrollInvites.remove(domainId)
				val row = HostedTenant(domainId, label, nonce, HostedTenantState.AWAITING_SETUP)
				upsertHostedTenant(row)
				row
			}
		}

	/** Build the invite blob a hosted tenant's QR encodes: the CONSOLE-bridge transport creds the
	 * admin was itself provisioned with (this owner's own blob) plus the pending tenant's
	 * {domainId, nonce}. The friend reaches the SAME shared evie console-bridge as the admin and
	 * first-roots over the console-bridge /relay path; the admin's own console-bridge SA +
	 * CONSOLE_BRIDGE_TOKEN is what authorizes the friend's first_root there. The route Gateway's
	 * bootstrap-transport would instead hand over the gateway-bridge SA + BRIDGE_TOKEN, which the
	 * console-bridge service-proxy RBAC-403s and evie token-401s. The blob omits service/port so the
	 * friend defaults to evie-console-bridge:20004. The JSON is what the paste / file-import path
	 * also accepts. */
	suspend fun buildInviteBlob(tenant: HostedTenant): Result<String> = withContext(Dispatchers.IO) {
		runCatching {
			val blob = store.load() ?: error("This device is not provisioned. Re-import your setup blob first.")
			val prov = Provisioning.parse(blob)
			// Mint (once per tenant) the enroll-handshake secrets that seed the in-person compare and
			// embed them in the QR alongside this admin's owner keys + Domain. The pin rides the QR OUT
			// OF BAND (never sent to evie); the handshakeId keys the broker window the admin's leg polls.
			val invite = enrollInvites.computeIfAbsent(tenant.domainId) {
				EnrollInvite(handshakeId = federation.freshHandshakeId(), pin = federation.freshEnrollPin())
			}
			val adminDomain = confirmedDomainId() ?: error("Domain not yet confirmed by a local session")
			val enrollHandshake = JSONObject()
				.put("adminOwnerSignPub", federation.ownerSignPub())
				.put("adminOwnerBoxPub", federation.ownerBoxPub())
				.put("adminDomainId", adminDomain)
				.put("handshakeId", invite.handshakeId)
				.put("pin", invite.pin)
			val obj = JSONObject()
				.put("apiUrl", prov.apiUrl)
				.put("saToken", prov.saToken)
				.put("caPem", prov.caPem)
				.put("appToken", prov.appToken)
				.put("pendingTenant", JSONObject().put("domainId", tenant.domainId).put("nonce", tenant.nonce))
				.put("enrollHandshake", enrollHandshake)
			obj.toString()
		}
	}

	/** Drop a hosted tenant: owner-sign a remove_tenant op, submit it evie-direct, and forget the
	 * local row. evie deletes the Domain slice (and evicts a live guest gateway). */
	suspend fun removeHostedTenant(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			val signed = federation.signRemoveTenant(domainId, System.currentTimeMillis())
			val result = client().enroll(EnrollOp.RemoveTenant(signed))
			if (!result.ok) error(result.error ?: "remove rejected")
			deleteHostedTenant(domainId)
		}
	}

	private fun upsertHostedTenant(row: HostedTenant) {
		val rows = loadHostedTenants().filterNot { it.domainId == row.domainId } + row
		persistHostedTenants(rows)
	}

	private fun deleteHostedTenant(domainId: String) {
		persistHostedTenants(loadHostedTenants().filterNot { it.domainId == domainId })
	}

	private fun loadHostedTenants(): List<HostedTenant> {
		val json = store.loadHostedTenants() ?: return emptyList()
		// Parse skip-and-keep per row: a single malformed entry (a write tear, a manual edit) must not
		// collapse the whole list to empty, because the next upsert/delete would then persist that loss
		// and permanently discard every other staged tenant. One bad row is dropped; the rest survive.
		val arr = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
		return (0 until arr.length()).mapNotNull { i ->
			runCatching {
				val o = arr.getJSONObject(i)
				HostedTenant(
					domainId = o.getString("domainId"),
					displayName = o.getString("displayName"),
					nonce = o.getString("nonce"),
					state = HostedTenantState.AWAITING_SETUP,
				)
			}.getOrNull()
		}
	}

	private fun persistHostedTenants(rows: List<HostedTenant>) {
		val arr = JSONArray()
		for (r in rows) {
			arr.put(JSONObject().put("domainId", r.domainId).put("displayName", r.displayName).put("nonce", r.nonce))
		}
		runCatching { store.saveHostedTenants(arr.toString()) }
	}

	/** The linked friend Domains. The trust roster comes from the route Gateway's cross-Domain peer
	 * set (fetched by refreshLinkedPeers): a peer is listed the moment it is linked, regardless of
	 * whether its gateway is online or has shared anything back. That set is unioned with the
	 * discovery-derived Domains so a just-linked peer is immediately visible (and its detail reachable
	 * to start sharing) before any of its sessions surface in discovery. Discovery still supplies the
	 * session count + presence; a peer present only in the peer set shows zero sessions / offline. */
	fun linkedDomains(): List<LinkedDomain> {
		val adminDomain = confirmedDomainId() ?: return emptyList()
		return CrossDomainLink.mergeLinkedDomains(_state.value.teams, _state.value.linkedPeerOwners, adminDomain)
	}

	/** Refresh the linked-peer roster from the route Gateway's cross-Domain peer set into state, so
	 * linkedDomains() can union it with discovery. Best-effort: a relay failure keeps the prior set
	 * (the Federation screen never blanks its PEERS list on a blip). Folds the per-gateway peer rows
	 * to their distinct Domain ids (a Domain may run more than one gateway). */
	suspend fun refreshLinkedPeers() = withContext(Dispatchers.IO) {
		runCatching { client().crossDomainListPeers() }
			.onSuccess { result ->
				// domainId -> friend owner key (a Domain may run several gateways under one owner; last wins).
				val owners = result.peers.filter { it.domainId.isNotEmpty() }.associate { it.domainId to it.ownerSignPub }
				_state.update { it.copy(linkedPeerOwners = owners) }
			}
	}

	/** A friend Domain's sessions visible to me (shared to my Domain): the peer's discovery
	 * entries tagged with its domainId. Each is a candidate "their session my agents can reach". */
	fun peerSessions(domainId: String): List<Team> {
		val s = _state.value
		return s.teams.filter { it.domainId == domainId }.sortedBy { s.label(it.name, s.localGatewayId) }
	}

	/** My LOCAL devcontainer/loose sessions, the only kinds shareable to a friend Domain (never the
	 * host-agent, the cli host, or a console). Drives the per-session share checkmarks. */
	fun shareableSessions(): List<Team> {
		val adminDomain = confirmedDomainId() ?: return emptyList()
		val gw = localGatewayId
		val s = _state.value
		return s.teams
			.filter { (it.domainId.isNullOrEmpty() || it.domainId == adminDomain) && (it.gatewayId.isEmpty() || it.gatewayId == gw) }
			.filter { it.kind == "devcontainer" || it.kind == "loose" }
			.sortedBy { s.label(it.name, gw) }
	}

	/** RECEIVER: open a listening window, returning the token to read to the friend + this
	 * Gateway's keys + the expiry. */
	suspend fun crossDomainListen(): Result<com.atelier_nyaarium.switchboard.proto.CrossDomainListenResult> =
		withContext(Dispatchers.IO) { runCatching { client().crossDomainListen() } }

	/** REQUESTER: mint a one-time rendezvous pin, pair against the friend's token, and run the
	 * commit-reveal exchange. Returns the SAS + both sides' keys (and the pin, so confirm can pass
	 * it back). The Gateway uses this owner's admitted owner key, not the advisory value sent. */
	suspend fun crossDomainRequest(listeningToken: String): Result<CrossDomainPairing> =
		withContext(Dispatchers.IO) {
			runCatching {
				val pin = newRendezvousPin()
				val adminDomain = confirmedDomainId() ?: error("Domain not yet confirmed by a local session")
				val result = client().crossDomainRequest(
					listeningToken = listeningToken.trim(),
					pin = pin,
					requesterOwnerSignPub = federation.ownerSignPub(),
					requesterDomainId = adminDomain,
					requesterGatewayId = localGatewayId,
				)
				CrossDomainPairing(pin = pin, result = result)
			}
		}

	/** RECEIVER: poll the listening window's pairing state. Returns null until a requester pairs;
	 * once the exchange lands, returns the SAS + the friend (requester) keys the receiver
	 * owner-signs its own link over, plus the pin to pass to confirm. The receiver polls this on a
	 * short interval while on the link screen (its only path out of "awaiting request"). */
	suspend fun crossDomainListenState(listeningToken: String): Result<CrossDomainReceiverPairing?> =
		withContext(Dispatchers.IO) {
			runCatching {
				val state = client().crossDomainListenState(listeningToken)
				if (!state.pairingArrived) {
					return@runCatching null
				}
				// pairingArrived implies the SAS + all friend keys + the pin are present (the gateway
				// only sets pairingArrived once round 2 records them); guard so a partial reply fails
				// loudly rather than signing a link over blanks.
				CrossDomainReceiverPairing(
					sas = state.sas ?: error("pairing arrived without a SAS"),
					friendOwnerSignPub = state.friendOwnerSignPub ?: error("pairing arrived without the friend owner key"),
					friendDomainId = state.friendDomainId ?: error("pairing arrived without the friend Domain id"),
					friendGatewayId = state.friendGatewayId ?: error("pairing arrived without the friend Gateway id"),
					friendGatewaySignPub = state.friendGatewaySignPub ?: error("pairing arrived without the friend sign key"),
					friendGatewayBoxPub = state.friendGatewayBoxPub ?: error("pairing arrived without the friend box key"),
				).also { receiverPin[listeningToken] = state.pin ?: error("pairing arrived without the pin") }
			}
		}

	/** REQUESTER confirm: owner-sign this owner's link over the RECEIVER's keys (from the request
	 * pairing the SAS just verified) and submit it. Only this owner's side is sent; the receiver
	 * confirms its own side independently. `linkNonce` is pinned by the wizard so a retry reuses
	 * the same signed link. */
	suspend fun crossDomainConfirmRequester(pairing: CrossDomainPairing, linkNonce: String): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			val r = pairing.result
			confirmWithMyLink(
				pin = pairing.pin,
				peerOwnerSignPub = r.receiverOwnerSignPub,
				peerDomainId = r.receiverDomainId,
				peerGatewayId = r.receiverGatewayId,
				peerSignPub = r.receiverGatewaySignPub,
				peerBoxPub = r.receiverGatewayBoxPub,
				linkNonce = linkNonce,
			)
		}

	/** RECEIVER confirm: owner-sign this owner's link over the FRIEND (requester) keys learned from
	 * the listen-state poll and submit it. Uses the pin the poll surfaced (the requester minted it;
	 * the gateway resolves this window's pairing by it). Only this owner's side is sent. */
	suspend fun crossDomainConfirmReceiver(
		listeningToken: String,
		friend: CrossDomainReceiverPairing,
		linkNonce: String,
	): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		val pin = receiverPin[listeningToken] ?: return@withContext Result.failure(
			IllegalStateException("no pairing pin for this listening window; poll the link state first"),
		)
		confirmWithMyLink(
			pin = pin,
			peerOwnerSignPub = friend.friendOwnerSignPub,
			peerDomainId = friend.friendDomainId,
			peerGatewayId = friend.friendGatewayId,
			peerSignPub = friend.friendGatewaySignPub,
			peerBoxPub = friend.friendGatewayBoxPub,
			linkNonce = linkNonce,
		)
	}

	/** Shared confirm core: owner-sign this owner's link over the friend Gateway's keys, submit it
	 * (the gateway verifies it under this owner's key + writes the cross-Domain peer), then
	 * owner-sign + submit the relay-affinity edge so the Router permits the crosstalk. The local peer
	 * write must succeed (it THROWS otherwise -> Result.failure -> the wizard restarts). The edge
	 * submit RETURNS false (not throws) on a Router rejection: the peer is then linked locally but
	 * cross-Domain sends to it would be DENIED, so the outcome distinguishes the two (RelayEdgeRejected
	 * carries the peer Domain for an edge-only retry) instead of silently reporting a full link. */
	private suspend fun confirmWithMyLink(
		pin: String,
		peerOwnerSignPub: String,
		peerDomainId: String,
		peerGatewayId: String,
		peerSignPub: String,
		peerBoxPub: String,
		linkNonce: String,
	): Result<ConfirmOutcome> = runCatching {
		val mySignedLink = federation.signMyLink(
			peerOwnerSignPub = peerOwnerSignPub,
			peerDomainId = peerDomainId,
			peerGatewayId = peerGatewayId,
			peerSignPub = peerSignPub,
			peerBoxPub = peerBoxPub,
			nowMs = System.currentTimeMillis(),
			nonce = linkNonce,
		)
		// Record the OWNER-keyed friend edge (the Users-surface trust) - the SAS confirmed this owner key.
		federation.addTrustedOwner(peerOwnerSignPub)
		client().crossDomainConfirm(pin, mySignedLink)
		// The local peer is now written. The relay-affinity edge is a separate Router submit that
		// returns false on rejection; surface that as RelayEdgeRejected (recoverable by retrying the
		// edge alone) rather than letting the wizard show a false "Linked".
		if (submitXdomainLink(confirmedDomainIdOrThrow(), peerDomainId)) {
			ConfirmOutcome.Linked
		} else {
			ConfirmOutcome.RelayEdgeRejected(peerDomainId)
		}
	}

	/** Re-submit ONLY the relay-affinity edge for an already-linked peer (the local peer write
	 * happened at confirm; only the Router edge failed). Idempotent at evie (it dedups by nonce), so
	 * this needs no unlink+relink. Returns the same outcome shape so the wizard can loop on a repeat
	 * failure or advance to Done. */
	suspend fun retryXdomainLinkEdge(peerDomainId: String): Result<ConfirmOutcome> = withContext(Dispatchers.IO) {
		runCatching {
			if (submitXdomainLink(confirmedDomainIdOrThrow(), peerDomainId)) {
				ConfirmOutcome.Linked
			} else {
				ConfirmOutcome.RelayEdgeRejected(peerDomainId)
			}
		}
	}

	/** A fresh owner-link nonce, pinned by the wizard for one pairing so a confirm retry reuses
	 * the same signed link bytes. */
	fun freshLinkNonce(): String = federation.freshLinkNonce()

	/** Cancel the pairing windows when the owner leaves the link screen (no passive surface). */
	suspend fun crossDomainCancel(listeningToken: String?, pin: String?) = withContext(Dispatchers.IO) {
		runCatching { client().crossDomainCancel(listeningToken, pin) }
	}

	////////////////////////////////
	//  FLOW-1 enroll ceremony (the in-person admin <-> new-user trust compare, brokered by evie)

	/** The ADMIN leg context for a staged tenant's in-person compare: the handshakeId + pin the
	 * invite embedded (minted on buildInviteBlob) plus this owner's party. Null until the admin has
	 * generated the invite (so the QR and the ceremony share one handshake window). */
	fun adminEnrollContext(domainId: String): EnrollCeremonyContext? {
		val invite = enrollInvites[domainId] ?: return null
		val adminDomain = confirmedDomainId() ?: return null
		val myParty = EnrollParty(federation.ownerSignPub(), federation.ownerBoxPub(), adminDomain)
		return EnrollCeremonyContext(EnrollCeremony.ADMIN, invite.handshakeId, invite.pin, myParty, expectedPeer = null)
	}

	/** The ENROLLEE leg context after first-rooting an invited Domain: the handshakeId + pin + admin
	 * party read from the scanned blob, plus this owner's freshly-rooted party. The admin party is
	 * carried as `expectedPeer` so a substituted admin reveal is caught against the in-person QR, not
	 * only at the compare. Null when the blob carries no enroll handshake (an ordinary invite). The
	 * Domain id is taken from the blob's pendingTenant (the EXACT Domain this device just rooted), NOT
	 * confirmedDomainId() - which is null until a local discovery session lands. */
	fun enrolleeEnrollContext(): EnrollCeremonyContext? {
		val prov = runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull() ?: return null
		val hs = prov.enrollHandshake ?: return null
		val myDomainId = prov.pendingTenant?.domainId ?: return null
		val myParty = EnrollParty(federation.ownerSignPub(), federation.ownerBoxPub(), myDomainId)
		val adminParty = EnrollParty(hs.adminOwnerSignPub, hs.adminOwnerBoxPub, hs.adminDomainId)
		return EnrollCeremonyContext(EnrollCeremony.ENROLLEE, hs.handshakeId, hs.pin, myParty, expectedPeer = adminParty)
	}

	/** The enrollee leg to run (or re-offer), or null when the blob carries no enroll handshake or the
	 * in-person compare is already done. Drives the post-first-root auto-launch and the board's
	 * "Verify with the admin" prompt - both go quiet once [markEnrolleeCeremonyDone] latches. */
	fun pendingEnrolleeCeremony(): EnrollCeremonyContext? =
		if (store.enrollCeremonyDone) null else enrolleeEnrollContext()

	/** Latch the enrollee compare as complete so it stops being offered (the trust edge is recorded). */
	fun markEnrolleeCeremonyDone() {
		store.enrollCeremonyDone = true
	}

	/** Run the commit-reveal exchange up to the human compare: commit this side, poll the broker for
	 * the peer's commitment, reveal, poll for the peer's reveal, verify the peer's reveal opens to its
	 * commitment (and, on the enrollee side, matches the QR-pinned admin keys), then compute the SAS
	 * locally. evie is a dumb broker throughout - every check here is on the phone. A terminal failure
	 * (broker reject, tamper, timeout) surfaces as Result.failure; cancellation (leaving the screen)
	 * cancels the suspend. */
	suspend fun enrollExchange(ctx: EnrollCeremonyContext): Result<EnrollExchange> = withContext(Dispatchers.IO) {
		runCatching {
			val salt = federation.freshEnrollSalt()
			val myReveal = com.atelier_nyaarium.switchboard.proto.EnrollReveal(
				ctx.myParty.ownerSignPub,
				ctx.myParty.ownerBoxPub,
				ctx.myParty.domainId,
				salt,
			)
			val commitment = SasCrypto.enrollCommitment(ctx.myParty, ctx.role, salt)
			val peerRole = EnrollCeremony.peerRole(ctx.role)

			// Round 1: commit, then poll (re-POSTing the same commit is idempotent) for the peer's.
			val peerCommitment = pollEnroll("commit") {
				val r = client().enrollHandshake(EnrollHandshakeOp.Commit(ctx.handshakeId, ctx.role, commitment))
				if (!r.ok) error(r.error ?: "enroll commit rejected")
				r.peerCommitment
			}
			// Round 2: reveal, then poll for the peer's reveal.
			val peerReveal = pollEnroll("reveal") {
				val r = client().enrollHandshake(EnrollHandshakeOp.Reveal(ctx.handshakeId, ctx.role, myReveal))
				if (!r.ok) error(r.error ?: "enroll reveal rejected")
				r.peerReveal
			}
			val peerParty = EnrollCeremony.partyOf(peerReveal)
			// Commit-reveal binding: the peer's reveal must open to its round-1 commitment.
			if (!EnrollCeremony.verifyPeer(peerCommitment, peerParty, peerRole, peerReveal.salt)) {
				error("The other phone's keys did not match its commitment (the relay tampered with the exchange). Rescan to restart.")
			}
			// Enrollee side: the admin's revealed keys MUST equal the in-person QR (the OOB
			// admin -> user authentication). A mismatch is an evie substitution of the admin reveal.
			ctx.expectedPeer?.let { expected ->
				if (peerParty != expected) {
					error("The admin keys did not match the scanned code (possible tampering). Rescan to restart.")
				}
			}
			EnrollExchange(
				sas = EnrollCeremony.sas(ctx.role, ctx.myParty, peerParty, ctx.pin),
				peerDomainId = peerReveal.domainId,
				peerParty = peerParty,
			)
		}
	}

	/** On a mutual [Yes]: owner-sign + submit this side's cross-Domain link edge (my Domain -> the
	 * peer's CONFIRMED Domain - the EXACT value the SAS bound, never a re-fetch). Mirrors the link
	 * wizard's edge result: Linked, or RelayEdgeRejected (the trust is recorded but the Router refused
	 * the relay edge, retryable). */
	suspend fun enrollConfirm(
		myDomainId: String,
		peerDomainId: String,
		edgeNonce: String,
		peerOwnerSignPub: String,
	): Result<ConfirmOutcome> =
		withContext(Dispatchers.IO) {
			runCatching {
				// Record the OWNER-keyed friend edge first (the Users-surface trust): the compare confirmed
				// the peer's owner key, so trust the PERSON even if the relay edge below is rejected (a
				// gateway-less friend still becomes a friend; relay enables later).
				federation.addTrustedOwner(peerOwnerSignPub)
				// Pin the edge nonce so a retry / lost-ack re-submit re-signs the SAME edge (evie dedupes
				// by (src, nonce)) instead of accumulating a duplicate per attempt.
				if (submitXdomainLink(myDomainId, peerDomainId, edgeNonce)) {
					ConfirmOutcome.Linked
				} else {
					ConfirmOutcome.RelayEdgeRejected(peerDomainId)
				}
			}
		}

	////////////////////////////////
	//  Owner-keyed trust (the friend graph the Users surface reads)

	/** True iff this owner has trusted the given owner key (the Users-surface Trusted badge). */
	fun isOwnerTrusted(ownerSignPub: String): Boolean = federation.isTrusted(ownerSignPub)

	/** The set of trusted owner keys (the friend graph). */
	fun trustedOwners(): Set<String> = federation.trustedOwners()

	/** Untrust a person by owner key: drop the local friend edge + sign an owner-keyed untrust
	 * tombstone. The relay-affinity edge teardown (per the peer's Domains) is the gateway-side
	 * follow-up; the friend-graph removal is immediate so the Users surface reflects it now. */
	suspend fun untrustOwner(peerOwnerSignPub: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			// Drop the local friend edge first so the Users surface reflects the untrust immediately.
			federation.removeTrustedOwner(peerOwnerSignPub)
			// Capture the person's Domains BEFORE the local cleanup forgets the peers (a person may run
			// several), so we can revoke each Router-side relay edge. Owner-keyed via the peer set.
			val peerDomains = runCatching {
				client().crossDomainListPeers().peers.filter { it.ownerSignPub == peerOwnerSignPub }.map { it.domainId }.toSet()
			}.getOrDefault(emptySet())
			// Tell the gateway to forget every peer + share for this owner across all their Domains
			// (owner-keyed local cleanup). Best-effort: the friend-graph removal already stands even if
			// the gateway is unreachable (a gateway-less owner has no peer state to drop anyway).
			runCatching { client().crossDomainUntrust(peerOwnerSignPub) }
			// Router-side: revoke the owner-signed link edge for each of the person's Domains, so evie
			// drops its relay-affinity edge too (the tombstone's relay half, completing the untrust).
			for (d in peerDomains) runCatching { revokeXdomainLink(confirmedDomainIdOrThrow(), d) }
			Unit
		}
	}

	/** Cancel this leg of the handshake (a [No], a timeout, or leaving the screen) so the broker tears
	 * the window down rather than leaving a half-formed edge. Best-effort. */
	suspend fun enrollCancel(handshakeId: String, role: String) = withContext(Dispatchers.IO) {
		runCatching { client().enrollHandshake(EnrollHandshakeOp.Cancel(handshakeId, role)) }
	}

	////////////////////////////////
	//  FLOW-2 trust rendezvous (roster-initiated user-to-user trust)

	/** The sorted-owner-key role both sides agree on for the SYMMETRIC FLOW-2 SAS: the lower owner key
	 * takes the ADMIN slot, so both phones hash the two parties in the SAME order. Reuses enrollSas /
	 * enrollCommitment - no new SAS scheme (the rendezvousId is the pin). */
	private fun trustRole(myOwner: String, peerOwner: String): String =
		if (myOwner < peerOwner) EnrollCeremony.ADMIN else EnrollCeremony.ENROLLEE

	/** Mint a fresh rendezvous id (the initiator's; also the SAS pin both sides bind). */
	fun mintRendezvousId(): String = federation.freshRendezvousId()

	/** Poll "who armed trust toward me?" (the highlight). Returns the armed initiator rows (owner key
	 * + rendezvousId) so the Users surface highlights them. Best-effort. */
	suspend fun fetchPendingTrust(): Result<List<com.atelier_nyaarium.switchboard.proto.TrustPendingEntry>> =
		withContext(Dispatchers.IO) {
			runCatching {
				val r = client().trustPending(federation.signTrustPendingRequest(System.currentTimeMillis()))
				if (!r.ok) error(r.error ?: "trust pending unavailable")
				r.pending ?: emptyList()
			}
		}

	/** Run one side of the FLOW-2 commit-reveal compare over the rendezvous. `mySide` is INITIATOR (I
	 * armed) or TARGET (I joined a highlighted arm). Mirrors `enrollExchange`: commit (arm/join) ->
	 * poll peerCommit -> reveal -> poll peerReveal -> verify the commit-reveal binding + that the peer
	 * revealed the OWNER the rendezvous named -> compute the SAS. The result's `peerParty`/`peerDomainId`
	 * feed `enrollConfirm` (shared trust-confirm) on a [Yes]. */
	suspend fun trustExchange(
		rendezvousId: String,
		mySide: String,
		peerOwnerSignPub: String,
	): Result<EnrollExchange> =
		withContext(Dispatchers.IO) {
			runCatching {
				val myParty = federation.trustParty(confirmedDomainIdOrThrow())
				val myRole = trustRole(myParty.ownerSignPub, peerOwnerSignPub)
				val peerRole = EnrollCeremony.peerRole(myRole)
				val salt = federation.freshEnrollSalt()
				val myReveal = com.atelier_nyaarium.switchboard.proto.EnrollReveal(
					myParty.ownerSignPub,
					myParty.ownerBoxPub,
					myParty.domainId,
					salt,
				)
				val commitment = SasCrypto.enrollCommitment(myParty, myRole, salt)

				// Round 1: commit (the initiator ARMs, the target JOINs), then poll for the peer's.
				val peerCommitment = pollEnroll("commit") {
					val op = if (mySide == TRUST_SIDE_INITIATOR) {
						TrustHandshakeOp.Arm(rendezvousId, myParty.ownerSignPub, peerOwnerSignPub, commitment)
					} else {
						TrustHandshakeOp.Join(rendezvousId, myParty.ownerSignPub, commitment)
					}
					val r = client().trustHandshake(op)
					if (!r.ok) error(r.error ?: "trust commit rejected")
					r.peerCommitment
				}
				// Round 2: reveal, then poll for the peer's reveal.
				val peerReveal = pollEnroll("reveal") {
					val r = client().trustHandshake(TrustHandshakeOp.Reveal(rendezvousId, mySide, myReveal))
					if (!r.ok) error(r.error ?: "trust reveal rejected")
					r.peerReveal
				}
				val peerParty = EnrollCeremony.partyOf(peerReveal)
				// Commit-reveal binding: the peer's reveal must open to its round-1 commitment.
				if (!EnrollCeremony.verifyPeer(peerCommitment, peerParty, peerRole, peerReveal.salt)) {
					error("The other phone's keys did not match its commitment (the relay tampered with the exchange). Try again.")
				}
				// Anti-substitution: the peer must reveal the OWNER the rendezvous named (the arm /
				// highlight bound peerOwnerSignPub), so evie cannot splice in a different person.
				if (peerParty.ownerSignPub != peerOwnerSignPub) {
					error("The other person's identity did not match the trust request. Try again.")
				}
				EnrollExchange(
					sas = EnrollCeremony.sas(myRole, myParty, peerParty, rendezvousId),
					peerDomainId = peerReveal.domainId,
					peerParty = peerParty,
				)
			}
		}

	/** Cancel this leg of the trust rendezvous (a [No], timeout, or leaving). Best-effort. */
	suspend fun trustCancel(rendezvousId: String) = withContext(Dispatchers.IO) {
		runCatching { client().trustHandshake(TrustHandshakeOp.Cancel(rendezvousId)) }
	}

	/** Poll one handshake step: call [step] (re-POSTing the same frame is idempotent at the broker)
	 * until it returns the peer's frame, with a bounded number of attempts so a vanished peer fails
	 * rather than hangs. [step] throws on a terminal broker reject, which propagates out. */
	private suspend fun <T> pollEnroll(label: String, step: () -> T?): T {
		repeat(ENROLL_POLL_MAX) {
			step()?.let { return it }
			delay(ENROLL_POLL_MS)
		}
		error("Timed out waiting for the other phone ($label). Make sure you are both on this screen, then rescan.")
	}

	/** This owner's current per-session SPECIFIC-Domain shares as (sessionTarget, domainId) pairs, so
	 * the per-peer checkmark UI can render them (everyone-trusted shares are a separate mode). */
	suspend fun crossDomainShares(): Result<Set<Pair<String, String>>> = withContext(Dispatchers.IO) {
		runCatching {
			client().crossDomainListShares().shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						e.sessionTarget to it.domainId
					}
				}
				.toSet()
		}
	}

	/** How many of MY sessions each TRUSTED person can reach, keyed by their owner key (the Users
	 * row's "N shared sessions"). A person reaches a session shared to one of their Domains OR shared
	 * to everyone-trusted. Joins the peer set (owner -> their Domains) with the share list. */
	suspend fun sharedSessionCounts(): Result<Map<String, Int>> = withContext(Dispatchers.IO) {
		runCatching {
			val ownerDomains = client().crossDomainListPeers().peers
				.filter { it.ownerSignPub.isNotEmpty() }
				.groupBy({ it.ownerSignPub }, { it.domainId })
			val shares = client().crossDomainListShares().shares
			val everyoneSessions = shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
			val byDomain = shares
				.mapNotNull { e ->
					(e.target as? com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain)?.let {
						it.domainId to e.sessionTarget
					}
				}
				.groupBy({ it.first }, { it.second })
			ownerDomains.mapValues { (_, domains) ->
				(domains.flatMap { byDomain[it].orEmpty() }.toSet() + everyoneSessions).size
			}
		}
	}

	/** The sessions shared to EVERYONE the owner trusts (the Users-surface share mode). */
	suspend fun sessionsSharedToEveryone(): Result<Set<String>> = withContext(Dispatchers.IO) {
		runCatching {
			client().crossDomainListShares().shares
				.filter { it.target is com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted }
				.map { it.sessionTarget }
				.toSet()
		}
	}

	/** Toggle a local session's share to a specific friend Domain (the checkmark IS the consent). */
	suspend fun setCrossDomainShare(sessionTarget: String, domainId: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatching {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.Domain(domainId)
				if (shared) client().crossDomainShare(sessionTarget, target) else client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	/** Toggle a local session's share to EVERYONE the owner trusts (the live-trust-set audience). */
	suspend fun setShareEveryoneTrusted(sessionTarget: String, shared: Boolean): Result<Unit> =
		withContext(Dispatchers.IO) {
			runCatching {
				val target = com.atelier_nyaarium.switchboard.proto.CrossDomainShareTarget.EveryoneTrusted
				if (shared) client().crossDomainShare(sessionTarget, target) else client().crossDomainUnshare(sessionTarget, target)
				Unit
			}
		}

	/** Unlink a friend Domain: forget the local trust + shares for it, then owner-sign + submit
	 * the link-edge revocation so the Router drops its relay-affinity edge. */
	suspend fun unlinkDomain(domainId: String): Result<Unit> = withContext(Dispatchers.IO) {
		runCatching {
			client().crossDomainUnlink(domainId)
			revokeXdomainLink(confirmedDomainIdOrThrow(), domainId)
			refreshTeams()
			Unit
		}
	}

	private fun newRendezvousPin(): String {
		val bytes = ByteArray(18)
		java.security.SecureRandom().nextBytes(bytes)
		return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
	}

	/** Parse a scanned admit-gateway QR, or null if it is not one. The SAS is the
	 * fingerprint of the Gateway's signing key, confirmed against the Gateway terminal. */
	fun parseAdmitGateway(scanned: String): ScannedGateway? = runCatching {
		val j = org.json.JSONObject(scanned.trim())
		if (j.optString("type") != "admit-gateway") return null
		val signPub = j.getString("signPub")
		val lan = j.optJSONObject("lan")
		ScannedGateway(
			gatewayId = j.getString("gatewayId"),
			signPub = signPub,
			boxPub = j.getString("boxPub"),
			sas = Crypto.fingerprint(signPub),
			lanHost = lan?.optString("host")?.ifEmpty { null },
			lanPort = lan?.optInt("port", 0)?.takeIf { it > 0 },
			nonce = j.optString("nonce").ifEmpty { null },
			certFp = lan?.optString("certFp")?.ifEmpty { null },
		)
	}.getOrNull()

	/** Enroll a scanned Gateway end to end: owner-admit it, then (if it offered LAN delivery)
	 * fetch the bootstrap transport from the route Gateway, seal a bootstrap bundle, and deliver
	 * it over the LAN, falling back to handing the admin the sealed text to paste. A
	 * host-configured Gateway (no LAN, no nonce) just needs the admission, which reaches it
	 * through evie's domain sync. */
	suspend fun enrollGateway(scanned: ScannedGateway): EnrollDelivery = withContext(Dispatchers.IO) {
		val signed = admitGateway(scanned.gatewayId, scanned.signPub, scanned.boxPub)
			// admitGateway sets _state.error to the real cause (e.g. "Admit failed: admission not
			// owner-signed" - this phone's owner key does not match the Domain root). Surface that
			// instead of a generic retry prompt so an owner-key mismatch is visible, not a black box.
			?: return@withContext EnrollDelivery(false, _state.value.error ?: "Couldn't add the Gateway. Try again.", null)
		val nonce = scanned.nonce
			?: return@withContext EnrollDelivery(true, "Added. This Gateway will come online shortly.", null)
		// Pull the gateway-bridge transport (proxy SA token + CA) from evie by proving this owner roots
		// a network. apiUrl + the network id come from the provisioning blob: apiUrl is the SAME external
		// apiserver the console bridge uses, and domainId is the rooted Domain the Gateway adopts.
		val prov = runCatching { store.load()?.let { Provisioning.parse(it) } }.getOrNull()
			?: return@withContext EnrollDelivery(true, "Added, but this device is not provisioned - re-import your setup blob.", null)
		val result = try {
			client().requestGatewayTransport(federation.signTransportRequest(System.currentTimeMillis()))
		} catch (e: Exception) {
			// Surface the REAL transport-fetch cause (reached-but-rejected, an op failure) instead of
			// asserting "couldn't reach" + a re-provision that will not fix an admission/seal mismatch.
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${e.message?.take(120) ?: "unknown error"}",
				null,
			)
		}
		if (!result.ok || result.saToken == null || result.caPem == null) {
			return@withContext EnrollDelivery(
				true,
				"Added, but couldn't finish Gateway setup: ${result.error?.take(120) ?: "transport unavailable"}",
				null,
			)
		}
		// The 4-field GatewayTransport; the Gateway fills namespace/service/port defaults when it
		// installs the bundle, and appToken is omitted (gateway-bridge auth is the SA token + admission).
		val transport = GatewayTransport(apiUrl = prov.apiUrl, saToken = result.saToken, caPem = result.caPem)
		val frame = federation.sealBundle(nonce, transport, signed, scanned.boxPub, prov.pendingTenant?.domainId)
		val frameJson = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), frame)
		if (scanned.lanHost != null && scanned.lanPort != null && scanned.certFp != null && isPrivateLanHost(scanned.lanHost)) {
			val target = "${scanned.lanHost}:${scanned.lanPort}"
			when (val r = postBundle(scanned.lanHost, scanned.lanPort, scanned.certFp, frameJson)) {
				is BundlePost.Ok -> {
					DebugLog.log("Enroll", "LAN delivery ok -> $target")
					return@withContext EnrollDelivery(true, "Sent to the Gateway. It's coming online.", null)
				}
				is BundlePost.Rejected -> {
					DebugLog.log("Enroll", "LAN delivery rejected $target HTTP ${r.code} body=${r.body}")
					return@withContext EnrollDelivery(
						true,
						"The Gateway rejected the bundle (HTTP ${r.code}). Paste it into the Gateway's terminal instead.",
						frameJson,
					)
				}
				is BundlePost.Unreachable -> {
					DebugLog.log("Enroll", "LAN delivery unreachable $target cause=${r.cause}")
					return@withContext EnrollDelivery(
						true,
						"Couldn't reach the Gateway over the LAN. Paste the bundle into its terminal instead.",
						frameJson,
					)
				}
			}
		}
		EnrollDelivery(true, "Added. Copy the bundle to the Gateway's enrollment prompt.", frameJson)
	}

	/** The outcome of a LAN bundle POST, split so a Gateway-side rejection (a 4xx - meaning the bundle
	 * WAS delivered) is never reported as "couldn't reach": the two need very different user fixes. */
	private sealed interface BundlePost {
		object Ok : BundlePost
		data class Rejected(val code: Int, val body: String) : BundlePost
		data class Unreachable(val cause: String) : BundlePost
	}

	/** POST the sealed bundle to the Gateway's arming-only LAN listener over TLS pinned to the leaf
	 * fingerprint from the QR (see EnrollPinning). The bundle is already sealed to the Gateway box key,
	 * so this TLS only satisfies Android's no-cleartext policy without an app-wide permit and keeps the
	 * LAN wire private. Separates a connect failure from a Gateway-side rejection. */
	private fun postBundle(host: String, port: Int, certFp: String, frameJson: String): BundlePost {
		val client = buildLeafFingerprintPinnedClient(certFp)
		val req = Request.Builder()
			.url("https://$host:$port/enroll")
			.post(frameJson.toRequestBody("application/json".toMediaType()))
			.build()
		return try {
			client.newCall(req).execute().use { resp ->
				if (resp.isSuccessful) BundlePost.Ok
				else BundlePost.Rejected(resp.code, resp.body?.string()?.take(200) ?: "")
			}
		} catch (e: Exception) {
			BundlePost.Unreachable("${e.javaClass.simpleName}: ${e.message?.take(160) ?: ""}")
		}
	}

	/** True only for a private / loopback / link-local IP LITERAL. The admit-gateway QR
	 * carries the Gateway's LAN address and we POST the sealed bundle there, so restricting
	 * the target to an actual LAN address stops a tampered QR from redirecting the bundle
	 * (and the console's plaintext identity metadata) to a public attacker host - a non-LAN
	 * value falls through to the paste path instead. Numeric only: a QR-supplied hostname is
	 * never resolved, since that resolution is itself an attacker-chosen network call. */
	private fun isPrivateLanHost(host: String): Boolean = runCatching {
		android.net.InetAddresses.isNumericAddress(host) &&
			java.net.InetAddress.getByName(host).let { it.isLoopbackAddress || it.isSiteLocalAddress || it.isLinkLocalAddress }
	}.getOrDefault(false)

	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		runCatching { client().teams(localGatewayId) }.onSuccess { applyFreshTeams(it) }
		// Also refresh the cross-Domain peer roster so the Federation PEERS list shows a freshly-linked
		// peer that has no discovery sessions yet. Best-effort + only when federation is reachable;
		// folded into the same refresh so a board update and the peer set stay consistent.
		refreshLinkedPeers()
	}

	/** Apply a freshly-fetched teams list: folds it through ChatState.withFreshTeams (pruning a local
	 * label override the server has since confirmed or the team has vanished for good) and refreshes
	 * the owner's own display name from it. The one site refreshTeams() and the passive poll loop's
	 * own teams refresh both call, so the prune rule lives in exactly one place. */
	// Serializes an applyFreshTeams call end to end (its state update plus both persist writes)
	// against another one - refreshTeams() (a manual pull-to-refresh) and startPolling()'s own
	// periodic teams-refresh both run on Dispatchers.IO, a real thread pool, so without this two
	// genuinely concurrent calls could each persist their own snapshot with no ordering guarantee
	// between the two: SharedPreferences.apply() only guarantees the LAST-CALLED write for a key
	// eventually wins, not that "last called" lines up with "computed from the newer fetch" once two
	// independent capture-then-persist sequences interleave. Held only around this function's own
	// body, never across a suspending network call, so it is never a real contention bottleneck.
	private val freshTeamsMutex = Mutex()

	private suspend fun applyFreshTeams(t: List<Team>) {
		freshTeamsMutex.withLock {
			val next = _state.updateAndGet { it.withFreshTeams(t) }
			persistLabels(next.labels)
			persistAbsenceStreaks(next.teamAbsenceStreaks)
		}
		refreshDisplayNameFromTeams()
	}

	/** Capture an agent's tmux pane for the terminal view. Returns a Result so the caller can keep
	 * the last frame on a transient failure yet surface the backend's reason (container/host offline)
	 * when the pane never loaded. */
	suspend fun peekTerminal(team: String, sinceHash: String?): Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult> =
		withContext(Dispatchers.IO) { runCatching { client().peek(team, sinceHash) } }
			.onSuccess { it.ansi?.let { a -> noteScreen(team, a) } }

	/** Update a session's working + needs-login flags from a captured pane (the spinner and auth
	 * footer markers are the truth). */
	fun noteScreen(team: String, ansi: String) {
		if (ansi.isEmpty()) return
		_state.update {
			it.copy(
				sessionWorking = it.sessionWorking + (team to AgentScreen.isWorking(ansi)),
				sessionNeedsLogin = it.sessionNeedsLogin + (team to AgentScreen.isLoggedOut(ansi)),
			)
		}
	}

	/** A cheap one-shot peek that refreshes a session's working flag without rearming - for the
	 * background session chips. The open chat polls peekTerminal continuously instead. */
	suspend fun pokeWorking(team: String) {
		peekTerminal(team, null)
	}

	// The opId of the most recent still-unresolved spawnSession attempt per (project, label), so a
	// retry within the window reuses it instead of drawing a fresh one - letting the gateway's
	// mintedFrom provenance reattach the first attempt's record (or cleanly mint a new one if that
	// attempt genuinely failed) rather than always minting a second, redundant session. Cleared on a
	// confirmed success; a stale entry past the window is treated as absent. In-memory only.
	private val recentSpawnOpIds = mutableMapOf<Pair<String, String>, Pair<String, Long>>()

	// Comfortably past create_session's own ~25s cold-container bound, so a reply that arrives late
	// (rather than being lost outright) still lands under the same opId as a retry that fires after
	// the user sees a failure.
	private val SPAWN_RETRY_WINDOW_MS = 40_000L

	/** Spawn a session in a spawn-point project with a free-form label. The gateway adopts the
	 * session's record synchronously, so its own tile appears via the next teams() refresh - there is
	 * no separate placeholder. A failure surfaces as a transient Snackbar message and re-syncs teams
	 * so a rolled-back record's tile does not linger; a retry with the same project + label shortly
	 * after reuses the prior attempt's opId (see recentSpawnOpIds) so it reattaches instead of
	 * duplicating. A label the gateway could not use as-is (unsupported characters) still creates the
	 * session under its minted id, surfaced with its own transient message rather than silently
	 * losing the typed name. A call for a (project, label) still pending from an earlier, unresolved
	 * call is a silent no-op (see pendingSpawns) rather than a second, ambiguous create. Runs on the
	 * caller's scope (the Activity's), so a tap always fires even before the poll loop's scope exists. */
	suspend fun spawnSession(project: String, label: String) = coroutineScope {
		val key = project to label
		// A synchronous check before any suspension point - CreateSessionDialog's own disabled-while-pending
		// state is the primary guard, but it is a Composable snapshot (recomposes asynchronously), not a
		// lock; this is the real one, closing the gap for a caller that races ahead of that recomposition
		// or bypasses the dialog entirely.
		if (key in _state.value.pendingSpawns) return@coroutineScope
		val now = System.currentTimeMillis()
		recentSpawnOpIds.entries.removeAll { now - it.value.second >= SPAWN_RETRY_WINDOW_MS }
		val opId = recentSpawnOpIds[key]?.first ?: UUID.randomUUID().toString()
		recentSpawnOpIds[key] = opId to now
		_state.update { it.copy(pendingSpawns = it.pendingSpawns + key) }
		// Nudge a refresh shortly after firing so the just-adopted record's tile shows promptly,
		// without waiting on a cold container's (up to ~25s) create reply.
		launch {
			delay(400)
			runCatching { refreshTeams() }
		}
		runCatching { withContext(Dispatchers.IO) { client().createSession(project, displayLabel = label, opId = opId) } }
			.onSuccess { result ->
				recentSpawnOpIds.remove(key)
				_state.update {
					it.copy(
						pendingSpawns = it.pendingSpawns - key,
						transientMessage = if (result.labelSanitized == true) {
							"\"$label\" has unsupported characters; the session was created using its id as the name instead"
						} else it.transientMessage,
					)
				}
				runCatching { refreshTeams() }
			}
			.onFailure { e ->
				_state.update { it.copy(pendingSpawns = it.pendingSpawns - key, transientMessage = e.message ?: "Failed to create \"$label\"") }
				runCatching { refreshTeams() }
			}
	}

	/** Take and clear the one-shot transient message, so a recomposition never re-shows it. */
	fun consumeTransientMessage(): String? {
		val msg = _state.value.transientMessage
		if (msg != null) _state.update { it.copy(transientMessage = null) }
		return msg
	}

	/** Send text (submitted with Enter) or a named control key to an agent's tmux pane. */
	suspend fun tmuxSend(team: String, text: String? = null, key: String? = null, submit: Boolean = true) =
		withContext(Dispatchers.IO) { client().tmuxSend(team, text, key, submit) }

	val terminalRefreshMs: Long get() = store.terminalRefreshMs

	fun setTerminalRefreshMs(ms: Long) {
		store.terminalRefreshMs = ms
	}

	suspend fun send(team: String, text: String, uris: List<Uri> = emptyList()) = withContext(Dispatchers.IO) {
		val picked = uris.mapNotNull { readUri(it) }
		val total = picked.sumOf { it.bytes.size }
		if (total > MAX_OUTGOING_BYTES) {
			_state.update { it.copy(error = "Attachments too large (max ${MAX_OUTGOING_BYTES / 1_000_000} MB).") }
			return@withContext
		}
		// Local echo: persist the picked files so the sent message shows its own thumbnails through
		// the same asset-loader path as inbound files. The echo starts "pending" and resolves to
		// sent (null) or "error" when the op lands.
		val localFiles = Attachments.storeOutgoing(filesDir, "out-${System.currentTimeMillis()}", picked)
		val opId = java.util.UUID.randomUUID().toString()
		val echoId = append(
			team,
			Message(true, text, System.currentTimeMillis(), files = localFiles, status = "pending", opId = opId),
		)
		val wasAvailable = _state.value.teams.firstOrNull { it.name == team }?.status == "available"
		val hasPlaceholder = _state.value.threads[team]?.any { !it.fromMe && it.status == "waking" } == true
		var placeholderId: Long? = null
		if (wasAvailable && !hasPlaceholder) {
			// Cold wake takes minutes with no wire traffic; show one placeholder row that the first
			// real reply resolves in place (appendInbound). "waking" is a local-only status, so a
			// wire "running" can never be mistaken for it.
			placeholderId = append(
				team,
				Message(false, "Waking $team... first boot can take a minute or two.", System.currentTimeMillis(), status = "waking"),
			)
		}
		deliver(team, echoId, text, picked, opId, placeholderId)
	}

	/** Re-send a failed message, rebuilding attachment bytes from their local
	 * copies. The error -> pending flip is the atomic claim: a double-tap's second
	 * coroutine finds the row already pending and backs off, so the wire send runs
	 * once. The original opId is reused so the gateway dedupes a lost-reply retry. */
	suspend fun retrySend(team: String, messageId: Long) = withContext(Dispatchers.IO) {
		var claimed = false
		_state.update { s ->
			val thread = s.threads[team] ?: return@update s.also { claimed = false }
			val msg = thread.firstOrNull { it.id == messageId }
			if (msg == null || !msg.fromMe || msg.status != "error") {
				claimed = false
				s
			} else {
				claimed = true
				s.copy(threads = s.threads + (team to thread.map { if (it.id == messageId) it.copy(status = "pending") else it }))
			}
		}
		if (!claimed) return@withContext
		val msg = _state.value.threads[team]?.firstOrNull { it.id == messageId } ?: return@withContext
		persistThreads(_state.value.threads)
		val files = rebuildFiles(msg)
		if (msg.text.isBlank() && files.isEmpty()) {
			// Nothing recoverable (attachment copies gone); put the badge back and say why.
			setMessageStatus(team, messageId, "error")
			_state.update { it.copy(error = "Attachments are no longer on this device; cannot retry.") }
			return@withContext
		}
		if (files.size < msg.files.size) {
			_state.update { it.copy(error = "Some attachments are no longer on this device; resending the rest.") }
		}
		deliver(team, messageId, msg.text, files, msg.opId ?: java.util.UUID.randomUUID().toString(), null)
	}

	/** Run the wire send and settle the echo row's state from the outcome. On
	 * failure the cold-wake placeholder (if this send created one) is removed:
	 * nothing is coming to resolve it. */
	private fun deliver(
		team: String,
		echoId: Long,
		text: String,
		picked: List<OutgoingFile>,
		opId: String,
		placeholderId: Long?,
	) {
		fun fail(message: String?) {
			_state.update { it.copy(error = message ?: "send failed") }
			setMessageStatus(team, echoId, "error")
			if (placeholderId != null) removeMessage(team, placeholderId)
		}
		try {
			// A cross-Domain target carries the friend Domain id from its discovery entry, so the
			// gateway resolves the seal target by the full (domainId, gatewayId) pair; a local /
			// same-Domain session resolves to null and keeps the existing routing.
			val adminDomain = confirmedDomainId()
			val canonical = canonicalTarget(team)
			val targetDomain = _state.value.teams
				.firstOrNull { it.name == canonical }
				?.domainId
				?.takeIf { it.isNotEmpty() && adminDomain != null && it != adminDomain }
			val r = client().send(team, text, picked, opId, targetDomain)
			when {
				!r.ok -> fail(r.error)
				else -> setMessageStatus(team, echoId, null)
			}
		} catch (e: Exception) {
			// Route through the same classifier the poll loop + connect use, so a send
			// surfaces a legible cause ("Can't reach the server", "Bridge token rejected")
			// instead of a raw "HTTP 401: {json}" exception string.
			val (cause, _) = classifyConnError(e)
			fail(cause)
		}
	}

	/** Rebuild outgoing bytes from the local attachment copies stored at first
	 * send; files whose copies are gone are dropped (caller decides how loudly). */
	private fun rebuildFiles(msg: Message): List<OutgoingFile> = msg.files.mapNotNull { f ->
		val rel = f.src?.substringAfter("/${Attachments.DIR}/", "")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
		val file = Attachments.resolve(filesDir, rel) ?: return@mapNotNull null
		runCatching { OutgoingFile(f.name, f.mime, file.readBytes()) }.getOrNull()
	}

	private fun removeMessage(team: String, id: Long) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to thread.filterNot { it.id == id }))
		}.threads
		persistThreads(threads)
	}

	private fun setMessageStatus(team: String, id: Long, status: String?) {
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team] ?: return@updateAndGet s
			s.copy(threads = s.threads + (team to thread.map { if (it.id == id) it.copy(status = status) else it }))
		}.threads
		persistThreads(threads)
	}

	private fun readUri(uri: Uri): OutgoingFile? = runCatching {
		val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
		val mime = contentResolver.getType(uri) ?: "application/octet-stream"
		OutgoingFile(queryName(uri) ?: "file", mime, bytes)
	}.getOrNull()

	private fun queryName(uri: Uri): String? = runCatching {
		contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
			if (c.moveToFirst()) c.getString(0) else null
		}
	}.getOrNull()

	fun startPolling(scope: CoroutineScope) {
		if (pollJob?.isActive == true) return
		pollScope = scope
		pollJob = scope.launch(Dispatchers.IO) {
			var lastTeamsAt = 0L
			while (isActive) {
				var failed = false
				var heldEmpty = false
				var hold = 0L
				try {
					// The board's live/available states would otherwise only change on
					// a manual Refresh; piggyback a team-list refresh on the poll loop.
					val now = System.currentTimeMillis()
					if (forceTeamsRefresh || now - lastTeamsAt >= TEAMS_REFRESH_MS) {
						forceTeamsRefresh = false
						lastTeamsAt = now
						runCatching { client().teams(localGatewayId) }.onSuccess { applyFreshTeams(it) }
					}
					// Visible: long-poll (the hold IS the wait; re-poll immediately).
					// AFK: plain poll, then sleep an interval; the mailbox batches.
					hold = if (visible) LONG_POLL_HOLD_MS else 0L
					val started = System.currentTimeMillis()
					val params = mailboxSync.pollParams()
					DebugLog.log("Poll", "firing cursor=${params.cursor} epoch=${params.epoch} hold=${hold}ms")
					val mb = client().poll(params.cursor, params.epoch, hold)
					// Keyring sync: the route Gateway returns the snapshot only when it changed.
					// Apply it owner-pinned so a revocation made elsewhere reaches this Console.
					mb.domain?.let { federation.applyDomainSync(it, mb.domainVersion ?: "") }
					// An old gateway ignores holdMs and returns empty instantly; floor
					// the cadence so that degradation never becomes a tight spin.
					heldEmpty = hold > 0 && mb.entries.isEmpty() &&
						System.currentTimeMillis() - started < 3_000
					// Fold the result through the durable cursor: epoch flip, seq dedupe (a
					// lost-ack re-drain), and the dropped-gap DELTA all live in advance(), which
					// returns only genuinely-fresh entries. commit() advances the cursor LAST,
					// after the fresh entries are rendered + persisted (two-phase: a crash
					// re-delivers rather than skips).
					val adv = mailboxSync.advance(
						SyncPollResult(mb.entries.map { Drained(it) }, mb.cursor, mb.epoch, mb.dropped),
					)
					if (mb.entries.isEmpty()) {
						DebugLog.log("Poll", "empty (held=$heldEmpty epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped})")
					} else {
						DebugLog.log("Poll", "${adv.fresh.size}/${mb.entries.size} fresh epoch=${mb.epoch} cursor=${mb.cursor} dropped=${mb.dropped}")
					}
					if (adv.gap) _state.update { it.copy(gap = true) }
					val burst = mutableMapOf<String, MutableList<Message>>()
					val deviceAddr = thisDeviceAddress()
					for (d in adv.fresh) {
						val e = d.entry
						// Resolve the thread key for this entry; null means drop it. Notices thread under
						// the sender's canonical address; conv sessions use the session address, except
						// when that address is THIS device (an agent-initiated push to our own session
						// threads under `from`, the sender, not under ourselves).
						val team: String? = if (e.kind == "notice") {
							// Notice: prefer `from`, fall back to the notice store key's sender.
							e.from?.let { fromCanonical(it) }
								?: (parseStoreKey(e.session_id) as? SessionKey.Notice)?.sender?.canonical
						} else {
							when (val sk = parseStoreKey(e.session_id)) {
								is SessionKey.Conv ->
									if (deviceAddr != null && sk.address == deviceAddr) {
										// Push to our own session: thread under the sender, falling back to our own
										// self-address - a non-address `from` (a raw Device Name) would otherwise become
										// an unsendable ghost-chat key.
										e.from?.let { fromCanonical(it) } ?: sk.address.canonical
									} else {
										sk.address.canonical
									}
								// Not a conv store key; fall back to `from` if present.
								else -> e.from?.let { fromCanonical(it) }
							}
						}
						if (team == null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} from=${e.from} -> DROPPED (unresolvable team)")
							continue
						}
						val files = Attachments.decode(filesDir, mb.epoch, e.seq, e.files)
						// status-only entries still land (e.g. a wake-failure error
						// with no body would otherwise vanish).
						val bodyText = e.body.orEmpty()
						val snippet = bodyText.replace(Regex("\\s+"), " ").trim().take(80)
						if (e.kind == "sent") {
							// The owner's own outgoing message, mirrored to all their devices.
							DebugLog.log("Drain", "seq=${e.seq} kind=sent session=${e.session_id} -> thread=$team (own mirror) opId=${e.opId} \"$snippet\"")
							val echo = Message(true, bodyText, e.at, files = files, status = null, opId = e.opId, epoch = mb.epoch, seq = e.seq)
							reconcileSent(team, echo)
							continue
						}
						if (e.kind == "plugin_action") {
							// Never rendered as a chat message, so it never depends on a nonempty body.
							val pluginId = e.pluginId
							val actionType = e.actionType
							if (pluginId != null && actionType != null) {
								DebugLog.log("Drain", "seq=${e.seq} kind=plugin_action session=${e.session_id} -> thread=$team $pluginId:$actionType")
								pluginActionSubscribers.forEach { sub ->
									runCatching { sub.onAction(team, pluginId, actionType, e.payload) }
										.onFailure { DebugLog.log("Drain", "plugin action subscriber threw: $it") }
								}
							}
							continue
						}
						if (bodyText.isNotEmpty() || files.isNotEmpty() || e.status != null) {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team status=${e.status} files=${files.size} \"$snippet\"")
							val attribution = resolveMessageAttribution(e.kind, e.from, e.to, team, ::fromCanonical)
							val msg = Message(
								false, bodyText, e.at, files = files, status = e.status,
								title = e.title.tierOrNull(), summary = e.summary.tierOrNull(), fullSpoken = e.fullSpoken.tierOrNull(),
								epoch = mb.epoch, seq = e.seq, from = attribution.from, to = attribution.to, isPeer = attribution.isPeer,
								arrivedVisible = visible && !resumeBacklogPending,
							)
							// appendInbound folds an at-least-once re-drain in place and returns
							// false, so a redelivered entry never re-bumps unread or re-notifies. unread
							// itself is recomputed from the anchor inside appendInbound's own state update
							// (the single-writer derivation), not bumped here.
							if (appendInbound(team, msg)) {
								burst.getOrPut(team) { mutableListOf() }.add(msg)
								// Data-plane fan-out: synchronous, pre-commit, so subscribers get the
								// mailbox cursor's exactly-once for free. A subscriber must never throw
								// upward (a throw here would break the drain for every team), so a throw
								// is caught and logged rather than escaping.
								inboundSubscribers.forEach { sub ->
									runCatching { sub.onMessage(team, msg) }
										.onFailure { DebugLog.log("Drain", "inbound subscriber threw: $it") }
								}
							}
						} else {
							DebugLog.log("Drain", "seq=${e.seq} kind=${e.kind} session=${e.session_id} -> thread=$team SKIPPED (no body, no files, no status)")
						}
					}
					val autoPlayedPeerPairs = mutableSetOf<String>()
					for ((team, msgs) in burst) {
						val lastAgent = msgs.lastOrNull { !it.fromMe }
						val alreadyAutoPlayed = isDuplicatePeerAutoPlay(lastAgent, autoPlayedPeerPairs)
						// Only spend synthesis on followed threads (open tabs); a
						// never-opened or forgotten session is not in openTabs, so it
						// notifies without preloading.
						val followed = team in _state.value.openTabs
						val scope = pollScope
						// Pre-generate and auto-play are independent: enter the launch
						// path when either is active for this followed thread.
						val autoTier = autoPlayTier(sttsAutoPlay)
						if (scope != null && lastAgent != null && sttsReady() && followed && !alreadyAutoPlayed && (sttsAutoGen || autoTier != null)) {
							val t = team
							val ms = msgs
							val at = lastAgent.at
							scope.launch(Dispatchers.IO) {
								// When pre-generate is on, wait fully for synthesis so the
								// cache is warm when the notification lands. preloadMessage
								// never throws and is bounded by the STTS client's own
								// timeouts, so a failed or slow synth still falls through and
								// the notification fires.
								if (sttsAutoGen) preloadMessage(t, at)
								onInbound?.invoke(t, ms)
								// Hands-free: speak the chosen tier the moment it arrives. A
								// tier not pre-synthesized is synthesized on demand here.
								if (autoTier != null) playMessage(t, at, autoTier)
							}
						} else {
							onInbound?.invoke(team, msgs)
						}
					}
					mailboxSync.commit(adv.next)
					// This pass's own drain (just committed) is the "first completed pass" the resume
					// flag exists to cover; the NEXT pass's rows tag by live visibility again.
					resumeBacklogPending = false
					pollFails = 0
					if (_state.value.error != null || _state.value.pollFailStreak != 0) {
						_state.update { it.copy(error = null, pollFailStreak = 0, connected = true, enrollingSince = 0L) }
					}
					// Flush buffered debug lines to the ingest endpoint once per cycle.
					DebugLog.flushToIngest()
				} catch (e: Exception) {
					if (hold > 0 && e.message?.startsWith("HTTP 504") == true) {
						// A relay-timeout during a hold is an empty long-poll, not an
						// outage: an evie still on the shorter hold (upgrade window) or
						// a transient gateway drop mid-hold. Back off, do not alarm.
						DebugLog.log("Poll", "hold timeout (504) treated as empty long-poll")
						heldEmpty = true
					} else {
						// Name the SPECIFIC cause instead of a blanket "Connection issue". A
						// TERMINAL cause (not enrolled, bridge not deployed, bad creds) cannot
						// clear by retrying, so surface it on the first failure; a TRANSIENT blip
						// waits for a second failure so one hiccup never alarms; an ENROLLING
						// sync-lag shows the calm "Finishing up enrollment..." at once and the
						// poll loop's own retry clears it the moment an op succeeds.
						val (cause, kind) = classifyConnError(e)
						DebugLog.log("Poll", "error streak=${ pollFails + 1 } [$kind]: ${e.message?.take(120)}")
						failed = true
						pollFails++
						_state.update { s ->
							when (kind) {
								ConnKind.ENROLLING -> {
									val (override, since) = enrollFold(s.enrollingSince)
									s.copy(pollFailStreak = pollFails, error = override ?: cause, enrollingSince = since)
								}
								ConnKind.TERMINAL -> s.copy(pollFailStreak = pollFails, error = cause, enrollingSince = 0L)
								ConnKind.TRANSIENT ->
									s.copy(pollFailStreak = pollFails, error = if (pollFails >= 2) cause else s.error, enrollingSince = 0L)
							}
						}
					}
					DebugLog.flushToIngest()
				}
				// Adaptive cadence with a foreground kick: a resume interrupts the
				// AFK wait so the user never stares at stale state. Visible long-polls
				// chain back-to-back; failures and ignored holds back off to 5s.
				val interval = when {
					!visible -> AFK_POLL_INTERVAL_MS
					failed || heldEmpty -> POLL_INTERVAL_MS
					else -> 0L
				}
				if (interval > 0) withTimeoutOrNull(interval) { kick.receive() }
			}
		}
	}

	/** Re-deliver echoes stranded "pending" (process death, doze-killed socket)
	 * once each, using their original opId: the gateway replays the cached result
	 * if the send actually landed, so this can never double-deliver. A row whose
	 * send never landed re-fails to the tap-to-retry badge. */
	suspend fun reconcilePending() = withContext(Dispatchers.IO) {
		for ((team, msgs) in _state.value.threads) {
			for (m in msgs) {
				if (!m.fromMe || m.status != "pending") continue
				val key = "$team:${m.id}"
				if (!reconciled.add(key)) continue
				if (m.opId == null) {
					// Legacy row with no opId: cannot re-send safely; make it retriable.
					setMessageStatus(team, m.id, "error")
					continue
				}
				deliver(team, m.id, m.text, rebuildFiles(m), m.opId, null)
			}
		}
	}

	/** Mark a team fully read without opening it (swipe-away on its notification reads the burst).
	 * Advances the persisted anchor to the thread's tail - not just the volatile `unread` count -
	 * so a deliberate dismiss survives a process restart instead of resurrecting. */
	fun markRead(team: String) {
		var anchorChanged = false
		val next = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val candidate = lastInboundAnchor(thread)
			val withAnchor = if (candidate != null && isAnchorAdvance(thread, s.readAnchors[team], candidate)) {
				anchorChanged = true
				s.copy(readAnchors = s.readAnchors + (team to candidate))
			} else {
				anchorChanged = false
				s
			}
			withAnchor.recomputeUnread(team, thread)
		}
		if (anchorChanged) persistReadAnchors(next.readAnchors)
	}

	/** Open (or focus) a thread's tab, deduped by canonical key. The spawn dialog opens a local
	 * `spawn.session` while the board and inbound replies use the full canonical address, so
	 * canonicalize before adding or the same session lands as two tabs. Returns the canonical key so
	 * the caller can point its active-tab pointer at the same value. Does NOT clear unread - reading
	 * a thread is what clears it now (the scroll-driven receipt model), not the act of opening it. */
	fun openThread(team: String): String {
		val key = canonicalTarget(team)
		_state.update { s ->
			s.copy(
				openTabs = if (key in s.openTabs) s.openTabs else s.openTabs + key,
				// Reopening un-mutes: a previously-closed team goes back to full notification treatment.
				closedTeams = s.closedTeams - key,
			)
		}
		return key
	}

	/** The current first-unread row id and the pointer-region ids (rows still counting toward
	 * unread) for `team`, derived from the live anchor. Used by the reveal trigger - always AFTER
	 * flushing any pending debounced receipt, so this reflects what was just read rather than a
	 * stale pre-flush anchor. */
	fun unreadBoundary(team: String): Pair<Long?, List<Long>> {
		val s = _state.value
		val thread = s.threads[team].orEmpty()
		val anchor = s.readAnchors[team]
		return firstUnreadId(thread, anchor) to unreadRows(thread, anchor).map { it.id }
	}

	/** A scroll-driven read receipt: the highest row the reader has scrolled past, reported by id
	 * with its `at` (guards against a forget-freed id being reused by a later append before this
	 * debounced report lands). Resolves to the nearest inbound row at-or-before the report, and
	 * only advances the anchor when that resolves to a genuinely later position - so a stale or
	 * duplicate report is a harmless no-op. */
	fun readUpTo(team: String, rowId: Long, at: Long) {
		var changed = false
		val next = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val candidate = resolveReportedAnchor(thread, rowId, at)
			if (candidate != null && isAnchorAdvance(thread, s.readAnchors[team], candidate)) {
				changed = true
				s.copy(readAnchors = s.readAnchors + (team to candidate)).recomputeUnread(team, thread)
			} else {
				changed = false
				s
			}
		}
		if (changed) persistReadAnchors(next.readAnchors)
	}

	/** Close a tab: drop it locally AND, for a local addressable session, kill its tmux on the gateway
	 * while KEEPING its resume record (so it stays listed as available for a re-wake). The record
	 * surviving is what distinguishes Close from Forget. Best-effort; a gateway rejection (e.g. mid-
	 * wake, or a user-launched session) surfaces as a transient message rather than blocking the local
	 * tab close. */
	fun closeTab(team: String) {
		// Canonicalize before touching openTabs/closedTeams (matching openThread's own key), so a
		// non-canonical spelling of an already-open team can't silently miss the removal and mute
		// the wrong (uncanonicalized) key instead.
		val key = canonicalTarget(team)
		// Muted until reopened: full notification treatment (banner + TTS) downgrades to a
		// quiet mailbox/unread-count bump for this team.
		_state.update { it.copy(openTabs = it.openTabs - key, closedTeams = it.closedTeams + key) }
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		if (t is Address && t.gateway == _state.value.localGatewayId) {
			pollScope?.launch(Dispatchers.IO) {
				runCatching { client().closeSession(team) }
					.onFailure { e -> _state.update { it.copy(transientMessage = e.message ?: "close failed") } }
			}
		}
	}

	/** Wake an asleep session (the terminal-view Wake button): reattach its record and bring its
	 * container/tmux back up. Reuses create_session's reattach-and-wake path keyed on the session's
	 * own spawn + leaf, so an existing record resumes rather than a duplicate being minted.
	 * Best-effort; a failure surfaces as a transient message. */
	fun wakeSession(team: String) {
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		if (t !is Address || t.gateway != _state.value.localGatewayId) return
		pollScope?.launch(Dispatchers.IO) {
			runCatching { client().createSession(target = t.spawn, sessionName = t.session) }
				.onFailure { e -> _state.update { it.copy(transientMessage = e.message ?: "wake failed") } }
		}
	}

	// Per-session composer drafts, persisted so a power-management kill (or any process
	// death) never loses a half-typed message. Keyed by the same canonical team id as
	// threads; an empty draft is dropped so the map stays sparse.
	private val drafts: MutableMap<String, String> = loadPersistedDrafts()

	fun draft(team: String): String = drafts[team] ?: ""

	fun setDraft(team: String, text: String) {
		if (text.isEmpty()) drafts.remove(team) else drafts[team] = text
		persistDrafts()
	}

	/** Give a team a local display label (or clear it with a blank name). Local-only: the optimistic
	 * cache that shows immediately and the fallback against a gateway with no server label. */
	fun setLabel(team: String, name: String) {
		val labels = _state.updateAndGet { s ->
			val next = if (name.isBlank()) s.labels - team else s.labels + (team to name.trim())
			s.copy(labels = next)
		}.labels
		persistLabels(labels)
	}

	/** Rename a session: set it locally for immediate feedback, then push it to the gateway so the
	 * label persists server-side, and reconcile the local label to whatever the gateway actually
	 * applied (it sanitizes and per-spawn dedups, so "foo" may land as "foo-2"). A blank name clears
	 * the local label only, unconditionally - like closeTab's own local-only mutation, clearing never
	 * needs the network or an ownership check. On an unreachable/older gateway the optimistic local
	 * label stays - the gateway is presumed to apply it eventually. The optimistic non-blank write is
	 * withheld for a target that does not resolve to THIS Gateway's own Domain (closeTab/wakeSession's
	 * "is this mine" check compares gateway alone; a federated peer's session can coincidentally share
	 * this Gateway's id, so this matches the gateway's own rename_session guard, which checks both) -
	 * a federated peer's session can otherwise pass the board's own, more permissive Rename-menu gates
	 * and flash a label that was never actually applied anywhere; the round trip is still attempted
	 * regardless (a second, reactive line of defense - the server's own rejection is the backstop even
	 * if this check has a gap). An outright rejection (a successful round trip that still reports
	 * renamed:false) reverts the optimistic write, but ONLY if the label still holds exactly what this
	 * call wrote - a fresher server value landing via withFreshTeams, or a newer overlapping rename,
	 * must never be clobbered by a stale rejection arriving late, and the transient message mirrors that
	 * same guard (no revert happened -> nothing to report). A foreign target is always refused server-side
	 * as a thrown error (not a clean renamed:false reply - there is no local record to even consider
	 * renaming), so it is treated the same as an explicit rejection instead of the quiet
	 * presumed-eventually-applied handling a genuinely unreachable LOCAL gateway gets - otherwise that
	 * case is a silent no-op indistinguishable from success. */
	suspend fun rename(team: String, name: String) {
		val trimmed = name.trim()
		if (trimmed.isEmpty()) {
			setLabel(team, "")
			return
		}
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		val isLocal = t is Address && t.domain == localDomain() && t.gateway == _state.value.localGatewayId
		val previous = _state.value.labels[team]
		if (isLocal) setLabel(team, trimmed)
		val result = withContext(Dispatchers.IO) { runCatching { client().renameSession(team, trimmed) } }
		val reply = result.getOrNull()
		val applied = reply?.takeIf { it.renamed }?.sessionLabel
		if (applied != null && applied != trimmed) {
			// A confirmed, authoritative server value always wins over "nothing was protecting the
			// label to begin with" (isLocal false - no optimistic write was ever made to clobber).
			// When there WAS an optimistic write, only overwrite it while it still holds exactly what
			// this call itself set - never stomp a fresher value a concurrent self-heal or a later
			// rename already landed in the meantime.
			val next = _state.updateAndGet { s ->
				if (!isLocal || s.labels[team] == trimmed) s.copy(labels = s.labels + (team to applied)) else s
			}
			persistLabels(next.labels)
		} else if (reply?.renamed == false || (!isLocal && result.isFailure)) {
			var reverted = true
			if (isLocal) {
				val before = _state.value.labels[team]
				val next = _state.updateAndGet { s ->
					if (s.labels[team] == trimmed) {
						s.copy(labels = if (previous != null) s.labels + (team to previous) else s.labels - team)
					} else {
						s
					}
				}
				persistLabels(next.labels)
				reverted = next.labels[team] != before
			}
			if (reverted) {
				val message = result.exceptionOrNull()?.message ?: "Could not rename to \"$trimmed\""
				_state.update { it.copy(transientMessage = message) }
			}
		}
	}

	/** Drop a peer from this device: its thread, unread, tab, label, any cached TTS audio, and any
	 * peer-mirror row elsewhere that names it as a real party (see threadsAfterForget). Threads AND
	 * read anchors change in this ONE transition (the peer sweep can orphan a sibling thread's
	 * anchor row, re-anchored below), so both persist in a single batch - a process kill between
	 * two separate writes could otherwise strand a sibling's anchor against its already-updated
	 * (shrunk) thread. `unread` is recomputed for every team, not just the forgotten one: the sweep
	 * can remove rows another thread was counting, so its count must be re-derived too. */
	fun forget(team: String) {
		// Canonicalize once and key every field removal by it (matching openThread's own key), so
		// a non-canonical spelling can't leave a field's entry behind while the others clear.
		val key = canonicalTarget(team)
		val next = _state.updateAndGet { s ->
			val newThreads = threadsAfterForget(s.threads, key)
			val newAnchors = (s.readAnchors - key).mapValues { (t, anchor) ->
				reanchorAfterForget(newThreads[t].orEmpty(), anchor) ?: anchor
			}
			s.copy(
				threads = newThreads,
				labels = s.labels - key,
				unread = newThreads.mapValues { (t, msgs) -> unreadCount(msgs, newAnchors[t]) },
				readAnchors = newAnchors,
				openTabs = s.openTabs - key,
				closedTeams = s.closedTeams - key,
				sessionWorking = s.sessionWorking - key,
				sessionNeedsLogin = s.sessionNeedsLogin - key,
			)
		}
		persistThreadsAndReadAnchors(next.threads, next.readAnchors)
		persistLabels(next.labels)
		drafts.remove(key)
		persistDrafts()
		stts.purge(key)
		// Also tear the live session down on the gateway (kill tmux + drop the resume record) so it
		// stops listing as available. Local addressable sessions only (a remote thread or a non-address
		// spawn-point has no local pane to kill); best-effort, the gateway no-ops an absent session.
		val t = runCatching { parseTarget(team, localDomain(), _state.value.localGatewayId) }.getOrNull()
		if (t is Address && t.gateway == _state.value.localGatewayId) {
			pollScope?.launch(Dispatchers.IO) { runCatching { client().forget(team) } }
		}
	}

	fun setBiometricLock(enabled: Boolean) {
		store.biometricLock = enabled
		_state.update { it.copy(biometricLock = enabled) }
	}

	suspend fun setDeviceName(name: String) = withContext(Dispatchers.IO) {
		val blob = store.load() ?: return@withContext
		val j = JSONObject(blob).put("device", name)
		store.save(j.toString())
		client = null
		_state.update { it.copy(deviceName = name) }
		connect()
	}

	private fun currentDeviceName(): String =
		store.load()?.let { runCatching { Provisioning.parse(it).device }.getOrNull() } ?: ""

	suspend fun clearAll() = withContext(Dispatchers.IO) {
		pollJob?.cancel()
		// Preserve the settings-owned voice creds + taste: Clear & re-provision wipes
		// provisioning/identity/history, never voice (clear() is the full factory wipe).
		store.clearProvisioning()
		client = null
		sttsClient = null
		stts.purgeAll()
		localGatewayId = ""
		mailboxSync.clearInMemory()
		_state.value = ChatState(provisioned = false)
	}

	private fun append(team: String, msg: Message): Long {
		var newId = 0L
		val threads = _state.updateAndGet { s ->
			val existing = s.threads[team].orEmpty()
			newId = (existing.maxOfOrNull { it.id } ?: -1L) + 1
			val next = existing + msg.copy(id = newId)
			s.copy(threads = s.threads + (team to next)).recomputeUnread(team, next)
		}.threads
		persistThreads(threads)
		return newId
	}

	/** Append a message that came from the wire. If the thread holds the synthetic
	 * waking placeholder (wherever it sits - a second send may have landed after
	 * it), the first real word from the team resolves it in place (same row id),
	 * so the placeholder never lingers in the transcript. Every branch recomputes `unread` inside
	 * the SAME state update that touches `threads` (the single-writer derivation) rather
	 * than a separate increment, so it can never race or drift from the anchor. */
	private fun appendInbound(team: String, msg: Message): Boolean {
		// At-least-once dedup: an entry with the same mailbox (epoch, seq) was already
		// rendered, so fold it in place and report no new render (no re-notify/TTS).
		// seq 0 is a local or legacy row that never re-drains, so it is exempt.
		if (msg.seq > 0) {
			var folded = false
			val updated = _state.updateAndGet { s ->
				val thread = s.threads[team].orEmpty()
				val idx = thread.indexOfFirst { it.seq == msg.seq && it.epoch == msg.epoch }
				if (idx >= 0) {
					folded = true
					val next = thread.toMutableList().also { it[idx] = msg.copy(id = thread[idx].id) }
					s.copy(threads = s.threads + (team to next)).recomputeUnread(team, next)
				} else {
					folded = false
					s
				}
			}
			if (folded) {
				persistThreads(updated.threads)
				return false
			}
		}
		var replaced = true
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			// A peer-mirror message is never an answer to the console's own question - it must
			// append as its own row instead of resolving a placeholder that is waiting on a reply
			// actually addressed to this thread.
			val idx = if (msg.isPeer) -1 else thread.indexOfLast { !it.fromMe && it.status == "waking" }
			if (idx >= 0) {
				val next = thread.toMutableList().also { it[idx] = msg.copy(id = thread[idx].id) }
				s.copy(threads = s.threads + (team to next)).recomputeUnread(team, next)
			} else {
				replaced = false
				s
			}
		}.threads
		if (replaced) {
			persistThreads(threads)
		} else {
			append(team, msg)
		}
		return true
	}

	/** Fold a `sent` echo: an owner's own outgoing message mirrored to all their devices. On the
	 * SENDING device it upgrades the optimistic pending row (matched by opId) in place and settles
	 * it; on the owner's OTHER devices it appends a fresh settled row. An at-least-once re-drain
	 * folds by (epoch, seq). Never bumps unread or notifies: it is the owner's own message, so the
	 * sender does not double-render and the other devices just reflect it. */
	private fun reconcileSent(team: String, echo: Message) {
		var handled = false
		val threads = _state.updateAndGet { s ->
			val thread = s.threads[team].orEmpty()
			val idx = sentEchoMatch(thread, echo)
			if (idx >= 0) {
				handled = true
				val next = thread.toMutableList().also { it[idx] = echo.copy(id = thread[idx].id) }
				s.copy(threads = s.threads + (team to next))
			} else {
				s
			}
		}.threads
		if (handled) persistThreads(threads) else append(team, echo)
	}

	private fun threadsJson(threads: Map<String, List<Message>>): String {
		val root = JSONObject()
		for ((team, msgs) in threads) {
			val arr = JSONArray()
			for (m in msgs) {
				val obj = JSONObject().put("me", m.fromMe).put("text", m.text).put("at", m.at)
				obj.putOpt("status", m.status)
				obj.putOpt("opId", m.opId)
				if (m.epoch != 0L) obj.put("epoch", m.epoch)
				if (m.seq != 0L) obj.put("seq", m.seq)
				obj.putOpt("title", m.title)
				obj.putOpt("summary", m.summary)
				obj.putOpt("fullSpoken", m.fullSpoken)
				val (persistFrom, persistTo) = persistedAttribution(m)
				obj.putOpt("from", persistFrom)
				obj.putOpt("to", persistTo)
				if (m.isPeer) obj.put("isPeer", true)
				// Persist local paths (the decoded files survive on disk), never base64.
				if (m.files.isNotEmpty()) {
					val files = JSONArray()
					for (f in m.files) {
						files.put(JSONObject().put("name", f.name).put("mime", f.mime).putOpt("src", f.src))
					}
					obj.put("files", files)
				}
				arr.put(obj)
			}
			root.put(team, arr)
		}
		return root.toString()
	}

	private fun persistThreads(threads: Map<String, List<Message>>) {
		runCatching { store.saveThreads(threadsJson(threads)) }
	}

	private fun readAnchorsJson(anchors: Map<String, ReadAnchor>): String {
		val root = JSONObject()
		for ((team, a) in anchors) {
			root.put(team, JSONObject().put("epoch", a.epoch).put("seq", a.seq).put("at", a.at))
		}
		return root.toString()
	}

	private fun persistReadAnchors(anchors: Map<String, ReadAnchor>) {
		runCatching { store.saveReadAnchors(readAnchorsJson(anchors)) }
	}

	/** Write threads AND read anchors in one SharedPreferences batch (see
	 * AppStateStore.saveThreadsAndReadAnchors) - required whenever a single state transition
	 * changed both, so a process kill between two separate writes can never strand one against
	 * the other's stale value. */
	private fun persistThreadsAndReadAnchors(threads: Map<String, List<Message>>, anchors: Map<String, ReadAnchor>) {
		runCatching { store.saveThreadsAndReadAnchors(threadsJson(threads), readAnchorsJson(anchors)) }
	}

	/** Load persisted read anchors, keyed by canonical address. On the FIRST run after this
	 * feature ships (no anchors persisted at all yet - `store.loadReadAnchors()` returns null),
	 * one-shot seed every EXISTING thread at its own tail, so the update does not resurrect old
	 * messages as unread; a brand-new team created afterward gets no seed and its first message
	 * badges immediately via the runtime "no anchor -> everything after it unread" rule. */
	private fun loadPersistedReadAnchors(threads: Map<String, List<Message>>): Map<String, ReadAnchor> {
		val json = store.loadReadAnchors()
		if (json != null) {
			return runCatching {
				val root = JSONObject(json)
				buildMap {
					for (rawKey in root.keys()) {
						if (!isAddressKey(rawKey)) continue
						val a = root.getJSONObject(rawKey)
						put(rawKey, ReadAnchor(a.optLong("epoch"), a.optLong("seq"), a.optLong("at")))
					}
				}
			}.getOrDefault(emptyMap())
		}
		val seeded = threads.mapNotNull { (team, msgs) -> lastInboundAnchor(msgs)?.let { team to it } }.toMap()
		persistReadAnchors(seeded)
		return seeded
	}

	/** A persisted thread/label/draft key is a canonical 4-segment address (domain.gateway.spawn.session).
	 * Anything else - a prior device-name-as-segment bug key, or any non-canonical shorter form - is
	 * dropped on load so it cannot resurface as an unsendable ghost chat; re-saving the cleaned map
	 * drops it for good. The exact-3-dots check enforces arity 4 (parseTarget alone also accepts arity
	 * 1/2/3). The domain arg is "" not localDomain(): this runs during _state construction (localDomain()
	 * reads _state and would NPE), and a 4-segment key carries its own domain so the arg is unused. */
	private fun isAddressKey(rawKey: String): Boolean =
		rawKey.count { it == '.' } == 3 && runCatching { parseTarget(rawKey, "", localGatewayId) }.isSuccess

	private fun loadPersistedThreads(): Map<String, List<Message>> {
		val json = store.loadThreads() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			val merged = LinkedHashMap<String, MutableList<Message>>()
			for (rawKey in root.keys()) {
				if (!isAddressKey(rawKey)) continue
				val canonicalKey = rawKey
				val arr = root.getJSONArray(rawKey)
				val loaded = (0 until arr.length()).map {
					val m = arr.getJSONObject(it)
					val isPeer = m.optBoolean("isPeer")
					// A peer row's from/to are the same address grammar as a thread key, so validate them
					// the same way (isAddressKey) before trusting them - a corrupted store file or a future
					// grammar change must degrade to the existing unresolvable-from fallback, not surface
					// a malformed value verbatim into a notification or the thread UI.
					val (loadedFrom, loadedTo) = loadedAttribution(
						persistedFrom = m.optString("from").takeIf { s -> s.isNotEmpty() && isAddressKey(s) },
						persistedTo = m.optString("to").takeIf { s -> s.isNotEmpty() && isAddressKey(s) },
						isPeer = isPeer,
						isMe = m.optBoolean("me"),
						canonicalKey = canonicalKey,
					)
					Message(
						m.optBoolean("me"),
						m.optString("text"),
						m.optLong("at"),
						0L,
						loadFiles(m),
						m.optString("status").takeIf { s -> s.isNotEmpty() },
						m.optString("opId").takeIf { s -> s.isNotEmpty() },
						title = m.optString("title").tierOrNull(),
						summary = m.optString("summary").tierOrNull(),
						fullSpoken = m.optString("fullSpoken").tierOrNull(),
						epoch = m.optLong("epoch", 0L),
						seq = m.optLong("seq", 0L),
						from = loadedFrom,
						to = loadedTo,
						isPeer = isPeer,
					)
				}
					// A "waking" placeholder has no resolution coming after a process death; drop it.
					// A peer-mirror row is never an answer to the console's own question (it's an
					// agent-to-agent exchange, mirrored for visibility), so it must not resolve the
					// spinner either, even though it also satisfies "not fromMe". "pending" echoes
					// WITH an opId are kept for the service's idempotent reconcile; legacy ones without
					// an opId cannot be re-sent safely, so they demote to retriable here (and never
					// strand a forever-working chip if the service fails early).
					.filterNot { !it.fromMe && !it.isPeer && it.status == "waking" }
					.map { if (it.fromMe && it.status == "pending" && it.opId == null) it.copy(status = "error") else it }
				merged.getOrPut(canonicalKey) { mutableListOf() }.addAll(loaded)
			}
			// id is not persisted; assign a dense per-thread id by time order AFTER any
			// merge, so it stays unique within the (possibly merged) thread.
			merged.mapValues { (_, msgs) -> msgs.sortedBy { it.at }.mapIndexed { i, m -> m.copy(id = i.toLong()) } }
		}.getOrDefault(emptyMap())
	}

	private fun loadFiles(m: JSONObject): List<MessageFile> {
		val arr = m.optJSONArray("files") ?: return emptyList()
		return (0 until arr.length()).map {
			val f = arr.getJSONObject(it)
			MessageFile(f.optString("name"), f.optString("mime"), f.optString("src").takeIf { s -> s.isNotEmpty() })
		}
	}

	private fun persistLabels(labels: Map<String, String>) {
		val root = JSONObject()
		for ((team, name) in labels) root.put(team, name)
		runCatching { store.saveLabels(root.toString()) }
	}

	private fun loadPersistedLabels(): Map<String, String> {
		val json = store.loadLabels() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			buildMap {
				for (rawKey in root.keys()) {
					if (!isAddressKey(rawKey)) continue
					put(rawKey, root.getString(rawKey))
				}
			}
		}.getOrDefault(emptyMap())
	}

	private fun persistAbsenceStreaks(streak: Map<String, Int>) {
		val root = JSONObject()
		for ((team, count) in streak) root.put(team, count)
		runCatching { store.saveAbsenceStreaks(root.toString()) }
	}

	private fun loadPersistedAbsenceStreaks(): Map<String, Int> {
		val json = store.loadAbsenceStreaks() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			buildMap {
				for (rawKey in root.keys()) {
					if (!isAddressKey(rawKey)) continue
					put(rawKey, root.optInt(rawKey, 0))
				}
			}
		}.getOrDefault(emptyMap())
	}

	private fun persistDrafts() {
		val root = JSONObject()
		for ((team, text) in drafts) root.put(team, text)
		runCatching { store.saveDrafts(root.toString()) }
	}

	private fun loadPersistedDrafts(): MutableMap<String, String> {
		val json = store.loadDrafts() ?: return mutableMapOf()
		return runCatching {
			val root = JSONObject(json)
			val out = mutableMapOf<String, String>()
			for (rawKey in root.keys()) {
				if (!isAddressKey(rawKey)) continue
				out[rawKey] = root.getString(rawKey)
			}
			out
		}.getOrDefault(mutableMapOf())
	}

	private companion object {
		const val POLL_INTERVAL_MS = 5_000L
		// AFK cadence: one plain poll a minute drains the accumulated burst.
		const val AFK_POLL_INTERVAL_MS = 60_000L
		// Visible cadence: server-held long-poll (under the gateway's 45s cap).
		const val LONG_POLL_HOLD_MS = 40_000L
		// Refresh the team list at most this often, regardless of poll cadence.
		const val TEAMS_REFRESH_MS = 30_000L
		// Matches the gateway's own per-payload bucket (MAX_RESPONSE_FILE_BYTES); a single
		// attachment may use the whole bucket, so this is a total, not a stricter per-file cap.
		const val MAX_OUTGOING_BYTES = 500_000_000
	}
}
