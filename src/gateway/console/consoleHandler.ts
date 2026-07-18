import type { DomainSnapshot } from "../../shared/admission.js";
import type {
	ConsoleOp,
	ConsoleOpResult,
	ConsoleReplyBody,
	CrossDomainConfirmResult,
	CrossDomainListenResult,
	CrossDomainListenStateResult,
	CrossDomainListPeersResult,
	CrossDomainListSharesResult,
	CrossDomainPeerEntry,
	CrossDomainRequestResult,
	CrossDomainShareTarget,
	CrossDomainUnlinkResult,
	MailboxInput,
	OpenedConsoleFrame,
	ReadAnchorWireEntry,
} from "../../shared/console-protocol.js";
import type { DeviceMailboxStore } from "../../shared/device-mailbox.js";
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import {
	ALLOWED_KEYS,
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	isReservedHostSession,
	isShellSafeName,
	isTmuxName,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { PlaneRegistry, PlaneVersion } from "../../shared/plane-registry.js";
import { DomainStatusSchema, MAX_POLL_HOLD_MS } from "../../shared/schemas.js";
import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	LOCAL_DOMAIN_SENTINEL,
	parseSessionName,
	parseTarget,
	SpawnPoint,
	storeKey,
} from "../../shared/session-id.js";
import { type SessionRecord, type SessionStore, sanitizeLabel } from "../../shared/session-store.js";
import type { TeamInfo } from "../../shared/types.js";
import type { IntentTracker } from "../intent.js";
import { type ReadAnchors, readAnchorsPlaneName } from "../readAnchors.js";
import type { WakeResult } from "../wake.js";
import { type ConversationRegistry, RESERVED_TEAM_NAMES, type TeamRegistry } from "../websocket.js";
import { ConsolePeer } from "./consolePeer.js";

////////////////////////////////
//  Functions & Helpers

// An ABSENT peek (pane booting, just exited, or stopped) gets a calm lead in place of raw stderr,
// with the original cause appended so a PERMANENT absence (dead agent, removed container) stays
// diagnosable instead of reading as "still starting" forever. The absent-vs-failure decision is
// made at the host (classifyPeekError); a real failure (timeout, offline host) passes through.
function friendlyPeekError(error?: string, kind?: HostOpResult["errorKind"]): string {
	const raw = error ?? "peek failed";
	if (kind === "absent") return `No session running - it may be starting or has stopped: ${raw}`;
	return raw;
}

// Marks a create_session failure as an ambiguous host-op outcome (a timeout or a disconnect, never a
// host-reported result) rather than a definitive one, so the catch-all rollback around it knows not
// to forget a record whose launch may still be running.
class CreateSessionAmbiguousError extends Error {}

////////////////////////////////
//  Interfaces & Types

/** The subset of gateway HTTP routes the console handler reuses. */
export interface ConsoleRoutes {
	send: (req: Request, body: Record<string, unknown>, opts?: { consoleSender?: boolean }) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>, opts?: { consoleSender?: boolean }) => Response;
	teams: () => Response;
	// Mesh-wide team list (local + every online peer Gateway). A console roams all Gateways.
	discover: () => Promise<Response>;
}

/** The JSON body shape returned by routes.send, shared by the in-time and backgrounded
 * read sites so they cannot drift. A channelOnly send never produces an inline response
 * body: success is always the deterministic channel session, the answer arrives via
 * response_push. */
interface SendRouteJson {
	session_id?: string;
	status?: string;
	error?: string;
}

export interface ConsoleHandlerDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	mailboxStore: DeviceMailboxStore;
	routes: ConsoleRoutes;
	/** This Gateway's id, returned on register so the console anchors its composite
	 * (gatewayId, name) key, and used to canonicalize a send target to the qualified
	 * session-id form (matching routes.send). */
	localGatewayId: string;
	localDomainId: string;
	sendBoundMs?: number;
	createSessionBoundMs?: number;
	/** True when the name belongs to a devcontainer project. A device must not take such a
	 * name: while the project sleeps, the console's virtual peer would squat the registry slot,
	 * absorb sends meant for the project, and suppress its wake. */
	isProjectName?: (name: string) => boolean;
	/** Drop a session's durable resume record (the console's Forget), so it stops listing as
	 * an available asleep session. */
	dropSessionResume?: (team: string) => void;
	/** Session access. create_session mints/adopts a record here (the minted id is the tmux session
	 * name); rename_session relabels one; forget drops one. Production wires the presence facade
	 * (so these writes announce themselves on the presence plane); a narrow Pick, not the full
	 * SessionStore class, so either satisfies it structurally. Absent in harnesses with no store. */
	sessionStore?: Pick<
		SessionStore,
		"getByTeam" | "teamOf" | "adoptOrReattach" | "mintOrReattach" | "hostWorkdirHint" | "forget" | "rename"
	>;
	/** The current keyring + its version hash. The poll reply carries the snapshot only when
	 * the Console's known version differs. */
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	/** This Gateway's own Domain lifecycle status, learned from evie's register reply, and
	 * returned on the console register. A Gateway exists only for a Domain past rooting, so this
	 * is "rooted" (or "unrooted" for a fresh admin Domain) and never "pending" (the pending case
	 * reaches the app via the provisioning blob's pendingTenant). Undefined against a pre-feature
	 * evie, where the app treats the Domain as already rooted. */
	domainStatus?: () => string | undefined;
	/** The versioned-state-plane registry: the poll op races `waitForBump` alongside the mailbox's
	 * own `waitForAppend`, and piggybacks the presence plane's snapshot onto the reply when the
	 * Console's `knownPresenceVersions` is behind - the same shape as the `domain`/`domainStatus`
	 * piggyback above, generalized. Absent when presence is not wired (the poll then behaves
	 * exactly as before: no second wait primitive, no presence field ever attached). */
	planeRegistry?: PlaneRegistry;
	/** Read access to the presence plane's current rows, for the poll piggyback. A narrow seam
	 * (matching routes.ts's own `presence` dep) rather than importing PresenceFacade directly. */
	presence?: { snapshot(): TeamInfo[] };
	/** Resolves each device's peek cadence from the union of every device's declared focus. The
	 * poll op declares (refreshes) the calling device's intent here whenever the op carries a
	 * `focus` field. Absent when presence/intent is not wired (a poll's `focus` is then just
	 * ignored, matching today's behavior for a Gateway with no daemon derivation). */
	intentTracker?: IntentTracker;
	/** Per-owner cross-device read-position sync (see readAnchors.ts's own doc): `report_read`
	 * writes through here, and the poll case reads/piggybacks this OWNER's own plane (never
	 * another owner's). Absent when not wired (report_read then errors; the poll piggyback is
	 * simply skipped, matching every other plane's own opt-in shape). */
	readAnchors?: ReadAnchors;
	/** Relay a tmux op to the local host daemon and await its reply. Drives the console terminal
	 * view; absent when no host daemon is wired (the op then errors "terminal unavailable"). */
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	/** Wake a team (the same trigger send() uses for an asleep target), bringing up a devcontainer's
	 * cold container if needed. create_session uses this instead of relayToHost for a devcontainer
	 * target, since only this path brings the container up first. Absent when no host daemon is
	 * wired (create_session then falls back to relayToHost, which will fail against a cold container -
	 * matching what happens today without this dependency). */
	tryWakeTeam?: (team: string) => Promise<WakeResult>;
	/** Whether a wake is currently in flight for a composite team. `close_session` consults it to
	 * refuse a close mid-wake (which would no-op then resurrect once the wake registers). Absent when
	 * no wake path is wired; a close then proceeds unguarded (matching today's behavior). */
	isWakeInFlight?: (team: string) => boolean;
	/** Mark a team's launch in flight for `isWakeInFlight`'s duration, covering `create_session`'s
	 * relayToHost branch (a host target, or any target with no tryWakeTeam wired), which never touches
	 * the tryWakeTeam/inflightWakes bookkeeping. Without this, teams() has no signal between "launch
	 * requested" and "MCP registered" for that branch, so a slow-to-register host session (tmux up,
	 * Claude CLI still starting) reads as plain "available" instead of "verifying" for that whole gap.
	 * Returns a release function; absent when no wake path is wired (matching today's unguarded case). */
	markCreateInFlight?: (team: string) => () => void;
	/** Wait for a team's actual MCP registration (or a bounded timeout), independent of any container
	 * bring-up. `create_session`'s relayToHost (host) branch uses this to keep `markCreateInFlight`'s
	 * release pending through the real "Claude CLI still starting" gap instead of releasing the moment
	 * the tmux pane itself spawns - the devcontainer branch gets the same coverage for free, since
	 * tryWakeTeam already awaits registration internally before its own promise settles. Absent when no
	 * wake path is wired (create_session then falls back to releasing at tmux-spawn time, as before). */
	awaitRegister?: (team: string) => Promise<WakeResult>;
	/** The cross-Domain listening-mode handshake coordinator. Absent when federation is not
	 * wired (the cross_domain_* ops then error "not available"). The console drives the mutual
	 * pairing; the gateway owns the listening window and writes the peer. */
	crossDomain?: CrossDomainConsoleHandlers;
	/** The per-session share manager. Absent when federation is not wired. Backed by the
	 * gateway's CrossDomainShareState store; `isLinkedDomain` reads the cross-Domain peer set
	 * so a share can only target a Domain the owner has actually linked. */
	crossDomainShare?: CrossDomainShareHandlers;
	/** Drop all local trust + share state for a linked friend Domain: forget every peer gateway
	 * of the Domain, every share offered to it, and settle any in-flight job bound to it, then
	 * return the counts. Idempotent (an already-unlinked Domain returns zero counts). Absent when
	 * federation is not wired. The Router-side relay-edge revocation is the phone's separate
	 * owner-signed submit, not this gateway-local cleanup. */
	unlinkDomain?: (domainId: string) => CrossDomainUnlinkResult;
	/** Untrust a person by owner key: the owner-keyed sibling of unlinkDomain. Forgets every peer
	 * Gateway owned by that owner across all their Domains, then drops the shares and settles the
	 * in-flight jobs for those Domains, returning the summed counts. Idempotent. Absent when
	 * federation is not wired. */
	untrustOwner?: (ownerSignPub: string) => CrossDomainUnlinkResult;
}

/** The subset of the cross-Domain handshake coordinator the console handler drives. A
 * narrow seam so the handler stays mockable and never imports the coordinator class. */
export interface CrossDomainConsoleHandlers {
	listen: () => CrossDomainListenResult;
	request: (args: {
		listeningToken: string;
		pin: string;
		requesterOwnerSignPub: string;
		requesterDomainId: string;
		requesterGatewayId: string;
	}) => Promise<CrossDomainRequestResult>;
	confirm: (args: { pin: string; mySignedLink: SignedXDomainLink }) => CrossDomainConfirmResult;
	cancel: (args: { listeningToken?: string; pin?: string }) => boolean;
	/** Receiver read of the listening window's pairing state (the SAS and the friend keys).
	 * Read-only, so it does not consume the window. */
	listenState: (listeningToken: string) => CrossDomainListenStateResult;
	/** The linked friend Domains, projected to `(domainId, gatewayId)` per peer. A peer is listed
	 * once linked regardless of online or shared-back state, so a freshly-linked peer is visible
	 * before any session crosses. */
	listPeers: () => CrossDomainListPeersResult;
}

/** The subset of the per-session share state the console handler drives. A narrow seam
 * so the handler stays mockable and never imports the store class. `sessionTarget` is the
 * canonical `domain.gateway.spawn.session` of a LOCAL session; `domainId` is a linked friend Domain. */
export interface CrossDomainShareHandlers {
	share: (sessionTarget: string, target: CrossDomainShareTarget) => void;
	/** Withdraw a session's share from an audience, returning whether a record was removed
	 * (so the handler only expires in-flight jobs when the share actually changed). */
	unshare: (sessionTarget: string, target: CrossDomainShareTarget) => boolean;
	listShares: () => CrossDomainListSharesResult["shares"];
	/** Settle any in-flight cross-Domain job after a withdrawn share, so an already-accepted send's
	 * reply stops at the destination instead of forwarding back to the origin. Targets the one
	 * Domain for a specific-Domain share, or every currently-linked Domain for an everyone-trusted
	 * share. Called after a successful unshare. */
	expireSessionJobsForTarget: (sessionTarget: string, target: CrossDomainShareTarget) => void;
	/** Whether the owner has a linked cross-Domain peer in this Domain (a specific-Domain share can
	 * only target a linked Domain). */
	isLinkedDomain: (domainId: string) => boolean;
}

////////////////////////////////
//  Functions & Helpers

const FAKE_REQ = new Request("http://gateway/console");

// Bound on how long a console send op may block inside the relay. The gateway's wake path can
// hold /send for up to WAKE_TIMEOUT_MS (10 min), far past evie's opId hold. Past this bound the
// op returns the deterministic session id and the wake/send continues in the background, the
// answer landing in the mailbox via the persistent conversation. The Android console's own
// PINNED_READ_TIMEOUT_MS (ConsoleClient.kt) must outlast this - pinned by
// ChatRepositoryConstantsTest.kt, update both sides together.
const SEND_BOUND_MS = 25_000;

// Same reasoning and ceiling as SEND_BOUND_MS, for create_session's devcontainer-wake launch (which
// can likewise run for up to WAKE_TIMEOUT_MS cold-starting a container). Past this bound the op
// returns the already-adopted session id with status "pending" and the launch continues in the
// background; a backgrounded failure rolls the record back with no push, so its tile simply drops off
// the console's board on the next teams() refresh rather than needing a push-delivery mechanism.
// The Android console's own retry-reattach window (ChatRepository.kt: SPAWN_RETRY_WINDOW_MS) must
// stay comfortably past this - pinned by consoleHandler.test.ts, update both sides together.
// Exported only so that test can read the real value.
export const CREATE_SESSION_BOUND_MS = 25_000;

// The real gate is schemas.ts's MAX_POLL_HOLD_MS (the zod .max() rejects a larger holdMs
// outright); this Math.min is a harmless second layer, never actually truncating a schema-valid
// value. Must clear the relay chain with headroom: evie holds the console's HTTP request 55s and
// the apiserver proxy allows 60s (ConsoleClient.PROXY_CEILING_MS). The Android console's own
// LONG_POLL_HOLD_MS must stay at or under MAX_POLL_HOLD_MS - pinned by consoleHandler.test.ts
// and ChatRepositoryConstantsTest.kt, update all sides together.
const HOLD_CAP_MS = MAX_POLL_HOLD_MS;

// At-most-once side effects: the console->evie->gateway path is at-least-once (a lost reply makes
// the console retry the same opId), so a seen opId replays its cached reply instead of re-running
// the op (which would duplicate a channel_push / response_push). Only mutating ops are cached,
// only on success, and the cache is keyed per conversation so one install cannot evict or read
// another's entry.
const MAX_OPS_PER_CONVERSATION = 256;

function isMutatingOp(op: ConsoleOp): boolean {
	// Ops with a side effect are cached so a retried opId replays the cached reply rather than
	// re-running: tmux_send re-injecting keys, create_session/reload_plugins re-launching, the
	// cross_domain_* handshake ops minting a second window or re-routing or re-writing a peer,
	// share/unshare re-mutating the store, unlink re-running cleanup and reporting zero. The reads
	// (peek, cross_domain_listen_state, list_shares, list_peers) run live and are never cached.
	return (
		op.kind === "send" ||
		op.kind === "respond" ||
		op.kind === "tmux_send" ||
		op.kind === "create_session" ||
		op.kind === "reload_plugins" ||
		op.kind === "forget" ||
		op.kind === "close_session" ||
		op.kind === "rename_session" ||
		op.kind === "cross_domain_listen" ||
		op.kind === "cross_domain_request" ||
		op.kind === "cross_domain_confirm" ||
		op.kind === "cross_domain_cancel" ||
		op.kind === "cross_domain_share" ||
		op.kind === "cross_domain_unshare" ||
		op.kind === "cross_domain_unlink" ||
		op.kind === "cross_domain_untrust"
	);
}

export function createConsoleDispatcher({
	registry,
	conversationRegistry,
	mailboxStore,
	routes,
	localGatewayId,
	localDomainId,
	sendBoundMs = SEND_BOUND_MS,
	createSessionBoundMs = CREATE_SESSION_BOUND_MS,
	isProjectName,
	dropSessionResume,
	sessionStore,
	domain,
	domainStatus,
	planeRegistry,
	presence,
	intentTracker,
	readAnchors,
	relayToHost,
	tryWakeTeam,
	isWakeInFlight,
	markCreateInFlight,
	awaitRegister,
	crossDomain,
	crossDomainShare,
	unlinkDomain,
	untrustOwner,
}: ConsoleHandlerDeps) {
	// The local Domain segment for every canonical address we mint here. Null (arming mode) maps to
	// the sentinel, so a key still forms.
	const localDomain = localDomainId || LOCAL_DOMAIN_SENTINEL;

	/** The canonical Address of a LOCAL session by its team field - the form the share state and the
	 * pending-job store key by (identical to routes' localAddress and the relay gate's, so a console
	 * share key matches the gate byte-for-byte). */
	function localAddress(name: string): Address {
		const { project, session } = parseSessionName(name);
		return Address.local(localDomain, localGatewayId, project, session);
	}

	/** Resolve a console terminal target to the host tmux it maps to. The target is a local team
	 * field (`spawn` -> default session, or `spawn.session`) or its fully-qualified Address;
	 * `explicitSession` (create_session) overrides the derived session. A cross-Gateway target or an
	 * unknown/loose name is rejected. The grammar is dotless, so a session segment is unambiguous -
	 * no catalog dot-disambiguation. */
	function resolveTmuxTarget(qualifiedTarget: string, explicitSession?: string): TmuxTarget {
		const t = parseTarget(qualifiedTarget, localDomain, localGatewayId);
		if (t.domain !== localDomain || t.gateway !== localGatewayId) {
			throw new Error(`terminal view is not available for a session on another Gateway`);
		}
		const project = t.spawn;
		const sessionName = explicitSession ?? (t instanceof SpawnPoint ? DEFAULT_SESSION : t.session);
		let target: TmuxTarget;
		if (project === "host") {
			if (isReservedHostSession(sessionName)) throw new Error(`"${sessionName}" is a reserved host session`);
			target = { kind: "host", name: "host", sessionName };
		} else if (isProjectName?.(project)) target = { kind: "devcontainer", name: project, sessionName };
		else throw new Error(`terminal view is not available for "${project}" (only the host and devcontainers)`);
		// Both name and session reach the host's shell launch command; the grammar makes both strict
		// dotless slugs, so assert it at the boundary regardless (defense in depth).
		if (!isShellSafeName(target.name)) throw new Error(`invalid project name "${target.name}"`);
		if (!isTmuxName(target.sessionName)) throw new Error(`invalid session name "${target.sessionName}"`);
		return target;
	}

	/** Reject a terminal-DRIVE op (peek/tmux_send/reload) against a record whose live incarnation is
	 * an alias (a user-launched `claude --resume` under a different name): there is no daemon pane at
	 * `spawn.id` to drive. Card ops (forget, close_session) and create are exempt - they proceed
	 * regardless. */
	function assertDaemonDrivable(target: TmuxTarget): void {
		const record = sessionStore?.getByTeam(composeSessionName(target.name, target.sessionName));
		if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
			throw new Error(`terminal view unavailable for a user-launched session; end it from your terminal`);
		}
	}
	// The per-install conversationId is the device identity: it keys the registry sub, the
	// signing-key binding, the idempotency cache, and the device-name binding. The mailbox is
	// keyed by owner (below), so an owner's devices share one inbox while each keeps its own
	// registry slot and key binding.
	const bindings = new Map<string, string>();
	// conversationId -> the console signing key bound to that install. A frame whose signerSignPub
	// differs from the binding cannot operate this conversation, so a console cannot poll or settle
	// another install's mailbox by borrowing its conversationId. A register op may rebind.
	const signers = new Map<string, string>();
	// conversationId -> (opId -> in-flight/settled reply body) for mutating-op idempotency.
	const opCache = new Map<string, Map<string, Promise<ConsoleReplyBody>>>();
	// conversationId -> ownerId, and ownerId -> its device conversationIds. The mailbox store is
	// keyed by ownerId, so these map a device to its shared owner inbox and let teardown release
	// the inbox only when the owner's last device is gone.
	const deviceOwner = new Map<string, string>();
	const ownerDevices = new Map<string, Set<string>>();

	// When the store evicts an owner inbox (idle sweep or cap), tear down every device peer that
	// shared it. The box is already gone, so this only clears device-side state.
	mailboxStore.setOnEvict((ownerId) => {
		for (const conversationId of [...(ownerDevices.get(ownerId) ?? [])]) teardownDevice(conversationId);
	});

	function recordInbound(ownerId: string, sessionId: string): void {
		// The session id is the opaque store key the console echoes; under the fully-qualified
		// grammar there is no bare form to normalize. Recorded on the durable owner inbox so
		// respondability survives a restart.
		mailboxStore.get(ownerId)?.recordSession(sessionId);
	}

	/** Append only if the device is still live, so a late continuation cannot
	 * resurrect a torn-down install. Routes to the owner inbox the device shares;
	 * gated on device liveness, so a rename (same conversation) still delivers. */
	function appendIfLive(conversationId: string, entry: MailboxInput, dedupeKey?: string): void {
		const ownerId = deviceOwner.get(conversationId);
		if (!ownerId || !bindings.has(conversationId)) return;
		mailboxStore.get(ownerId)?.append(entry, dedupeKey);
	}

	function assertValidIdentity(device: string, conversationId: string): void {
		if (RESERVED_TEAM_NAMES.has(device)) {
			throw new Error(`"${device}" is a reserved name; pick another device name`);
		}
		if (isProjectName?.(device)) {
			throw new Error(`"${device}" is a project on the bridge; pick another device name`);
		}
		const bound = bindings.get(conversationId);
		if (bound && bound !== device) {
			throw new Error(`This install is bound to device name "${bound}"; send a register op to rename`);
		}
		const conversationHolder = conversationRegistry.get(conversationId);
		if (conversationHolder && !conversationHolder.data.virtual) {
			throw new Error(`conversationId is in use by a live bridge connection`);
		}
		const subs = registry.get(device);
		if (subs) {
			for (const [, ws] of subs) {
				if (!ws.data.virtual) {
					throw new Error(`"${device}" is an existing team name; pick another device name`);
				}
			}
		}
	}

	function ensurePeer(
		device: string,
		conversationId: string,
		signerSignPub: string,
		ownerId: string,
		allowRebind = false,
	): ConsolePeer {
		// A register op may rename the device: migrate the registry sub off the old name (the
		// owner inbox and binding carry over) before the identity checks see the stale binding.
		const bound = bindings.get(conversationId);
		if (allowRebind && bound && bound !== device) {
			const oldSubs = registry.get(bound);
			const oldSub = oldSubs?.get(conversationId);
			if (oldSub?.data.virtual) {
				oldSubs?.delete(conversationId);
				if (oldSubs?.size === 0) registry.delete(bound);
			}
			bindings.delete(conversationId);
		}

		// Cryptographic install binding: the conversation is owned by the first signing key seen
		// for it; a later frame with a different key is rejected unless this is a re-enrolling
		// register. Blocks a console from operating another install's mailbox by borrowing its
		// conversationId.
		const boundSigner = signers.get(conversationId);
		if (boundSigner && boundSigner !== signerSignPub && !allowRebind) {
			throw new Error(`conversationId is bound to a different device key`);
		}

		assertValidIdentity(device, conversationId);
		mailboxStore.ensure(ownerId);
		signers.set(conversationId, signerSignPub);
		deviceOwner.set(conversationId, ownerId);
		let siblings = ownerDevices.get(ownerId);
		if (!siblings) {
			siblings = new Set();
			ownerDevices.set(ownerId, siblings);
		}
		siblings.add(conversationId);

		let subs = registry.get(device);
		if (!subs) {
			subs = new Map();
			registry.set(device, subs);
		}

		const existing = subs.get(conversationId) as unknown as ConsolePeer | undefined;
		if (existing) {
			existing.data.isStale = false;
			// Self-heal the conversation pointer if a since-closed real socket displaced it.
			conversationRegistry.set(conversationId, existing.asWs());
			return existing;
		}

		const peer = new ConsolePeer(
			// While the device is live, re-create an evicted box so deliveries survive a store
			// sweep; once torn down, return undefined so a late push cannot resurrect an owner
			// inbox the index no longer tracks.
			() => (bindings.has(conversationId) ? mailboxStore.ensure(ownerId) : undefined),
			device,
			conversationId,
			conversationId,
			(sessionId) => recordInbound(ownerId, sessionId),
		);
		subs.set(conversationId, peer.asWs());
		conversationRegistry.set(conversationId, peer.asWs());
		bindings.set(conversationId, device);
		return peer;
	}

	// Tear down a single device's peer state (registry sub, bindings, key, idempotency
	// cache, conversation pointer, owner index). Does NOT touch the shared owner inbox;
	// removePeer and the evict callback own the inbox lifecycle.
	function teardownDevice(conversationId: string): void {
		const device = bindings.get(conversationId);
		bindings.delete(conversationId);
		signers.delete(conversationId);
		opCache.delete(conversationId);

		const ownerId = deviceOwner.get(conversationId);
		deviceOwner.delete(conversationId);
		if (ownerId) {
			const siblings = ownerDevices.get(ownerId);
			siblings?.delete(conversationId);
			if (siblings && siblings.size === 0) ownerDevices.delete(ownerId);
		}

		const conversationWs = conversationRegistry.get(conversationId);
		if (conversationWs?.data.virtual) {
			conversationRegistry.delete(conversationId);
		}

		if (!device) return;
		const subs = registry.get(device);
		if (!subs) return;

		// Remove only this install's virtual sub; never evict a co-resident real team's sockets.
		// The team entry goes only when nothing remains.
		const sub = subs.get(conversationId);
		if (sub?.data.virtual) {
			subs.delete(conversationId);
		}
		if (subs.size === 0) {
			registry.delete(device);
		}
	}

	function removePeer(conversationId: string): void {
		const ownerId = deviceOwner.get(conversationId);
		teardownDevice(conversationId);
		if (ownerId) {
			// Release this device's watermark from the shared inbox, and delete the inbox only
			// once its last device is gone (teardownDevice drops the entry).
			mailboxStore.get(ownerId)?.forgetConsumer(conversationId);
			if (!ownerDevices.has(ownerId)) mailboxStore.delete(ownerId);
		}
	}

	async function dispatch(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		ownerId: string,
		opId: string,
		ownerSignPub: string,
	): Promise<ConsoleOpResult> {
		switch (op.kind) {
			case "register": {
				const box = mailboxStore.ensure(ownerId);
				console.log(
					`[console register] conv=${conversationId.slice(0, 12)} owner=${ownerId.slice(0, 12)} dev=${device} build=${op.clientVersion ?? "?"}/${op.clientVariant ?? "?"} -> cursor=${box.highWater} epoch=${box.epoch}`,
				);
				// Validate the evie-sourced Domain status against the closed union so a garbage
				// value is dropped, not forwarded. Omitted when unknown (pre-feature evie), so the
				// app falls back to the already-rooted path. The value is "rooted" or "unrooted"
				// (a fresh admin Domain), never "pending" (the app learns that from the
				// provisioning blob's pendingTenant and first-roots directly at evie).
				const status = DomainStatusSchema.safeParse(domainStatus?.());
				return {
					device,
					gatewayId: localGatewayId,
					cursor: box.highWater,
					epoch: box.epoch,
					...(status.success ? { domainStatus: status.data } : {}),
				};
			}

			case "first_root": {
				// first_root is decided at evie, never on a Gateway: a pending friend Domain has no
				// Gateway yet, and the pre-root console has no admission, so the self-signed frame
				// cannot even open here (the consoleSealer requires an admitted kind:console). The
				// app POSTs the SignedFirstRoot directly to evie's console bridge. Reject explicitly
				// so a misrouted frame fails clear rather than falling through.
				throw new Error("first_root is handled directly at evie, not through a Gateway");
			}

			case "list_teams": {
				// Fan out across the mesh so the console sees every Gateway's sessions, each
				// carrying its own `gatewayId` (the console keys threads by domain.gateway.spawn.session).
				const teams = (await (await routes.discover()).json()) as TeamInfo[];
				// A console does not list other consoles as send targets, and excludes itself.
				// teams() already drops the headless "host" daemon.
				return {
					teams: teams.filter((t) => t.team !== device && t.kind !== "console"),
				};
			}

			case "send": {
				// Canonical session id matching what routes.send composes, so the backgrounded-send
				// path hands back the same id the in-time path would. The target resolves to its
				// Address; keyed by ownerId, so every device of the owner shares the one thread. A
				// spawn-point target has no session (routes rejects it), so it has no pre-computed id.
				const targetAddr = parseTarget(op.to, localDomain, localGatewayId);
				const expectedSession =
					targetAddr instanceof SpawnPoint
						? ""
						: storeKey({ kind: "conv", conversationId: ownerId, address: targetAddr });
				const sendPromise = routes.send(
					FAKE_REQ,
					{
						from: device,
						fromConversationId: ownerId,
						to: op.to,
						// Forward the selected session's Domain so a cross-Domain send resolves its seal
						// target by the full (domainId, gatewayId) pair; absent for a local/cross-Gateway send.
						targetDomainId: op.domainId,
						body: op.body,
						files: op.files,
						channelOnly: true,
					},
					// The console's `from` is a free-form Device Name (not a slug); consoleSender makes
					// routes.send build the sender address from the owner id, not localAddress(from).
					{ consoleSender: true },
				);

				let boundTimer: ReturnType<typeof setTimeout> | undefined;
				const bound = new Promise<null>((resolve) => {
					boundTimer = setTimeout(() => resolve(null), sendBoundMs);
				});
				const winner = await Promise.race([sendPromise, bound]);
				clearTimeout(boundTimer);

				if (winner === null) {
					// Wake still in progress; hand back the deterministic channel job key now.
					// channelOnly guarantees a successful send is always the deterministic channel
					// session (the answer arrives later via response_push), so the continuation only
					// has to surface a backgrounded failure as an error reply. appendIfLive drops a
					// since-evicted conversation cleanly.
					void sendPromise
						.then(async (res) => {
							if (res.ok) {
								// Backgrounded success: mirror the sent message like the in-time path.
								appendIfLive(
									conversationId,
									{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
									`sent:${conversationId}:${opId}`,
								);
								return;
							}
							const json = (await res.json().catch(() => ({}))) as SendRouteJson;
							appendIfLive(conversationId, {
								kind: "reply",
								session_id: expectedSession,
								status: "error",
								body: json.error ?? `send to "${op.to}" failed`,
							});
						})
						.catch(() => {});
					return { session_id: expectedSession, status: "running" };
				}

				const json = (await winner.json()) as SendRouteJson;
				if (!winner.ok) throw new Error(json.error ?? "send failed");
				// Mirror the owner's own outgoing message to all their devices. The sender
				// reconciles it against its optimistic row by opId; the owner's other devices render
				// it under the same thread. The dedupeKey keeps the echo idempotent across a gateway
				// restart (the persisted seenKeys absorbs a reconcile re-send of the same opId).
				appendIfLive(
					conversationId,
					{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
					`sent:${conversationId}:${opId}`,
				);
				return { session_id: json.session_id ?? "", status: json.status ?? "running" };
			}

			case "respond": {
				// A console may only settle a thread that was delivered to it. This blocks forging
				// another conversation's reply and keeps op.session_id away from resolveHandshake
				// (handshake ids are never recorded as inbound). The session id is the opaque store
				// key the console echoes verbatim - no bare form to normalize under this grammar.
				if (!mailboxStore.get(ownerId)?.canRespond(op.session_id)) {
					throw new Error(`Unknown session_id; you can only respond to a thread delivered to you`);
				}
				const res = routes.respond(
					FAKE_REQ,
					{
						session_id: op.session_id,
						status: op.status,
						response: op.response,
						replyAsJson: op.replyAsJson,
						files: op.files,
					},
					// The console is a human replying via the app, never an agent; the mirror tap
					// reads this to skip agent-to-agent peer mirroring for this reply.
					{ consoleSender: true },
				);
				const json = (await res.json()) as { error?: string };
				if (!res.ok) throw new Error(json.error ?? "respond failed");
				return { delivered: true };
			}

			case "poll": {
				// Declare (refresh) this device's focus intent so the daemon's derivation cadence can
				// ramp to what is actually being watched. A poll with no focus (a legacy console, or
				// one between declarations) leaves any existing declaration to expire on its own TTL
				// rather than clearing it early - see IntentTracker's own doc.
				if (op.focus) intentTracker?.declare(conversationId, op.focus);

				// Long-poll: an empty drain holds the op open (bounded under the relay-chain
				// timeouts) until an append or a presence bump wakes it, then drains/rechecks again.
				// The pump runs frames concurrently, so a held poll blocks nothing, and retried polls
				// just become additional waiters (reads are not opId-cached; the console dedupes
				// entries by seq).
				const box = mailboxStore.ensure(ownerId);
				let snap = box.drain(op.cursor ?? 0, op.epoch, conversationId);
				const hold = Math.min(op.holdMs ?? 0, HOLD_CAP_MS);

				// The presence plane version(s) the Console already holds, translated from the wire's
				// per-source-gateway array to the registry's plane-name-keyed presented map. Only this
				// Gateway's own entry maps to a locally-registered plane, since only this Gateway's own
				// federation exchange is registered here; a foreign/unrecognized source is simply absent from the
				// map, which changedSince/waitForBump both already treat as "unknown, ship current
				// truth" rather than a special case here. Absent knownPresenceVersions (a pre-plane
				// console build) skips the registry entirely - unchanged behavior for that build,
				// mirroring the domainVersion piggyback's own opt-in shape. `presenceScope` is what
				// actually enforces that opt-out now that a second plane (linked-peers) shares this
				// same registry: without it, changedSince's bulk "every registered plane" walk would
				// report "presence" as changed for a caller who never even mentioned it (see
				// PlaneRegistry.changedSince's own doc on why scope exists).
				const pr = op.knownPresenceVersions ? planeRegistry : undefined;
				const presenceScope = pr ? new Set(["presence"]) : undefined;
				const presentedPresence = new Map<string, PlaneVersion>();
				if (pr) {
					const own = op.knownPresenceVersions?.find((v) => v.gateway === localGatewayId);
					if (own) presentedPresence.set("presence", { epoch: own.epoch, counter: own.version });
				}

				// The linked-peers plane: same registry, a single scalar presented version (no
				// per-source array - this Gateway's own roster has no multi-source concept). Unlike
				// presence's array, a single optional scalar cannot distinguish "a console build that
				// never sends knownLinkedPeersVersion" from "this session's cold boot" - both simply
				// present nothing, and both
				// want the same outcome (ship current), so this always participates whenever the
				// registry itself is wired, never gated on the op field's own presence.
				const lpr = planeRegistry;
				const linkedPeersScope = lpr ? new Set(["linked-peers"]) : undefined;
				const presentedLinkedPeers = new Map<string, PlaneVersion>();
				if (lpr && op.knownLinkedPeersVersion) {
					presentedLinkedPeers.set("linked-peers", {
						epoch: op.knownLinkedPeersVersion.epoch,
						counter: op.knownLinkedPeersVersion.version,
					});
				}

				// This owner's read-anchors plane: PER OWNER (never a single Gateway-wide plane - see
				// readAnchors.ts), registered lazily here on this owner's own first poll if it has not
				// been touched yet (ensureRegistered is idempotent). Same single-scalar shape as
				// linked-peers, same unconditional participation.
				const rar = readAnchors ? planeRegistry : undefined;
				const readAnchorsPlane = readAnchorsPlaneName(ownerId);
				const readAnchorsScope = rar ? new Set([readAnchorsPlane]) : undefined;
				const presentedReadAnchors = new Map<string, PlaneVersion>();
				if (rar) {
					readAnchors?.ensureRegistered(ownerId);
					if (op.knownReadAnchorsVersion) {
						presentedReadAnchors.set(readAnchorsPlane, {
							epoch: op.knownReadAnchorsVersion.epoch,
							counter: op.knownReadAnchorsVersion.version,
						});
					}
				}

				if (snap.entries.length === 0 && hold > 0) {
					const waits: Promise<unknown>[] = [box.waitForAppend(hold)];
					if (pr) waits.push(pr.waitForBump(presentedPresence, hold, presenceScope));
					if (lpr) waits.push(lpr.waitForBump(presentedLinkedPeers, hold, linkedPeersScope));
					if (rar) waits.push(rar.waitForBump(presentedReadAnchors, hold, readAnchorsScope));
					await Promise.race(waits);
					snap = box.drain(op.cursor ?? 0, op.epoch, conversationId);
				}
				// Log only a poll that hands entries to the console or signals a dropped-entry gap,
				// never the steady stream of empty held polls. This is the one window into whether a
				// reply reached the console's poll.
				if (snap.entries.length > 0 || snap.dropped > 0) {
					console.log(
						`[console poll] conv=${conversationId.slice(0, 12)} reqCursor=${op.cursor ?? 0} reqEpoch=${op.epoch ?? "none"} -> drained=${snap.entries.length} retCursor=${snap.cursor} retEpoch=${snap.epoch} dropped=${snap.dropped}`,
					);
				}
				const base = { entries: snap.entries, cursor: snap.cursor, dropped: snap.dropped, epoch: snap.epoch };

				// Piggyback the keyring: hand the Console the snapshot only when its known version
				// differs, so it stays fresh at near-zero steady cost.
				const dom = domain?.();
				const domainChanged = dom != null && op.knownDomainVersion !== dom.version;
				// Same piggyback shape, generalized: the presence plane's current truth, present only
				// when it actually moved past what the Console presented.
				const presenceVersion = pr?.version("presence");
				const presenceChanged = pr != null && pr.changedSince(presentedPresence, presenceScope).length > 0;
				// Same generalization again, for the linked-peers plane.
				const linkedPeersVersion = lpr?.version("linked-peers");
				const linkedPeersChanged =
					lpr != null && lpr.changedSince(presentedLinkedPeers, linkedPeersScope).length > 0;
				// Same generalization again, for this owner's read-anchors plane.
				const readAnchorsVersion = rar?.version(readAnchorsPlane);
				const readAnchorsChanged =
					rar != null && rar.changedSince(presentedReadAnchors, readAnchorsScope).length > 0;

				// Why this poll settled - the Console's instant-empty-response heuristic (its
				// old-gateway degradation signal) reads this so a plane-only settle never trips its
				// backoff. Priority mirrors the piggyback fields below: real mailbox entries first
				// (they are why a console polls at all), then presence, then linked-peers, then
				// read-anchors, then domain, else the hold simply elapsed with nothing new.
				const settled: "mailbox" | "presence" | "linkedPeers" | "readAnchors" | "domain" | "timeout" =
					snap.entries.length > 0
						? "mailbox"
						: presenceChanged
							? "presence"
							: linkedPeersChanged
								? "linkedPeers"
								: readAnchorsChanged
									? "readAnchors"
									: domainChanged
										? "domain"
										: "timeout";

				return {
					...base,
					...(domainChanged ? { domainVersion: dom.version, domain: dom.snapshot } : {}),
					...(presenceChanged && presenceVersion
						? {
								presence: presence?.snapshot() ?? [],
								presenceVersions: [
									{
										gateway: localGatewayId,
										epoch: presenceVersion.epoch,
										version: presenceVersion.counter,
									},
								],
							}
						: {}),
					...(linkedPeersChanged && linkedPeersVersion
						? {
								linkedPeers: planeRegistry?.snapshot<CrossDomainPeerEntry[]>("linked-peers") ?? [],
								linkedPeersVersion: {
									epoch: linkedPeersVersion.epoch,
									version: linkedPeersVersion.counter,
								},
							}
						: {}),
					...(readAnchorsChanged && readAnchorsVersion
						? {
								readAnchors: planeRegistry?.snapshot<ReadAnchorWireEntry[]>(readAnchorsPlane) ?? [],
								readAnchorsVersion: {
									epoch: readAnchorsVersion.epoch,
									version: readAnchorsVersion.counter,
								},
							}
						: {}),
					settled,
				};
			}

			case "report_read": {
				if (!readAnchors) throw new Error("read-anchor sync is not available on this Gateway");
				const advanced = readAnchors.report(ownerId, op.team, { epoch: op.epoch, seq: op.seq, at: Date.now() });
				if (advanced) planeRegistry?.markDirty(readAnchorsPlaneName(ownerId));
				return { advanced };
			}

			case "peek": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				const target = resolveTmuxTarget(op.target);
				assertDaemonDrivable(target);
				const r = await relayToHost({ kind: "peek", target });
				if (!r.ok) throw new Error(friendlyPeekError(r.error, r.errorKind));
				const peek = r.result as HostPeekResult;
				// 304-style short-circuit: an idle frame the console already has costs only the hash.
				if (op.sinceHash && op.sinceHash === peek.hash) return { hash: peek.hash, unchanged: true };
				// A live pane carries ansi; the pre-pane container-logs fallback carries text. The flat
				// result mirrors the host union's tag so the console renders the right one.
				if (peek.kind === "container-logs")
					return { text: peek.text, hash: peek.hash, kind: "container-logs" as const };
				return { ansi: peek.ansi, hash: peek.hash, kind: "tmux" as const };
			}

			case "tmux_send": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				// Exactly one of text/key. Reject neither (would inject a stray Enter) and both
				// (ambiguous) before anything reaches the pane.
				if ((op.text == null) === (op.key == null)) {
					throw new Error("tmux_send requires exactly one of text or key");
				}
				const target = resolveTmuxTarget(op.target);
				assertDaemonDrivable(target);
				// The host replays a completed send for this dedupKey instead of re-injecting, so a
				// relay timeout or a gateway restart that drops the gateway-side opCache cannot
				// double-type. The gateway opCache still single-flights concurrent same-opId.
				const dedupKey = `${conversationId}:${opId}`;
				let hostOp: HostOp;
				if (op.key != null) {
					// Whitelist the key at the gateway too (fail fast, no host round-trip); the host
					// executor is the second gate.
					if (!ALLOWED_KEYS.has(op.key)) throw new Error(`disallowed key "${op.key}"`);
					hostOp = { kind: "sendKey", target, key: op.key, dedupKey };
				} else {
					hostOp = { kind: "sendText", target, text: op.text ?? "", submit: op.submit ?? true, dedupKey };
				}
				const r = await relayToHost(hostOp);
				if (!r.ok) throw new Error(r.error ?? "send failed");
				return { sent: true };
			}

			case "create_session": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				if (!op.sessionName && !op.displayLabel) {
					throw new Error("create_session needs a sessionName or a displayLabel");
				}
				// Computed once, directly from the request's own displayLabel - never by comparing the
				// eventual sessionLabel/id after the fact, which would race a concurrent rename landing on
				// the same record before this op's reply is constructed. False whenever no displayLabel was
				// sent (the sessionName-adopted path's sessionLabel legitimately defaults to the id itself,
				// unrelated to sanitization).
				const labelSanitized = op.displayLabel != null && sanitizeLabel(op.displayLabel) === null;
				const spawn = parseTarget(op.target, localDomain, localGatewayId).spawn;
				const dedupKey = `${conversationId}:${opId}`;
				let sessionId: string;
				let label: string;
				let adopted: { record: SessionRecord; created: boolean } | null | undefined;
				// Whether this dispatch is even entitled to ever forget the adopted record on failure.
				// On the sessionName-provided path, `created: false` normally means an unrelated,
				// pre-existing session (adoptOrReattach found something already there) - never eligible -
				// UNLESS the reattached record's own mintedFrom matches this exact dedupKey, which can only
				// happen if THIS same (conversationId, opId) created it on an earlier attempt (mintedFrom is
				// stamped below, on the sessionName path too, precisely so a later retry can tell "my own
				// still-surviving attempt" apart from "a stranger's session that happens to share the name").
				// On the mint path, findByMintedFrom can only ever match a record THIS (conversationId,
				// opId) minted earlier - never a stranger's - so any record reached there, freshly minted
				// or reattached by a retry, is always eligible.
				let rollbackEligible = false;
				if (op.sessionName) {
					// A typed id is adopted as-is (the old-app/back-compat path).
					sessionId = op.sessionName;
					label = op.displayLabel ?? sessionId;
					adopted = sessionStore?.adoptOrReattach(sessionId, {
						spawn,
						sessionLabel: label,
						workdirHint: label,
						mintedFrom: dedupKey,
					});
					rollbackEligible = adopted?.created === true || adopted?.record.mintedFrom === dedupKey;
				} else {
					// No typed id: the gateway mints an opaque one, keyed by (conversationId, opId) so a
					// retry of the same op finds its own prior record directly instead of recomputing or
					// re-probing anything (the guard above guarantees displayLabel is set here).
					label = op.displayLabel as string;
					const minted = sessionStore?.mintOrReattach({
						spawn,
						sessionLabel: label,
						workdirHint: label,
						mintedFrom: dedupKey,
					});
					sessionId = minted?.record.id ?? label;
					adopted = minted ?? null;
					rollbackEligible = adopted != null;
				}
				// A store-backed id that could be neither created nor reattached collides with a catalog
				// project or reserved name; refuse rather than launch a recordless (hidden) session.
				if (sessionStore && !adopted) {
					throw new Error(`cannot create session "${sessionId}": the name is reserved or a project`);
				}
				// Re-checked at call time against the store's CURRENT occupant of the key, never against
				// the `adopted` object's own captured fields: `forget` has no in-flight guard, so between
				// this dispatch's launch call and its own failure settling, an unrelated later op can
				// forget-then-recreate the SAME team key out from under it. teamOf() is a pure function of
				// the record's immutable spawn+id, so a stale record and a brand-new one born at the same
				// key produce the identical lookup - only a fresh re-fetch, compared by IDENTITY against
				// the exact object this dispatch adopted, can tell them apart. A launch this op no longer
				// has a definitive answer about (an ambiguous timeout/disconnect, or a redundant retry
				// racing a slow confirm) may also have already gone live independently by the time a
				// rollback is considered, hence the confirmedAt check on top of the identity check.
				const mayForget = () => {
					if (!rollbackEligible || adopted == null) return false;
					const current = sessionStore?.getByTeam(sessionStore.teamOf(adopted.record));
					return current === adopted.record && current.confirmedAt === undefined;
				};
				try {
					const target = resolveTmuxTarget(op.target, sessionId);
					// The host workdir hint (the daemon opens a host session in ~/projects/<hint>, ignoring
					// it for a devcontainer). The store owns the workdirHint-over-sessionLabel precedence, so
					// this matches the wake path: a display-label collision (label deduped to "-2",
					// workdirHint pinned to the original) opens the same dir. The daemon guards traversal too.
					const workdirHint = sessionStore && adopted ? sessionStore.hostWorkdirHint(adopted.record) : label;

					// A devcontainer target may need a cold container bring-up (tryWakeTeam's
					// ensureContainerUpAsync), which the host-op channel's HOST_OP_TIMEOUT_MS (20s) cannot
					// afford - go through the wake path instead of relayToHost for that target kind
					// (relayToHost's createSession op assumes the container is already running). A host
					// target has no container to bring up - the daemon is definitionally already up if
					// relayToHost can reach it at all - so it keeps the direct host-op path.
					const launchTeam = composeSessionName(target.name, target.sessionName);
					const viaWake = target.kind === "devcontainer" && tryWakeTeam;
					// Mark in flight for teams()'s "verifying" status through both "tmux launched" and "MCP
					// registered" - the release below (not this call) is what actually times that window per
					// branch, since a devcontainer wake and a host-op launch settle at very different points.
					const releaseInFlight = markCreateInFlight?.(launchTeam);
					const launch: Promise<HostOpResult> = (
						viaWake
							? tryWakeTeam(launchTeam).then(
									(r): HostOpResult =>
										r.ok
											? { ok: true }
											: {
													ok: false,
													error: `failed to wake "${sessionId}"`,
													errorKind: r.errorKind,
												},
								)
							: relayToHost({
									kind: "createSession",
									target,
									workdirHint,
									// The record being (re)opened's own saved transcript id, when it has one - a
									// brand-new record's is naturally undefined (nothing to resume), matching the
									// wake path's identical claudeSessionId-gated resume decision.
									resumeSessionId: adopted?.record.claudeSessionId,
									dedupKey,
								})
					).finally(() => {
						// tryWakeTeam's own promise already stayed pending through registration (or its
						// timeout), so releasing here is already correctly timed for a devcontainer. The
						// host-op path's promise settles the instant the tmux pane spawns - well before
						// Claude CLI, the plugin, and the MCP register that actually follow - so defer the
						// release to that registration (or a bounded timeout) instead, in the background:
						// this op's own response timing (the race against createSessionBoundMs below) must
						// stay tied to the tmux spawn, not to registration, so the wait is never awaited here.
						if (viaWake || !awaitRegister) {
							releaseInFlight?.();
						} else {
							void awaitRegister(launchTeam).finally(() => releaseInFlight?.());
						}
					});

					let boundTimer: ReturnType<typeof setTimeout> | undefined;
					const bound = new Promise<null>((resolve) => {
						boundTimer = setTimeout(() => resolve(null), createSessionBoundMs);
					});
					const winner = await Promise.race([launch, bound]);
					clearTimeout(boundTimer);

					if (winner === null) {
						// Still bringing up a cold container; hand back the already-adopted id now and let
						// the launch finish in the background. Reached only via tryWakeTeam (a devcontainer
						// bring-up can run well past the bound) - its own wait narrows to a registration
						// window shorter than a slow first boot can need, so a "failed" wake here can still
						// go on to register and confirm afterward. mayForget()'s fresh confirmedAt check
						// catches that: a record already live by the time this settles is left alone.
						void launch
							.then((r) => {
								if (!r.ok && mayForget()) sessionStore?.forget(sessionStore.teamOf(adopted!.record));
							})
							.catch(() => {
								if (mayForget()) sessionStore?.forget(sessionStore.teamOf(adopted!.record));
							});
						return {
							created: true,
							id: adopted?.record.id ?? sessionId,
							sessionLabel: adopted?.record.sessionLabel,
							labelSanitized,
							status: "pending" as const,
						};
					}

					if (!winner.ok) {
						if (winner.errorKind === "timeout" || winner.errorKind === "disconnected") {
							throw new CreateSessionAmbiguousError(
								winner.error ?? "create session had no definitive answer",
							);
						}
						throw new Error(winner.error ?? "create session failed");
					}
				} catch (e) {
					// Roll back only a record this dispatch owns (see rollbackEligible above) and only
					// while it is still genuinely unconfirmed, so a reattach of an existing session is
					// never destroyed by a transient launch failure, and a redundant retry's own failure
					// never destroys a record that came alive through a different attempt in the meantime.
					// Never on an ambiguous timeout/disconnect either way: the launch it describes may
					// still be running and confirm normally afterward.
					if (mayForget() && !(e instanceof CreateSessionAmbiguousError)) {
						sessionStore?.forget(sessionStore.teamOf(adopted!.record));
					}
					throw e;
				}
				return {
					created: true,
					id: adopted?.record.id ?? sessionId,
					sessionLabel: adopted?.record.sessionLabel,
					labelSanitized,
				};
			}

			case "reload_plugins": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				const target = resolveTmuxTarget(op.target);
				assertDaemonDrivable(target);
				const dedupKey = `${conversationId}:${opId}`;
				const r = await relayToHost({ kind: "reloadPlugins", target, dedupKey });
				if (!r.ok) throw new Error(r.error ?? "reload failed");
				return { initiated: true };
			}

			case "forget": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				// Forget tears down ONE named session; a bare spawn-point (or host) has no session to
				// kill, so require a composite target and reject the spawn-point with a clear message.
				const t = parseTarget(op.target, localDomain, localGatewayId);
				if (t instanceof SpawnPoint) {
					throw new Error(`cannot forget "${op.target}": name a specific project.session, not a spawn-point`);
				}
				const name = composeSessionName(t.spawn, t.session);
				const dedupKey = `${conversationId}:${opId}`;
				// The tmux kill is best-effort: forget's actual contract is "stop listing this session",
				// which the record drop below alone guarantees. resolveTmuxTarget can throw (the project
				// left knownTeamPaths/offlineCatalog, both reset on a gateway restart until the host's next
				// catalog scan) and the kill itself can fail (host daemon offline, a tmux/docker timeout) -
				// none of that may block the drop, or a session the user asked to forget stays stuck on the
				// board forever with no way to make it go away. An orphaned tmux pane is recoverable; a
				// permanently-stuck board tile is not.
				try {
					const target = resolveTmuxTarget(op.target);
					const r = await relayToHost({ kind: "killSession", target, dedupKey });
					if (!r.ok) console.log(`[console] forget "${name}": kill failed - ${r.error ?? "unknown error"}`);
				} catch (e) {
					console.log(`[console] forget "${name}": kill failed - ${(e as Error).message}`);
				}
				// Drop the durable resume record so the session stops listing as available.
				dropSessionResume?.(name);
				return { killed: true };
			}

			case "close_session": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				// Close kills ONE named session's tmux but KEEPS its record (a restart / mop-up); same
				// composite-target rule as forget.
				const t = parseTarget(op.target, localDomain, localGatewayId);
				if (t instanceof SpawnPoint) {
					throw new Error(`cannot close "${op.target}": name a specific project.session, not a spawn-point`);
				}
				const name = composeSessionName(t.spawn, t.session);
				const target = resolveTmuxTarget(op.target);
				// An alias-served record's live incarnation is a user-launched `claude --resume` under a
				// different tmux name, so killing the canonical `spawn.id` pane finds nothing and the
				// record keeps reading online off its alias - a false {closed:true}. Report honestly
				// instead (the human ends a user-launched session from their own terminal).
				const record = sessionStore?.getByTeam(name);
				if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
					throw new Error(`"${name}" is user-launched; end it from your terminal`);
				}
				// A kill issued while this session is mid-wake would land as a no-op (the pane is not up
				// yet), then the in-flight wake would finish and register - resurrecting the session the
				// human just closed. Refuse until the wake settles rather than silently no-op-succeed.
				if (isWakeInFlight?.(name)) {
					throw new Error(`"${name}" is waking; wait for it to finish before closing`);
				}
				const dedupKey = `${conversationId}:${opId}`;
				const r = await relayToHost({ kind: "killSession", target, dedupKey });
				if (!r.ok) throw new Error(r.error ?? "close failed");
				// Deliberately NOT dropSessionResume: the record survives so the session stays available.
				return { closed: true };
			}

			case "rename_session": {
				// Relabel a session's record. A bare spawn-point has no record to rename, and the record
				// store is local, so a foreign-Gateway target must be rejected rather than collide with a
				// same-named local record (the other ops get this via resolveTmuxTarget).
				const t = parseTarget(op.target, localDomain, localGatewayId);
				if (t instanceof SpawnPoint) {
					throw new Error(`cannot rename "${op.target}": name a specific project.session, not a spawn-point`);
				}
				if (t.domain !== localDomain || t.gateway !== localGatewayId) {
					throw new Error(`cannot rename a session on another Gateway`);
				}
				const applied = sessionStore?.rename(composeSessionName(t.spawn, t.session), op.sessionLabel) ?? null;
				return { renamed: applied !== null, sessionLabel: applied ?? undefined };
			}

			case "cross_domain_listen": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				return crossDomain.listen();
			}

			case "cross_domain_request": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// The requester's owner key is this console's verified Domain owner (the allowlist
				// root the seal was checked against), not the op-supplied value: a console is
				// admitted under that owner, so it cannot claim another. The op's
				// requesterOwnerSignPub stays advisory (phone display only).
				return crossDomain.request({
					listeningToken: op.listeningToken,
					pin: op.pin,
					requesterOwnerSignPub: ownerSignPub,
					requesterDomainId: op.requesterDomainId,
					requesterGatewayId: op.requesterGatewayId,
				});
			}

			case "cross_domain_confirm": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// Each owner confirms independently with only its own signed link side (binding the
				// friend keys from the SAS-verified pairing). No friend-link exchange.
				return crossDomain.confirm({
					pin: op.pin,
					mySignedLink: op.mySignedLink,
				});
			}

			case "cross_domain_listen_state": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// A receiver read: the listening window's pairing state. Not cached (read-only).
				return crossDomain.listenState(op.listeningToken);
			}

			case "cross_domain_cancel": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// Leaving the trust screen closes the listening window: forward the phone's listening
				// token (receiver side) and/or pin (requester side) so the coordinator invalidates
				// that window. A bare cancel (neither present) only sweeps expired windows, a no-op
				// success.
				return { cancelled: crossDomain.cancel({ listeningToken: op.listeningToken, pin: op.pin }) };
			}

			case "cross_domain_share": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				// Store under the canonical domain.gateway.spawn.session key, the same form the relay gate, the
				// sweep, and discovery compare against; a bare-name share would otherwise never
				// match and silently never take effect.
				const canonicalTarget = await assertShareable(op.sessionTarget, op.target);
				crossDomainShare.share(canonicalTarget, op.target);
				return { ok: true };
			}

			case "cross_domain_unshare": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				// An unshare is always allowed (it only revokes): no kind/linked gate, so a session
				// whose kind changed or a now-unlinked Domain can still be cleaned up. Canonicalize
				// so an unshare keys identically to the share it withdraws.
				const canonicalTarget = canonicalShareTarget(op.sessionTarget);
				const removed = crossDomainShare.unshare(canonicalTarget, op.target);
				// An unshare must bite in-flight too: settle the already-accepted cross-Domain job(s)
				// for this audience so the reply is dropped at the destination rather than forwarded
				// back to the origin. Only when the share actually changed.
				if (removed) crossDomainShare.expireSessionJobsForTarget(canonicalTarget, op.target);
				return { ok: true };
			}

			case "cross_domain_list_shares": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				return { shares: crossDomainShare.listShares() };
			}

			case "cross_domain_list_peers": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// A fresh read of the peer set: the console unions these with its discovery-derived
				// Domains so a just-linked peer appears even while offline.
				return crossDomain.listPeers();
			}

			case "cross_domain_unlink": {
				if (!unlinkDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// Local cleanup only: forget every peer gateway of the Domain, every share to it, and
				// settle its in-flight jobs (so they fail fast instead of stalling to TTL once the
				// sealer refuses the unlinked peer). Idempotent: an already-unlinked Domain returns
				// zero counts, no error. The phone separately owner-signs and submits the link-edge
				// revocation so the Router drops its relay-affinity edge.
				return unlinkDomain(op.domainId);
			}

			case "cross_domain_untrust": {
				if (!untrustOwner) throw new Error("cross-Domain linking is not available on this Gateway");
				// Owner-keyed local cleanup: forget every peer Gateway owned by this person across all
				// their Domains, then drop the shares and settle the jobs for those Domains.
				// Idempotent. The phone separately owner-signs the untrust tombstone for the
				// Router-side edge revoke.
				return untrustOwner(op.ownerSignPub);
			}
		}
	}

	/** The canonical `domain.gateway.spawn.session` key a session is shared under, the single form
	 * every read path (the relay gate, the sweep, discovery) compares against. Built via the shared
	 * localAddress so it matches the relay gate and the pending-job store byte-for-byte. */
	function canonicalShareTarget(sessionTarget: string): string {
		const t = parseTarget(sessionTarget, localDomain, localGatewayId);
		const name = t instanceof SpawnPoint ? t.spawn : composeSessionName(t.spawn, t.session);
		return localAddress(name).canonical;
	}

	/** Gate a share request and return the canonical key to store it under: the session must be a
	 * local session of a shareable kind (devcontainer or loose only, never the headless "host"
	 * daemon or a console-kind team) and the friend Domain must be one the owner has actually
	 * linked. Resolves the kind from the local team registry the way teams() classifies them. */
	async function assertShareable(sessionTarget: string, target: CrossDomainShareTarget): Promise<string> {
		// A specific-Domain share must target a linked Domain; an everyone-trusted share is always
		// valid (it reaches only linked Domains, resolved live at the gate), so it has no per-Domain
		// check.
		if (target.kind === "domain" && !crossDomainShare?.isLinkedDomain(target.domainId)) {
			throw new Error(`cannot share to "${target.domainId}": not a linked Domain`);
		}
		const parsedShare = parseTarget(sessionTarget, localDomain, localGatewayId);
		if (parsedShare.domain !== localDomain || parsedShare.gateway !== localGatewayId) {
			throw new Error(`cannot share "${sessionTarget}": only local sessions can be shared`);
		}
		const name =
			parsedShare instanceof SpawnPoint
				? parsedShare.spawn
				: composeSessionName(parsedShare.spawn, parsedShare.session);
		const teams = (await routes.teams().json()) as TeamInfo[];
		const team = teams.find((t) => t.team === name);
		if (!team || (team.kind !== "devcontainer" && team.kind !== "loose")) {
			throw new Error(`cannot share "${name}": only devcontainer and loose sessions can be shared`);
		}
		return localAddress(name).canonical;
	}

	async function runFrame(frame: OpenedConsoleFrame): Promise<ConsoleReplyBody> {
		try {
			// Bind/refresh the peer on every frame so a send arriving before an explicit register
			// still routes its replies back to the mailbox. Only a register op may rebind an install
			// to a new device name / key.
			const ownerId = ownerKeyId(frame.ownerSignPub);
			ensurePeer(frame.device, frame.conversationId, frame.signerSignPub, ownerId, frame.op.kind === "register");
			const result = await dispatch(
				frame.op,
				frame.device,
				frame.conversationId,
				ownerId,
				frame.opId,
				frame.ownerSignPub,
			);
			return { ok: true, result };
		} catch (err) {
			const message = (err as Error).message;
			// The reply carrying this message is E2E-sealed before it leaves handleFrame (relayPump.ts),
			// so this is the only point where an op failure is visible server-side at all.
			console.error(`[console] ${frame.op.kind} op failed for ${frame.device}: ${message}`);
			return { ok: false, error: message };
		}
	}

	function handleFrame(frame: OpenedConsoleFrame): Promise<ConsoleReplyBody> {
		// Reads (register/poll/list_teams) run fresh every call: they have no side effect to dedupe
		// and must reflect live state (e.g. the current epoch).
		if (!isMutatingOp(frame.op)) return runFrame(frame);

		// Mutating ops are idempotent per (conversation, opId): a retried opId replays the original
		// reply and a concurrent retry coalesces onto the same in-flight promise, so the side effect
		// happens once.
		const conv = frame.conversationId;
		const cached = opCache.get(conv)?.get(frame.opId);
		if (cached) return cached;

		const promise = runFrame(frame);
		let perConv = opCache.get(conv);
		if (!perConv) {
			perConv = new Map();
			opCache.set(conv, perConv);
		}
		perConv.set(frame.opId, promise);
		if (perConv.size > MAX_OPS_PER_CONVERSATION) {
			const oldest = perConv.keys().next().value;
			if (oldest !== undefined) perConv.delete(oldest);
		}
		// A failed op performed no side effect, so it must be retriable: drop it from the cache so a
		// retry re-runs rather than replaying the failure.
		void promise
			.then((reply) => {
				if (!reply.ok) opCache.get(conv)?.delete(frame.opId);
			})
			.catch(() => {});
		return promise;
	}

	return { handleFrame, ensurePeer, removePeer };
}
