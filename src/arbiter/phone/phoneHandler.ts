import type { DeviceMailboxStore } from "../../shared/device-mailbox.js";
import {
	composeConvSessionId,
	type MailboxInput,
	PHONE_PROTOCOL_VERSION,
	type PhoneOp,
	type PhoneOpResult,
	type PhoneRelayFrame,
	type PhoneRelayReply,
	parseQualifiedTeam,
	qualifyTeam,
} from "../../shared/phone-protocol.js";
import type { TeamInfo } from "../../shared/types.js";
import { type ConversationRegistry, RESERVED_TEAM_NAMES, type TeamRegistry } from "../websocket.js";
import { PhonePeer } from "./phonePeer.js";

////////////////////////////////
//  Interfaces & Types

/** The subset of arbiter HTTP routes the phone handler reuses. */
export interface PhoneRoutes {
	send: (req: Request, body: Record<string, unknown>) => Promise<Response>;
	respond: (req: Request, body: Record<string, unknown>) => Response;
	teams: () => Response;
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

export interface PhoneHandlerDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	mailboxStore: DeviceMailboxStore;
	routes: PhoneRoutes;
	/** This Host's id, returned on register so the phone anchors its composite
	 * (host, name) key, and used to canonicalize a send target to the qualified
	 * session-id form (matching routes.send). */
	localHostId: string;
	sendBoundMs?: number;
	/** True when the name belongs to a devcontainer project (catalog or known
	 * paths). A device must not take such a name: while the project sleeps, the
	 * phone's virtual peer would squat the registry slot, absorb sends meant for
	 * the project, and suppress its wake. */
	isProjectName?: (name: string) => boolean;
}

////////////////////////////////
//  Functions & Helpers

const FAKE_REQ = new Request("http://arbiter/phone");

// Bound on how long a phone send op may block inside the relay. The arbiter's
// own wake path can hold /send for up to WAKE_TIMEOUT_MS (10 min), far past
// evie's opId hold; past this bound the op returns the deterministic session id
// and the wake/send continues in the background, with the eventual answer
// landing in the mailbox via the persistent conversation.
const SEND_BOUND_MS = 25_000;

// Ceiling on a poll's long-poll hold. Must clear the relay chain with headroom:
// evie holds the phone's HTTP request 55s and the apiserver proxy allows 60s.
const HOLD_CAP_MS = 45_000;

// At-most-once side effects: the phone->evie->arbiter path is at-least-once
// (a lost reply makes the phone retry the same opId), so a seen opId replays its
// cached reply instead of re-running the op (which would duplicate a
// channel_push / response_push). Only mutating ops are cached, only on success
// (a failed op had no side effect and must be retriable), and the cache is
// keyed per conversation so one install cannot evict or read another's entry.
const MAX_OPS_PER_CONVERSATION = 256;
// Per-conversation cap on remembered inbound session ids the phone may respond to.
const MAX_INBOUND_SESSIONS = 500;

function isMutatingOp(op: PhoneOp): boolean {
	return op.kind === "send" || op.kind === "respond";
}

export function createPhoneHandler({
	registry,
	conversationRegistry,
	mailboxStore,
	routes,
	localHostId,
	sendBoundMs = SEND_BOUND_MS,
	isProjectName,
}: PhoneHandlerDeps) {
	// The per-install conversationId is the real identity: it keys the mailbox,
	// the registry sub, and this binding to the human-facing device name. The
	// name is a display/target label only, so two devices sharing a name never
	// share a slot, and a conversation cannot silently switch names.
	const bindings = new Map<string, string>();
	// conversationId -> session ids of agent messages delivered to this device.
	// A phone may only respond to a thread it actually received.
	const inboundSessions = new Map<string, Set<string>>();
	// conversationId -> (opId -> in-flight/settled reply) for mutating-op idempotency.
	const opCache = new Map<string, Map<string, Promise<PhoneRelayReply>>>();

	// Peer lifetime equals mailbox lifetime: when a mailbox is evicted (idle
	// sweep or store cap), the registry/conversation entries and binding go too.
	mailboxStore.setOnEvict((conversationId) => removePeer(conversationId));

	function recordInbound(conversationId: string, sessionId: string): void {
		let set = inboundSessions.get(conversationId);
		if (!set) {
			set = new Set();
			inboundSessions.set(conversationId, set);
		}
		set.add(sessionId);
		if (set.size > MAX_INBOUND_SESSIONS) {
			const oldest = set.values().next().value;
			if (oldest !== undefined) set.delete(oldest);
		}
	}

	/** Append only if the conversation is still live, so a late continuation
	 * cannot resurrect a torn-down (evicted) mailbox. Gated on conversation
	 * liveness, not the device name: a rename keeps the same conversation, so its
	 * in-flight reply still belongs here. */
	function appendIfLive(conversationId: string, entry: MailboxInput): void {
		const box = mailboxStore.get(conversationId);
		if (!box || !bindings.has(conversationId)) return;
		box.append(entry);
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

	function ensurePeer(device: string, conversationId: string, allowRebind = false): PhonePeer {
		// A register op may rename the device: migrate the registry sub off the
		// old name (mailbox and binding are conversation-keyed, so they carry
		// over) before the identity checks see the stale binding.
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

		assertValidIdentity(device, conversationId);
		mailboxStore.ensure(conversationId);

		let subs = registry.get(device);
		if (!subs) {
			subs = new Map();
			registry.set(device, subs);
		}

		const existing = subs.get(conversationId) as unknown as PhonePeer | undefined;
		if (existing) {
			existing.data.isStale = false;
			// Self-heal the conversation pointer if a (since closed) real socket
			// ever displaced it.
			conversationRegistry.set(conversationId, existing.asWs());
			return existing;
		}

		const peer = new PhonePeer(
			() => mailboxStore.ensure(conversationId),
			device,
			conversationId,
			conversationId,
			(sessionId) => recordInbound(conversationId, sessionId),
		);
		subs.set(conversationId, peer.asWs());
		conversationRegistry.set(conversationId, peer.asWs());
		bindings.set(conversationId, device);
		return peer;
	}

	function removePeer(conversationId: string): void {
		const device = bindings.get(conversationId);
		bindings.delete(conversationId);
		inboundSessions.delete(conversationId);
		opCache.delete(conversationId);
		mailboxStore.delete(conversationId);

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

	async function dispatch(op: PhoneOp, device: string, conversationId: string): Promise<PhoneOpResult> {
		switch (op.kind) {
			case "register": {
				const box = mailboxStore.ensure(conversationId);
				return { device, hostId: localHostId, cursor: box.highWater, epoch: box.epoch };
			}

			case "list_teams": {
				const teams = (await routes.teams().json()) as TeamInfo[];
				// A phone does not list other phones as send targets, and excludes
				// itself. teams() already drops the cli "host" daemon; the "arbiter"
				// host-agent stays (kind "host"), reachable from the phone.
				return {
					teams: teams.filter((t) => t.team !== device && t.kind !== "phone"),
				};
			}

			case "send": {
				// Online CLI-mode targets answer synchronously through /send's blocking
				// wait, far past any relay hold. Reject those up front. A SLEEPING
				// CLI team is unknowable here (mode surfaces only on register), so
				// it pays a wake and is then rejected by the route's channelOnly
				// check instead of minting a random session id.
				// The phone may target a host-qualified name (`host/name`); strip the
				// host for the local registry probe. Cross-host targets are rejected
				// by routes.send (federation routing is a later phase).
				const localTarget = parseQualifiedTeam(op.to).name;
				const targetSubs = registry.get(localTarget);
				if (targetSubs) {
					for (const [, ws] of targetSubs) {
						if (!ws.data.virtual && ws.readyState === 1 && ws.data.mode === "cli") {
							throw new Error(
								`"${localTarget}" is a CLI-mode agent; phone chat supports channel-mode (Claude) teams only`,
							);
						}
					}
				}

				// Canonical qualified session id, matching what routes.send composes,
				// so the backgrounded-send path hands back the same id the in-time
				// path would.
				const expectedSession = composeConvSessionId(conversationId, qualifyTeam(localHostId, localTarget));
				const sendPromise = routes.send(FAKE_REQ, {
					from: device,
					fromConversationId: conversationId,
					to: op.to,
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
							if (res.ok) return;
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
				return { session_id: json.session_id ?? "", status: json.status ?? "running" };
			}

			case "respond": {
				// A phone may only settle a thread that was delivered to it. This
				// blocks forging another conversation's reply and, critically, keeps
				// op.session_id away from resolveHandshake (handshake ids are never
				// recorded as inbound).
				if (!inboundSessions.get(conversationId)?.has(op.session_id)) {
					throw new Error(`Unknown session_id; you can only respond to a thread delivered to this device`);
				}
				const res = routes.respond(FAKE_REQ, {
					session_id: op.session_id,
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
				// opId-cached; the phone dedupes entries by seq).
				const box = mailboxStore.ensure(conversationId);
				let snap = box.drain(op.cursor ?? 0, op.epoch);
				const hold = Math.min(op.holdMs ?? 0, HOLD_CAP_MS);
				if (snap.entries.length === 0 && hold > 0) {
					await box.waitForAppend(hold);
					snap = box.drain(op.cursor ?? 0, op.epoch);
				}
				return { entries: snap.entries, cursor: snap.cursor, dropped: snap.dropped, epoch: snap.epoch };
			}
		}
	}

	async function runFrame(frame: PhoneRelayFrame): Promise<PhoneRelayReply> {
		try {
			// Bind/refresh the peer on every frame so a send arriving before an
			// explicit register still routes its replies back to the mailbox.
			// Only a register op may rebind an install to a new device name.
			ensurePeer(frame.device, frame.conversationId, frame.op.kind === "register");
			const result = await dispatch(frame.op, frame.device, frame.conversationId);
			return { type: "phone_relay_reply", v: PHONE_PROTOCOL_VERSION, opId: frame.opId, ok: true, result };
		} catch (err) {
			return {
				type: "phone_relay_reply",
				v: PHONE_PROTOCOL_VERSION,
				opId: frame.opId,
				ok: false,
				error: (err as Error).message,
			};
		}
	}

	function handleFrame(frame: PhoneRelayFrame): Promise<PhoneRelayReply> {
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
