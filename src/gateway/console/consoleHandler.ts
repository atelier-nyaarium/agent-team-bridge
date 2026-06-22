import type { DomainSnapshot } from "../../shared/admission.js";
import {
	type ConsoleOp,
	type ConsoleOpResult,
	type ConsoleReplyBody,
	type CrossDomainConfirmResult,
	type CrossDomainListenResult,
	type CrossDomainListenStateResult,
	type CrossDomainListPeersResult,
	type CrossDomainListSharesResult,
	type CrossDomainRequestResult,
	type CrossDomainUnlinkResult,
	type MailboxInput,
	type OpenedConsoleFrame,
	parseQualifiedTeam,
} from "../../shared/console-protocol.js";
import type { DeviceMailboxStore } from "../../shared/device-mailbox.js";
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import {
	ALLOWED_KEYS,
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { GatewayTransport } from "../../shared/schemas.js";
import { SessionId, TeamAddress } from "../../shared/session-id.js";
import type { TeamInfo } from "../../shared/types.js";
import { type ConversationRegistry, RESERVED_TEAM_NAMES, type TeamRegistry } from "../websocket.js";
import { ConsolePeer } from "./consolePeer.js";

////////////////////////////////
//  Interfaces & Types

/** The subset of gateway HTTP routes the console handler reuses. */
export interface ConsoleRoutes {
	send: (req: Request, body: Record<string, unknown>) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>) => Response;
	teams: () => Response;
	// Mesh-wide team list (local + every online peer Gateway); the console is a
	// roaming console and sees all Gateways, not just its home Gateway.
	discover: () => Promise<Response>;
}

/** The JSON body shape returned by routes.send, read in both the in-time and
 * backgrounded send paths. One definition so the two read sites cannot drift.
 * channelOnly sends never produce an inline response body: a success is always
 * the deterministic channel session, with the answer arriving via response_push. */
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
	sendBoundMs?: number;
	/** True when the name belongs to a devcontainer project (catalog or known
	 * paths). A device must not take such a name: while the project sleeps, the
	 * console's virtual peer would squat the registry slot, absorb sends meant for
	 * the project, and suppress its wake. */
	isProjectName?: (name: string) => boolean;
	/** The current keyring + its version hash, for the Console's poll-based sync. The
	 * poll reply carries the snapshot only when the Console's known version differs. */
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	/** The bootstrap transport creds a creds-less Gateway needs to reach evie, served to the
	 * Console on the get_gateway_transport op (it seals them into a bundle for a Gateway it is
	 * enrolling). Read from the federation dir's bootstrap-transport.json; null when unprovisioned. */
	bootstrapTransport?: () => GatewayTransport | null;
	/** Relay a tmux op (peek/sendText/sendKey) to the local host daemon and await its reply.
	 * Drives the console terminal view; absent when no host daemon is wired (the op then errors
	 * "terminal unavailable"). */
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	/** The cross-Domain listening-mode handshake coordinator. Absent when federation is not
	 * wired (the cross_domain_* ops then error "not available"). The console drives the
	 * mutual pairing through these; the gateway owns the listening window + writes the peer. */
	crossDomain?: CrossDomainConsoleHandlers;
	/** The per-session share manager. Absent when federation is not wired (the
	 * cross_domain_share/unshare/list_shares ops then error "not available"). Backed by the
	 * gateway's CrossDomainShareState store; `isLinkedDomain` reads the cross-Domain peer set
	 * so a share can only target a Domain the owner has actually linked. */
	crossDomainShare?: CrossDomainShareHandlers;
	/** Drop ALL local trust + share state for a linked friend Domain (the cross_domain_unlink
	 * op). Absent when federation is not wired (the op then errors "not available"). Performs
	 * the local cleanup - forget every peer gateway of the Domain, every share offered to it,
	 * and settle any in-flight job bound to it - and returns the counts. Idempotent: unlinking
	 * an already-unlinked Domain returns zero counts with no error. The Router-side relay-edge
	 * revocation is the phone's separate owner-signed submit, not this gateway-local cleanup. */
	unlinkDomain?: (domainId: string) => CrossDomainUnlinkResult;
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
	/** RECEIVER read: the listening window's pairing state, so the receiver phone learns a
	 * pairing arrived + the SAS + the friend keys. Read-only (does not consume the window). */
	listenState: (listeningToken: string) => CrossDomainListenStateResult;
	/** The linked friend Domains from the cross-Domain peer set, projected to `(domainId,
	 * gatewayId)` per peer. Read-only roster: a peer is listed once linked, regardless of online /
	 * shared-back state, so a freshly-linked peer is visible before any session crosses. */
	listPeers: () => CrossDomainListPeersResult;
}

/** The subset of the per-session share state the console handler drives. A narrow seam
 * so the handler stays mockable and never imports the store class. `sessionTarget` is the
 * canonical `gateway/name` of a LOCAL session; `domainId` is a linked friend Domain. */
export interface CrossDomainShareHandlers {
	share: (sessionTarget: string, domainId: string) => void;
	/** Withdraw a session's share to a friend Domain, returning whether a record was removed
	 * (so the handler only expires in-flight jobs when the share actually changed). */
	unshare: (sessionTarget: string, domainId: string) => boolean;
	listShares: () => CrossDomainListSharesResult["shares"];
	/** Actively settle any in-flight cross-Domain job for this (canonical session, friend
	 * Domain) pair, so an already-accepted send's reply stops at the destination instead of
	 * forwarding home after the share is withdrawn (the per-session counterpart of the
	 * whole-Domain unlink expiry). Called after a successful unshare. */
	expireSessionJobs: (sessionTarget: string, domainId: string) => void;
	/** Whether the owner has a linked cross-Domain peer in this Domain (a share can only
	 * target a Domain that has been linked through the handshake). */
	isLinkedDomain: (domainId: string) => boolean;
}

////////////////////////////////
//  Functions & Helpers

const FAKE_REQ = new Request("http://gateway/console");

// Bound on how long a console send op may block inside the relay. The gateway's
// own wake path can hold /send for up to WAKE_TIMEOUT_MS (10 min), far past
// evie's opId hold; past this bound the op returns the deterministic session id
// and the wake/send continues in the background, with the eventual answer
// landing in the mailbox via the persistent conversation.
const SEND_BOUND_MS = 25_000;

// Ceiling on a poll's long-poll hold. Must clear the relay chain with headroom:
// evie holds the console's HTTP request 55s and the apiserver proxy allows 60s.
const HOLD_CAP_MS = 45_000;

// At-most-once side effects: the console->evie->gateway path is at-least-once
// (a lost reply makes the console retry the same opId), so a seen opId replays its
// cached reply instead of re-running the op (which would duplicate a
// channel_push / response_push). Only mutating ops are cached, only on success
// (a failed op had no side effect and must be retriable), and the cache is
// keyed per conversation so one install cannot evict or read another's entry.
const MAX_OPS_PER_CONVERSATION = 256;

function isMutatingOp(op: ConsoleOp): boolean {
	// tmux_send injects keystrokes (a real side effect), so a retried opId must replay
	// the cached ack, not re-send the keys. peek is a fresh read (never cached). The
	// stateful cross_domain_* handshake ops (a minted window, a routed request, a written
	// peer, a cancellation) cache so a retried opId replays the cached reply rather than
	// minting a second window, re-routing, or re-writing the peer; listen_state is a fresh
	// read (the receiver polls it, so it must run live, never cached). share/unshare mutate
	// the share store; a retried opId replays the cached ack. list_shares and list_peers are fresh
	// reads. unlink drops the peer/share/job state for a Domain; a retried opId replays the cached
	// counts rather than re-running the (already idempotent) cleanup and reporting zero again.
	return (
		op.kind === "send" ||
		op.kind === "respond" ||
		op.kind === "tmux_send" ||
		op.kind === "cross_domain_listen" ||
		op.kind === "cross_domain_request" ||
		op.kind === "cross_domain_confirm" ||
		op.kind === "cross_domain_cancel" ||
		op.kind === "cross_domain_share" ||
		op.kind === "cross_domain_unshare" ||
		op.kind === "cross_domain_unlink"
	);
}

export function createConsoleHandler({
	registry,
	conversationRegistry,
	mailboxStore,
	routes,
	localGatewayId,
	sendBoundMs = SEND_BOUND_MS,
	isProjectName,
	domain,
	bootstrapTransport,
	relayToHost,
	crossDomain,
	crossDomainShare,
	unlinkDomain,
}: ConsoleHandlerDeps) {
	/** Resolve a console terminal target (the gateway-qualified session name) to the host
	 * tmux it maps to: the host-agent's own session for "gateway", a devcontainer for a known
	 * project. A cross-Gateway target (v1 is local-only) or an unknown/loose name is rejected. */
	function resolveTmuxTarget(qualifiedTarget: string): TmuxTarget {
		const { gatewayId, name } = parseQualifiedTeam(qualifiedTarget);
		if (gatewayId && gatewayId !== localGatewayId) {
			throw new Error(`terminal view is not available for a session on another Gateway`);
		}
		if (name === "gateway") return { kind: "gateway", name };
		if (isProjectName?.(name)) return { kind: "devcontainer", name };
		throw new Error(`terminal view is not available for "${name}" (only the host agent and devcontainers)`);
	}
	// The per-install conversationId is the DEVICE identity: it keys the registry sub,
	// the signing-key binding, the idempotency cache, and the device-name binding. The
	// MAILBOX is keyed by OWNER (below), so an owner's devices share one inbox while
	// each keeps its own registry slot and key binding.
	const bindings = new Map<string, string>();
	// conversationId -> the console signing key bound to that install. A frame whose
	// signerSignPub differs from the binding cannot operate this conversation (so a
	// console cannot poll or settle another install's mailbox by borrowing its
	// conversationId). A register op may rebind (re-enrollment with a new key).
	const signers = new Map<string, string>();
	// conversationId -> (opId -> in-flight/settled reply body) for mutating-op idempotency.
	const opCache = new Map<string, Map<string, Promise<ConsoleReplyBody>>>();
	// conversationId -> ownerId, and ownerId -> its device conversationIds. The mailbox
	// store is keyed by ownerId, so these map a device to its shared owner inbox and let
	// teardown release the inbox only when the owner's last device is gone.
	const deviceOwner = new Map<string, string>();
	const ownerDevices = new Map<string, Set<string>>();

	// Owner-inbox lifetime: when the store evicts an owner inbox (idle sweep or cap),
	// tear down every device peer that shared it. The box is already gone, so this only
	// clears the device-side state (teardownDevice never re-deletes the box).
	mailboxStore.setOnEvict((ownerId) => {
		for (const conversationId of [...(ownerDevices.get(ownerId) ?? [])]) teardownDevice(conversationId);
	});

	function recordInbound(ownerId: string, sessionId: string): void {
		// Canonicalize so the gate in respond can always compare canonical form
		// against canonical form, whether the session id arrived bare or qualified.
		// Recorded on the durable owner inbox so respondability survives a restart.
		const canonical = SessionId.parse(sessionId, localGatewayId)?.key ?? sessionId;
		mailboxStore.get(ownerId)?.recordSession(canonical);
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
		// A register op may rename the device: migrate the registry sub off the
		// old name (the owner inbox and binding carry over) before the identity
		// checks see the stale binding.
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

		// Cryptographic install binding: the conversation is owned by the first
		// signing key seen for it; a later frame with a different key is rejected
		// unless this is a (re-enrolling) register. Blocks a console from operating
		// another install's mailbox by borrowing its conversationId.
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
			// Self-heal the conversation pointer if a (since closed) real socket
			// ever displaced it.
			conversationRegistry.set(conversationId, existing.asWs());
			return existing;
		}

		const peer = new ConsolePeer(
			// While the device is live, re-create an evicted box (deliveries survive a
			// store sweep); once torn down, return undefined so a late push cannot
			// resurrect an owner inbox the index no longer tracks.
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

		// Remove only this install's virtual sub; never evict a co-resident real
		// team's sockets. The team entry goes only when nothing remains.
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
			// Release this device's watermark from the shared inbox, and delete the
			// inbox only once its last device is gone (teardownDevice drops the entry).
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
				return { device, gatewayId: localGatewayId, cursor: box.highWater, epoch: box.epoch };
			}

			case "list_teams": {
				// Fan out across the mesh so the console sees every Gateway's sessions, each
				// carrying its own `gatewayId` (the console keys threads by gateway/name).
				const teams = (await (await routes.discover()).json()) as TeamInfo[];
				// A console does not list other consoles as send targets, and excludes
				// itself. teams() already drops the cli "host" daemon; the "gateway"
				// host-agent of each Gateway stays (kind "gateway"), reachable from the console.
				return {
					teams: teams.filter((t) => t.team !== device && t.kind !== "console"),
				};
			}

			case "send": {
				// Online CLI-mode targets answer synchronously through /send's blocking
				// wait, far past any relay hold. Reject those up front. A SLEEPING
				// CLI team is unknowable here (mode surfaces only on register), so
				// it pays a wake and is then rejected by the route's channelOnly
				// check instead of minting a random session id.
				// The console may target a gateway-qualified name (`gateway/name`); strip the
				// gateway for the local registry probe. Cross-gateway targets are rejected
				// by routes.send (federation routing is a later phase).
				const localTarget = parseQualifiedTeam(op.to).name;
				const targetSubs = registry.get(localTarget);
				if (targetSubs) {
					for (const [, ws] of targetSubs) {
						if (!ws.data.virtual && ws.readyState === 1 && ws.data.mode === "cli") {
							throw new Error(
								`"${localTarget}" is a CLI-mode agent; console chat supports channel-mode (Claude) teams only`,
							);
						}
					}
				}

				// Canonical session id matching what routes.send composes, so the
				// backgrounded-send path hands back the same id the in-time path would.
				// Keyed by ownerId, so every device of the owner shares the one thread.
				const expectedSession = SessionId.channel(ownerId, TeamAddress.local(localGatewayId, localTarget)).key;
				const sendPromise = routes.send(FAKE_REQ, {
					from: device,
					fromConversationId: ownerId,
					to: op.to,
					// Forward the selected session's Domain so a cross-Domain send resolves its seal
					// target by the full (domainId, gatewayId) pair; absent for a home/cross-Gateway send.
					targetDomainId: op.domainId,
					type: op.request_type,
					effort: op.effort,
					body: op.body,
					files: op.files,
					channelOnly: true,
				});

				let boundTimer: ReturnType<typeof setTimeout> | undefined;
				const bound = new Promise<null>((resolve) => {
					boundTimer = setTimeout(() => resolve(null), sendBoundMs);
				});
				const winner = await Promise.race([sendPromise, bound]);
				clearTimeout(boundTimer);

				if (winner === null) {
					// Wake still in progress; hand back the deterministic channel job
					// key now. channelOnly guarantees a successful send is always the
					// deterministic channel session (the real answer arrives later via
					// response_push), so the continuation only has to surface a
					// backgrounded failure as an error reply. It uses appendIfLive so
					// a since-evicted conversation drops cleanly.
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
				// Mirror the owner's own outgoing message to all their devices (full two-way
				// sync). The sender reconciles it against its optimistic row by opId; the
				// owner's other devices render it under the same thread. The dedupeKey makes the
				// echo idempotent across a gateway restart (the persisted seenKeys absorbs a
				// reconcile re-send of the same opId), so no duplicate "you" row.
				appendIfLive(
					conversationId,
					{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
					`sent:${conversationId}:${opId}`,
				);
				return { session_id: json.session_id ?? "", status: json.status ?? "running" };
			}

			case "respond": {
				// A console may only settle a thread that was delivered to it. This
				// blocks forging another conversation's reply and, critically, keeps
				// op.session_id away from resolveHandshake (handshake ids are never
				// recorded as inbound). Canonicalize via SessionId.parse so a bare
				// session id matches the qualified key recorded on inbound delivery.
				const canonicalRespondId = SessionId.parse(op.session_id, localGatewayId)?.key ?? op.session_id;
				if (!mailboxStore.get(ownerId)?.canRespond(canonicalRespondId)) {
					throw new Error(`Unknown session_id; you can only respond to a thread delivered to you`);
				}
				const res = routes.respond(FAKE_REQ, {
					session_id: canonicalRespondId,
					status: op.status,
					response: op.response,
					replyAsJson: op.replyAsJson,
					files: op.files,
				});
				const json = (await res.json()) as { error?: string };
				if (!res.ok) throw new Error(json.error ?? "respond failed");
				return { delivered: true };
			}

			case "poll": {
				// Long-poll: an empty drain holds the op open (bounded under the
				// relay-chain timeouts) until an append wakes it, then drains again.
				// The pump runs frames concurrently, so a held poll blocks nothing,
				// and retried polls just become additional waiters (reads are not
				// opId-cached; the console dedupes entries by seq).
				const box = mailboxStore.ensure(ownerId);
				let snap = box.drain(op.cursor ?? 0, op.epoch, conversationId);
				const hold = Math.min(op.holdMs ?? 0, HOLD_CAP_MS);
				if (snap.entries.length === 0 && hold > 0) {
					await box.waitForAppend(hold);
					snap = box.drain(op.cursor ?? 0, op.epoch, conversationId);
				}
				// Permanent low-noise delivery observability: log only a poll that actually
				// hands entries to the console or signals a dropped-entry gap, never the
				// steady stream of empty held polls. This is the one window into whether a
				// reply reached the console's poll (the blind spot that hid the earlier delivery bugs).
				if (snap.entries.length > 0 || snap.dropped > 0) {
					console.log(
						`[console poll] conv=${conversationId.slice(0, 12)} reqCursor=${op.cursor ?? 0} reqEpoch=${op.epoch ?? "none"} -> drained=${snap.entries.length} retCursor=${snap.cursor} retEpoch=${snap.epoch} dropped=${snap.dropped}`,
					);
				}
				const base = { entries: snap.entries, cursor: snap.cursor, dropped: snap.dropped, epoch: snap.epoch };
				// Piggyback the keyring: hand the Console the snapshot only when its known
				// version differs, so it stays fresh within one cycle at near-zero steady cost.
				const dom = domain?.();
				if (dom && op.knownDomainVersion !== dom.version) {
					return { ...base, domainVersion: dom.version, domain: dom.snapshot };
				}
				return base;
			}

			case "get_gateway_transport": {
				// The home Gateway hands the Console the bootstrap creds (gateway-bridge SA + token)
				// so it can seal them into a bundle for a creds-less Gateway it is enrolling. Serving
				// creds here is safe because the frame reached dispatch only after the consoleSealer
				// opened it against an owner-signed kind:console admission at the relay boundary; the
				// reply is sealed back to the Console's box key on the same path, so evie never sees
				// the token. Read fresh from the federation dir (not idempotency-cached).
				const transport = bootstrapTransport?.() ?? null;
				if (!transport) {
					throw new Error(
						"gateway transport not provisioned - run provision-console.sh --setup on the home Gateway",
					);
				}
				return { transport };
			}

			case "peek": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				const target = resolveTmuxTarget(op.target);
				const r = await relayToHost({ kind: "peek", target });
				if (!r.ok) throw new Error(r.error ?? "peek failed");
				const { ansi, hash } = r.result as HostPeekResult;
				// 304-style short-circuit: an idle pane the console already has costs only the hash.
				if (op.sinceHash && op.sinceHash === hash) return { hash, unchanged: true };
				return { ansi, hash };
			}

			case "tmux_send": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				// Exactly one of text/key. Reject neither (would inject a stray Enter) and both
				// (ambiguous) before anything reaches the pane.
				if ((op.text == null) === (op.key == null)) {
					throw new Error("tmux_send requires exactly one of text or key");
				}
				const target = resolveTmuxTarget(op.target);
				// The host replays a completed send for this dedupKey instead of re-injecting, so a
				// relay timeout or a gateway restart that drops the gateway-side opCache cannot
				// double-type. (The gateway opCache still single-flights concurrent same-opId.)
				const dedupKey = `${conversationId}:${opId}`;
				let hostOp: HostOp;
				if (op.key != null) {
					// Whitelist the key at the gateway too (fail fast, no host round-trip); the host
					// executor is the second gate.
					if (!ALLOWED_KEYS.has(op.key)) throw new Error(`disallowed key "${op.key}"`);
					hostOp = { kind: "sendKey", target, key: op.key, dedupKey };
				} else {
					hostOp = { kind: "sendText", target, text: op.text ?? "", dedupKey };
				}
				const r = await relayToHost(hostOp);
				if (!r.ok) throw new Error(r.error ?? "send failed");
				return { sent: true };
			}

			case "cross_domain_listen": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				return crossDomain.listen();
			}

			case "cross_domain_request": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// The requester's OWN owner key is this console's verified Domain owner (the
				// allowlist root the seal was checked against), NOT the op-supplied value: a
				// console is admitted under that owner, so it cannot claim another. The
				// op's requesterOwnerSignPub stays advisory (phone display only).
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
				// Model A: each owner confirms independently with only its OWN signed link side
				// (binding the friend keys from the SAS-verified pairing). No friend-link exchange.
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
				// Leaving the trust screen closes the listening window: forward the phone's
				// listening token (receiver side) and/or pin (requester side) so the coordinator
				// invalidates that window. A bare cancel (neither present) only sweeps expired
				// windows, so it stays a no-op success.
				return { cancelled: crossDomain.cancel({ listeningToken: op.listeningToken, pin: op.pin }) };
			}

			case "cross_domain_share": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				// Store under the CANONICAL gateway/name key, the same form the relay gate, the
				// sweep, and discovery compare against; a bare-name share would otherwise never
				// match and silently never take effect.
				const canonicalTarget = await assertShareable(op.sessionTarget, op.domainId);
				crossDomainShare.share(canonicalTarget, op.domainId);
				return { ok: true };
			}

			case "cross_domain_unshare": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				// An unshare is always allowed (it only revokes): no kind/linked gate, so a
				// session whose kind changed or a now-unlinked Domain can still be cleaned up.
				// Canonicalize so an unshare keys identically to the share it withdraws.
				const canonicalTarget = canonicalShareTarget(op.sessionTarget);
				const removed = crossDomainShare.unshare(canonicalTarget, op.domainId);
				// Un-share must bite in-flight too, not just on the next fresh send: settle any
				// already-accepted cross-Domain job for this (session, friend) pair so its reply is
				// dropped at the destination rather than forwarded home. Only when the share
				// actually changed (an idempotent re-unshare has nothing in flight to close).
				if (removed) crossDomainShare.expireSessionJobs(canonicalTarget, op.domainId);
				return { ok: true };
			}

			case "cross_domain_list_shares": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				return { shares: crossDomainShare.listShares() };
			}

			case "cross_domain_list_peers": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// A fresh read of the peer set (not cached): the console unions these with its
				// discovery-derived Domains so a just-linked peer appears even while offline.
				return crossDomain.listPeers();
			}

			case "cross_domain_unlink": {
				if (!unlinkDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				// Local cleanup only: forget every peer gateway of the Domain, every share to
				// it, and settle its in-flight jobs (so they fail fast instead of stalling to
				// TTL once the sealer refuses the unlinked peer). Idempotent - an already-unlinked
				// Domain returns zero counts, no error. The phone separately owner-signs + submits
				// the link-edge revocation so the Router drops its relay-affinity edge.
				return unlinkDomain(op.domainId);
			}
		}
	}

	/** The canonical `gateway/name` key a session is shared under, the single form every
	 * read path (the relay gate, the sweep, discovery) compares against. A bare name resolves
	 * to this Gateway; an already-qualified local name is preserved. */
	function canonicalShareTarget(sessionTarget: string): string {
		return TeamAddress.local(localGatewayId, parseQualifiedTeam(sessionTarget).name).canonical;
	}

	/** Gate a share request and return the CANONICAL key to store it under: the session must
	 * be a LOCAL session of a shareable kind (devcontainer or loose ONLY - never the host-agent
	 * "gateway", the cli "host", or a console-kind team) and the friend Domain must be one the
	 * owner has actually linked. Resolves the kind from the local team registry the way teams()
	 * classifies them. */
	async function assertShareable(sessionTarget: string, domainId: string): Promise<string> {
		if (!crossDomainShare?.isLinkedDomain(domainId)) {
			throw new Error(`cannot share to "${domainId}": not a linked Domain`);
		}
		const { gatewayId, name } = parseQualifiedTeam(sessionTarget);
		if (gatewayId && gatewayId !== localGatewayId) {
			throw new Error(`cannot share "${sessionTarget}": only local sessions can be shared`);
		}
		const teams = (await routes.teams().json()) as TeamInfo[];
		const target = teams.find((t) => t.team === name);
		if (!target || (target.kind !== "devcontainer" && target.kind !== "loose")) {
			throw new Error(`cannot share "${name}": only devcontainer and loose sessions can be shared`);
		}
		return TeamAddress.local(localGatewayId, name).canonical;
	}

	async function runFrame(frame: OpenedConsoleFrame): Promise<ConsoleReplyBody> {
		try {
			// Bind/refresh the peer on every frame so a send arriving before an
			// explicit register still routes its replies back to the mailbox.
			// Only a register op may rebind an install to a new device name / key.
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
			return { ok: false, error: (err as Error).message };
		}
	}

	function handleFrame(frame: OpenedConsoleFrame): Promise<ConsoleReplyBody> {
		// Reads (register/poll/list_teams) run fresh every call: they have no side
		// effect to dedupe and must reflect live state (e.g. the current epoch).
		if (!isMutatingOp(frame.op)) return runFrame(frame);

		// Mutating ops are idempotent per (conversation, opId): a retried opId
		// replays the original reply and a concurrent retry coalesces onto the
		// same in-flight promise, so the side effect happens once.
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
		// A failed op performed no side effect, so it must be retriable: drop it
		// from the cache so a retry re-runs rather than replaying the failure.
		void promise
			.then((reply) => {
				if (!reply.ok) opCache.get(conv)?.delete(frame.opId);
			})
			.catch(() => {});
		return promise;
	}

	return { handleFrame, ensurePeer, removePeer };
}
