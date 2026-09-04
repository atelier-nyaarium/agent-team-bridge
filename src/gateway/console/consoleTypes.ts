import type { DomainSnapshot } from "../../shared/admission.js";
import type { BlobStore } from "../../shared/blob-store.js";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type {
	ConsoleOp,
	CrossDomainConfirmResult,
	CrossDomainListenResult,
	CrossDomainListenStateResult,
	CrossDomainListPeersResult,
	CrossDomainListSharesResult,
	CrossDomainRequestResult,
	CrossDomainShareTarget,
	CrossDomainUnlinkResult,
	DiscoverCoverage,
} from "../../shared/console-protocol.js";
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import type { PlaneRegistry } from "../../shared/plane-registry.js";
import { MAX_POLL_HOLD_MS } from "../../shared/schemas.js";
import type { SessionStore } from "../../shared/session-store.js";
import type { GatewaySpawnPoints, TeamInfo } from "../../shared/types.js";
import type { DeliverToOwner } from "../consolePushOps.js";
import type { CrossDomainPresenceConsumer } from "../federation/crossDomainPresence.js";
import type { IntentTracker } from "../intent.js";
import type { ReadAnchors } from "../readAnchors.js";
import type { WakeResult } from "../wake.js";
import type { ConversationRegistry, TeamRegistry } from "../websocket.js";
import type { CapabilityStore } from "./capabilityStore.js";
import type { DurableOpStore } from "./durableOpStore.js";

////////////////////////////////
//  Interfaces & Types

/** The subset of gateway HTTP routes the console handler reuses. */
export interface ConsoleRoutes {
	send: (req: Request, body: Record<string, unknown>, opts?: { consoleSender?: boolean }) => Promise<Response>;
	respond: (
		req: Request,
		body: Record<string, unknown>,
		opts?: { consoleSender?: boolean; onFederatedSettled?: (ok: boolean) => void },
	) => Response;
	teams: () => Response;
	// Mesh-wide team list (local + every online peer Gateway). A console roams all Gateways.
	discover: (url?: URL) => Promise<Response>;
	// Same rows plus completeness, so a partial answer cannot pass as a full one.
	discoverFull: () => Promise<{
		teams: TeamInfo[];
		coverage: DiscoverCoverage;
		/** What each Gateway's machine offers beyond `host`, same-Domain only. Optional for the same
		 * reason the wire field is: absent means "not advertised", never "this machine has none". */
		spawnPoints?: GatewaySpawnPoints[];
	}>;
	// The owner-delivery funnel (consolePushOps.deliverToOwner): the ONE mailbox writer, appending
	// locally and converging to every other same-Domain Gateway the console might actually poll.
	deliverToOwner: DeliverToOwner;
}

export type TrustedCatalogProject = (name: string) => boolean;

/** The JSON body shape returned by routes.send, shared by the in-time and backgrounded
 * read sites so they cannot drift. A channelOnly send never produces an inline response
 * body: success is always the deterministic channel session, the answer arrives via
 * response_push. */
export interface SendRouteJson {
	session_id?: string;
	status?: string;
	error?: string;
}

export interface ConsoleHandlerDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	routes: ConsoleRoutes;
	/** This Gateway's id, returned on register so the console anchors its composite
	 * (gatewayId, name) key, and used to canonicalize a send target to the qualified
	 * session-id form (matching routes.send). */
	localGatewayId: string;
	localDomainId: string;
	sendBoundMs?: number;
	createSessionBoundMs?: number;
	/** True when the name belongs to a trusted devcontainer project. A device must not take such a
	 * name: while the project sleeps, the console's virtual peer would squat the registry slot,
	 * absorb sends meant for the project, and suppress its wake. */
	isTrustedCatalogProject?: TrustedCatalogProject;
	/** Drop a session's durable resume record (the console's Forget), so it stops listing as
	 * an available asleep session. */
	dropSessionResume?: (team: string, boardDisposition: BoardDisposition) => void;
	/** What plugins this owner's consoles have enabled. Absent in harnesses that do not exercise it. */
	capabilityStore?: Pick<CapabilityStore, "report" | "touch" | "forget">;
	/** Session access. create_session mints/adopts a record here (the minted id is the tmux session
	 * name); rename_session relabels one; forget drops one. Production wires the presence facade
	 * (so these writes announce themselves on the presence plane); a narrow Pick, not the full
	 * SessionStore class, so either satisfies it structurally. Absent in harnesses with no store. */
	sessionStore?: Pick<
		SessionStore,
		| "getByTeam"
		| "teamOf"
		| "adoptById"
		| "adoptOrReattach"
		| "mintOrReattach"
		| "hostWorkdirHint"
		| "forget"
		| "rename"
		| "ensureBindToken"
	>;
	/** The current keyring + its version hash. The poll reply carries the snapshot only when
	 * the Console's known version differs. */
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	/** This Gateway's own Domain lifecycle status, learned from the Router's register reply, and
	 * returned on the console register. A Gateway exists only for a Domain past rooting, so this
	 * is "rooted" (or "unrooted" for a fresh admin Domain) and never "pending" (the pending case
	 * reaches the app via the provisioning blob's pendingTenant). Undefined against a pre-feature
	 * Router, where the app treats the Domain as already rooted. */
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
	/** The landed side of a linked friend's `presence_push` (crossDomainPresence.ts): the poll case
	 * eagerly ensures a plane for every currently-linked Domain (via `linkedDomainIds` below) before
	 * racing `waitForBump` - a plane that does not exist yet cannot wake an in-flight held poll on
	 * its own first bump (`PlaneRegistry.wake`'s membership-gated dispatch) - then piggybacks
	 * whichever linked Domains' planes actually changed. Absent when not wired (the poll piggyback
	 * is simply skipped, matching every other plane's own opt-in shape). */
	crossDomainPresenceConsumer?: CrossDomainPresenceConsumer;
	/** This Gateway's currently-linked Domain ids, enumerated fresh on every poll call (never
	 * cached) - the roster `crossDomainPresenceConsumer` above is ensured/versioned against. */
	linkedDomainIds?: () => string[];
	/** Relay a tmux op to the local host daemon and await its reply. Drives the console terminal
	 * view; absent when no host daemon is wired (the op then errors "terminal unavailable"). */
	/** The gateway's byte store. Absent only in tests that never exercise a blob op; the three
	 * blob cases refuse rather than inventing a location to write to. */
	blobStore?: BlobStore;
	/** Pulls a blob in from the Gateway holding it. The console always asks its route Gateway, which
	 * is often not the holder, so without this a cross-Gateway attachment is unfetchable. */
	fetchBlobFromGateway?: (blobId: string, fromGateway: string) => Promise<import("../blobOps.js").BlobFetchOutcome>;
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
	/** Durable, restart-proof idempotency for `send`/`respond`, consulted only on an in-memory
	 * opCache miss - see durableOpStore.ts. Absent disables the durable layer entirely (the
	 * in-memory opCache alone still covers same-process retries, but not across a restart). */
	durableOpStore?: DurableOpStore;
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

// An ABSENT peek (pane booting, just exited, or stopped) gets a calm lead in place of raw stderr,
// with the original cause appended so a PERMANENT absence (dead agent, removed container) stays
// diagnosable instead of reading as "still starting" forever. The absent-vs-failure decision is
// made at the host (classifyPeekError); a real failure (timeout, offline host) passes through.
export function friendlyPeekError(error?: string, kind?: HostOpResult["errorKind"]): string {
	const raw = error ?? "peek failed";
	if (kind === "absent") return `No session running - it may be starting or has stopped: ${raw}`;
	return raw;
}

// Marks a create_session failure as an ambiguous host-op outcome (a timeout or a disconnect, never a
// host-reported result) rather than a definitive one, so the catch-all rollback around it knows not
// to forget a record whose launch may still be running.
export class CreateSessionAmbiguousError extends Error {}

export const FAKE_REQ = new Request("http://gateway/console");

// Bound on how long a console send op may block inside the relay. The gateway's wake path can
// hold /send for up to WAKE_TIMEOUT_MS (10 min), far past the Router's opId hold. Past this bound the
// op returns the deterministic session id and the wake/send continues in the background, the
// answer landing in the mailbox via the persistent conversation. The Android console's own
// PINNED_READ_TIMEOUT_MS (ConsoleHttp.kt) must outlast this - pinned by
// ChatRepositoryConstantsTest.kt, update both sides together.
export const SEND_BOUND_MS = 25_000;

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
// value. Must clear the relay chain with headroom: the Router holds the console's HTTP request 55s
// (ConsoleHttp.ROUTER_HOLD_MS mirrors it). The Android console's own LONG_POLL_HOLD_MS must stay at
// or under MAX_POLL_HOLD_MS - pinned by consoleHandler.test.ts and ChatRepositoryConstantsTest.kt,
// update all sides together.
export const HOLD_CAP_MS = MAX_POLL_HOLD_MS;

// At-most-once side effects: the console->Router->gateway path is at-least-once (a lost reply makes
// the console retry the same opId), so a seen opId replays its cached reply instead of re-running
// the op (which would duplicate a channel_push / response_push). Only mutating ops are cached,
// only on success, and the cache is keyed per conversation so one install cannot evict or read
// another's entry. MAX_OPS_PER_CONVERSATION lives in shared/console-protocol.ts, shared with
// durableOpStore.ts's own per-conversation cap, since a durable op can never outnumber the
// mutating ops that pass through this cache above it.

/** The one predicate both the opCache membership and the durable-layer branch derive the board
 * mutation set from, so a future board op cannot join one and silently miss the other. */
export function isBoardMutationKind(kind: string): boolean {
	return kind.startsWith("board_") && kind !== "board_read";
}

export function isMutatingOp(op: ConsoleOp): boolean {
	// Ops with a side effect are cached so a retried opId replays the cached reply rather than
	// re-running: tmux_send re-injecting keys, create_session/reload_plugins re-launching, the
	// cross_domain_* handshake ops minting a second window or re-routing or re-writing a peer,
	// share/unshare re-mutating the store, unlink re-running cleanup and reporting zero. The reads
	// (peek, cross_domain_listen_state, list_shares, list_peers) run live and are never cached.
	return (
		op.kind === "send" ||
		op.kind === "respond" ||
		// Board mutations are absolute but NOT monotonic: a retry replayed after a newer write
		// would regress the field, so the opCache must answer a lost-reply retry with the cached
		// reply rather than re-running it (board_read stays out - reads run fresh).
		isBoardMutationKind(op.kind) ||
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
