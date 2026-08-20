import type { BoardAttachmentStore } from "../../shared/board-attachment-store.js";
import type {
	ConsoleOp,
	ConsoleOpResult,
	ConsoleReplyBody,
	CrossDomainShareTarget,
	OpenedConsoleFrame,
} from "../../shared/console-protocol.js";
import type { ConsolePushEntry } from "../../shared/federation-protocol.js";
import {
	ALLOWED_KEYS,
	type HostListDirsResult,
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	isWorkdirPath,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import { DomainStatusSchema } from "../../shared/schemas.js";
import { composeSessionName, SpawnPoint, storeKey } from "../../shared/session-id.js";
import { sanitizeLabel } from "../../shared/session-sanitize.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { TeamInfo } from "../../shared/types.js";
import { answerBlobOp } from "../blobOps.js";
import { type BoardDisposition, type BoardResult, type BoardStore, OWNER_ACTOR, refusalError } from "../boardStore.js";
import { readAnchorsPlaneName } from "../readAnchors.js";
import { createConsoleDevices } from "./consoleDevices.js";
import { createConsoleTargets } from "./consoleTargets.js";
import {
	type ConsoleHandlerDeps,
	CREATE_SESSION_BOUND_MS,
	CreateSessionAmbiguousError,
	FAKE_REQ,
	friendlyPeekError,
	HOLD_CAP_MS,
	isBoardMutationKind,
	isMutatingOp,
	SEND_BOUND_MS,
	type SendRouteJson,
} from "./consoleTypes.js";
import { buildPollParticipants, type PollPiggyback } from "./pollPlanes.js";

export type { ConsoleHandlerDeps, ConsoleRoutes } from "./consoleTypes.js";
export { CREATE_SESSION_BOUND_MS } from "./consoleTypes.js";

////////////////////////////////
//  Functions & Helpers

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
	capabilityStore,
	domain,
	domainStatus,
	planeRegistry,
	presence,
	intentTracker,
	readAnchors,
	boardStore,
	crossDomainPresenceConsumer,
	linkedDomainIds,
	blobStore,
	boardAttachments,
	fetchBlobFromGateway,
	relayToHost,
	tryWakeTeam,
	isWakeInFlight,
	markCreateInFlight,
	awaitRegister,
	crossDomain,
	crossDomainShare,
	unlinkDomain,
	untrustOwner,
	durableOpStore,
}: ConsoleHandlerDeps) {
	// The one owner of target resolution and the foreign-Gateway refusal (see consoleTargets.ts).
	const targets = createConsoleTargets({ localDomainId, localGatewayId, isProjectName });

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

	// The one owner of every device's peer state, key binding and idempotency cache (see consoleDevices.ts).
	const devices = createConsoleDevices({
		registry,
		conversationRegistry,
		mailboxStore,
		isProjectName,
		// Qualified in stays itself, a bare local team gains this Gateway, a Device Name stays raw.
		qualifyFrom: (from) => {
			try {
				return targets.parse(from).canonical;
			} catch {
				return from;
			}
		},
		// A conversation held HERE must reach the Gateway the console polls (see ConsolePeer's doc).
		fanOut: (entry) => {
			void routes.fanOutConsolePush?.(entry as ConsolePushEntry, crypto.randomUUID());
		},
	});

	function requireBoard(): BoardStore {
		if (!boardStore) throw new Error("task board is not available on this Gateway");
		return boardStore;
	}

	function requireBoardAttachments(): BoardAttachmentStore {
		if (!boardAttachments) throw new Error("task board attachments are not available on this Gateway");
		return boardAttachments;
	}

	function boardWrite(result: BoardResult): { applied: true } {
		if (!result.applied) throw refusalError(result.refused);
		return { applied: true };
	}

	async function dispatch(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		ownerId: string,
		opId: string,
		ownerSignPub: string,
		// The generation `durableOpStore.markInFlight` minted for THIS dispatch attempt (send/respond
		// only; 0 and unused otherwise) - closed over by a case's deferred continuation so its own
		// eventual `durableOpStore.clear()` can tell itself apart from a still-live newer attempt.
		generation = 0,
	): Promise<ConsoleOpResult> {
		switch (op.kind) {
			case "register": {
				const box = mailboxStore.ensure(ownerId);
				capabilityStore?.report(conversationId, op.enabledPlugins, op.clientVersion);
				console.log(
					`[console register] conv=${conversationId.slice(0, 12)} owner=${ownerId.slice(0, 12)} dev=${device} build=${op.clientVersion ?? "?"}/${op.clientVariant ?? "?"} -> cursor=${box.highWater} epoch=${box.epoch}`,
				);
				// Validate the Router-sourced Domain status against the closed union so a garbage
				// value is dropped, not forwarded. Omitted when unknown (pre-feature Router), so the
				// app falls back to the already-rooted path. The value is "rooted" or "unrooted"
				// (a fresh admin Domain), never "pending" (the app learns that from the
				// provisioning blob's pendingTenant and first-roots directly at the Router).
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
				// first_root is decided at the Router, never on a Gateway: a pending friend Domain has no
				// Gateway yet, and the pre-root console has no admission, so the self-signed frame
				// cannot even open here (the consoleSealer requires an admitted kind:console). The
				// app POSTs the SignedFirstRoot directly to the Router's console bridge. Reject explicitly
				// so a misrouted frame fails clear rather than falling through.
				throw new Error("first_root is handled directly at the Router, not through a Gateway");
			}

			case "list_teams": {
				// Fan out across the mesh so the console sees every Gateway's sessions, each
				// carrying its own `gatewayId` (the console keys threads by domain.gateway.spawn.session).
				const { teams, coverage } = await routes.discoverFull();
				// A console does not list other consoles as send targets, and excludes itself.
				// teams() already drops the headless "host" daemon.
				return {
					teams: teams.filter((t) => t.team !== device && t.kind !== "console"),
					coverage,
				};
			}

			case "send": {
				// Canonical session id matching what routes.send composes, so the backgrounded-send
				// path hands back the same id the in-time path would. The target resolves to its
				// Address; keyed by ownerId, so every device of the owner shares the one thread. A
				// spawn-point target has no session (routes rejects it), so it has no pre-computed id.
				const targetAddr = targets.parse(op.to);
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
					//
					// The durable op record (marked in-flight before this case ran) MUST stay in-flight
					// past this point - the "running" reply below is not the real settlement, it only
					// means the send has not finished yet. The background continuation below is the
					// true settle point and marks the durable record itself.
					void sendPromise
						.then(async (res) => {
							if (res.ok) {
								// Mark durably complete BEFORE the best-effort mailbox mirror: the send itself
								// already succeeded, so a throw from appendIfLive must not be able to erase that
								// (clear() on an already-complete record is a no-op, see durableOpStore.ts).
								durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), {
									session_id: expectedSession,
									status: "sent",
								});
								// Backgrounded success: mirror the sent message like the in-time path. Guarded
								// like the fast path's own mirror below - a throw here must not be allowed to
								// permanently lose the "sent:" echo with no retry able to re-trigger it (a
								// retry of this now-complete opId would only ever replay the stored result).
								try {
									devices.appendIfLive(
										conversationId,
										{
											kind: "sent",
											session_id: expectedSession,
											opId,
											body: op.body,
											files: op.files,
										},
										`sent:${conversationId}:${opId}`,
									);
								} catch {
									// Best-effort mirror only; the durable completion above is what matters.
								}
								return;
							}
							const json = (await res.json().catch(() => ({}))) as SendRouteJson;
							devices.appendIfLive(conversationId, {
								kind: "reply",
								session_id: expectedSession,
								status: "error",
								body: json.error ?? `send to "${op.to}" failed`,
							});
							// The opCache still holds the optimistic "running" reply from the moment this
							// case first returned - drop it too (iff this is still the current attempt), or
							// a same-process retry replays that stale success forever instead of re-attempting.
							evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
						})
						.catch(() => {
							evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
						});
					return { session_id: expectedSession, status: "running" };
				}

				const json = (await winner.json()) as SendRouteJson;
				if (!winner.ok) throw new Error(json.error ?? "send failed");
				// Mirror the owner's own outgoing message to all their devices. The sender
				// reconciles it against its optimistic row by opId; the owner's other devices render
				// it under the same thread. The dedupeKey keeps the echo idempotent across a gateway
				// restart (the persisted seenKeys absorbs a reconcile re-send of the same opId).
				const sendResult = { session_id: json.session_id ?? "", status: json.status ?? "running" };
				durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), sendResult);
				try {
					devices.appendIfLive(
						conversationId,
						{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
						`sent:${conversationId}:${opId}`,
					);
				} catch {
					// The send already succeeded and is durably complete - unlike the backgrounded path
					// (whose initial cached reply is already ok:true before this ever runs), a throw HERE
					// would propagate out as {ok:false} and get permanently opCache-cached: clear() is a
					// no-op on an already-complete record, so nothing would ever evict the false failure.
				}
				return sendResult;
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
					{
						// The console is a human replying via the app, never an agent; the mirror tap
						// reads this to skip agent-to-agent peer mirroring for this reply.
						consoleSender: true,
						// A cross-Gateway reply-pin settles LATER than this call returns (routes.respond
						// starts the relay and returns immediately) - only that later settlement is the
						// durable op's true completion; see the federated check below.
						onFederatedSettled: durableOpStore
							? (ok) => {
									if (ok) {
										durableOpStore.markComplete(conversationId, durableOpKey(op.kind, opId), {
											delivered: true,
										});
									} else {
										// Same reasoning as the backgrounded send above: only evict the opCache
										// entry (which already holds the optimistic "delivered" reply this case
										// returned synchronously) if this is still the current attempt.
										evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
									}
								}
							: undefined,
					},
				);
				const json = (await res.json()) as { error?: string; federated?: boolean; delivered?: boolean };
				if (!res.ok) throw new Error(json.error ?? "respond failed");
				// federated: durably completing here would stamp "delivered" before the relay-pin
				// above has actually landed - onFederatedSettled owns that case. A share-withdrawn
				// "unshared" drop (delivered:false) also skips the federated flag but is NOT a success -
				// durably completing it would stamp a false {delivered:true} that outlives the drop for
				// up to 14 days across restarts. Every other outcome (a genuine local deliver) is
				// already fully settled by now.
				if (!json.federated) {
					if (json.delivered === false) {
						// Not just a durable clear: dispatch()'s own reply here is {delivered:true} regardless
						// (unchanged pre-existing behavior), so the promise handleFrame already cached resolves
						// ok:true - only evicting the durable record would leave that false-success reply
						// permanently replayed to any same-process retry for as long as the opCache entry lives.
						evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
					} else {
						durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), { delivered: true });
					}
				}
				return { delivered: true };
			}

			case "poll": {
				// Declare (refresh) this device's focus intent so the daemon's derivation cadence can
				// ramp to what is actually being watched. A poll with no focus (a legacy console, or
				// one between declarations) leaves any existing declaration to expire on its own TTL
				// rather than clearing it early - see IntentTracker's own doc.
				if (op.focus) {
					// The console names its focus by qualified address; cadenceFor compares against the
					// BARE presence team. Stored verbatim, the compare could never be true and every
					// terminal sat at the background cadence. A foreign address stays as-is (it matches
					// nothing here, correctly - that session's cadence belongs to its own Gateway).
					const declared = op.focus.terminalTeam;
					const local = declared === undefined ? null : targets.tryLocalName(declared);
					intentTracker?.declare(
						conversationId,
						local === null ? op.focus : { ...op.focus, terminalTeam: local },
					);
				}

				// Long-poll: an empty drain holds the op open (bounded under the relay-chain
				// timeouts) until an append or a presence bump wakes it, then drains/rechecks again.
				// The pump runs frames concurrently, so a held poll blocks nothing, and retried polls
				// just become additional waiters (reads are not opId-cached; the console dedupes
				// entries by seq).
				const box = mailboxStore.ensure(ownerId);
				let snap = box.drain(op.cursor ?? 0, op.epoch, conversationId);
				const hold = Math.min(op.holdMs ?? 0, HOLD_CAP_MS);

				// Every plane's whole poll participation (gate, presented map, lazy registration,
				// hold wake-up, emission) lives in its participant; the array's order IS the settled
				// priority. Built pre-hold so a plane's first bump can wake the held poll.
				const participants = buildPollParticipants({
					op,
					ownerId,
					localGatewayId,
					planeRegistry,
					presence,
					readAnchors,
					boardStore,
					crossDomainPresenceConsumer,
					linkedDomainIds,
					domain,
				});

				// Hold when nothing is NEW for this device, not when nothing is retained for anyone.
				// The box compacts only to the slowest consumer, so a stale one (a reinstall leaves its
				// old conversationId behind until the idle sweep) pins entries this device has long
				// since acked. Gating on the retained count made every poll answer instantly with
				// entries the console discards, a busy-loop at the poll floor for up to the sweep TTL.
				// The retained entries still ship: a genuinely behind cursor needs them, and the console
				// dedupes by seq.
				const cursor = op.cursor ?? 0;
				const nothingNew = (s: typeof snap) => s.entries.every((e) => e.seq <= cursor);
				if (nothingNew(snap) && hold > 0) {
					const waits: Promise<unknown>[] = [box.waitForAppend(hold)];
					for (const p of participants) if (p.wait) waits.push(p.wait(hold));
					await Promise.race(waits);
					snap = box.drain(cursor, op.epoch, conversationId);
				}
				// Log only a poll that hands entries to the console or signals a dropped-entry gap,
				// never the steady stream of empty held polls. This is the one window into whether a
				// reply reached the console's poll.
				if (snap.entries.length > 0 || snap.dropped > 0) {
					console.log(
						`[console poll] conv=${conversationId.slice(0, 12)} reqCursor=${op.cursor ?? 0} reqEpoch=${op.epoch ?? "none"} -> drained=${snap.entries.length} retCursor=${snap.cursor} retEpoch=${snap.epoch} dropped=${snap.dropped}`,
					);
				}
				// Mailbox entries are why a console polls at all, so they outrank every plane; the
				// hold elapsing with nothing new is the fallback. The Console's instant-empty-response
				// heuristic (its old-gateway degradation signal) reads `settled` so a plane-only
				// settle never trips its backoff. Changed planes emit even on a mailbox settle.
				const settled =
					snap.entries.length > 0
						? ("mailbox" as const)
						: (participants.find((p) => p.changed())?.settledAs ?? ("timeout" as const));
				let piggyback: PollPiggyback = {};
				for (const p of participants) {
					if (p.changed()) piggyback = { ...piggyback, ...p.emit() };
				}
				return {
					entries: snap.entries,
					cursor: snap.cursor,
					dropped: snap.dropped,
					epoch: snap.epoch,
					...piggyback,
					settled,
				};
			}

			case "report_read": {
				if (!readAnchors) throw new Error("read-anchor sync is not available on this Gateway");
				const advanced = readAnchors.report(ownerId, op.team, { epoch: op.epoch, seq: op.seq, at: Date.now() });
				if (advanced) planeRegistry?.markDirty(readAnchorsPlaneName(ownerId));
				return { advanced };
			}

			// Task board ops. A REFUSAL throws with the "refused: " prefix, landing as ok=false inside
			// the sealed reply - the one shape the console's queue may retire an action on. Any other
			// throw (disk trouble included) carries no prefix and the queue retries it.
			//
			// Every one of these acts as the OWNER: the console is the owner's own device, and the
			// owner's authority over the whole board is what lets it reassign a session's work.
			case "board_upsert": {
				return boardWrite(
					requireBoard().upsert(
						ownerId,
						op.entries.map((e) =>
							e.sessionId === undefined ? e : { ...e, sessionId: targets.boardSessionKey(e.sessionId) },
						),
						OWNER_ACTOR,
					),
				);
			}
			case "board_set_state": {
				return boardWrite(requireBoard().setState(ownerId, op.id, op.state, OWNER_ACTOR));
			}
			case "board_set_title": {
				return boardWrite(requireBoard().setTitle(ownerId, op.id, op.title, OWNER_ACTOR));
			}
			case "board_set_body": {
				return boardWrite(requireBoard().setBody(ownerId, op.id, op.body, OWNER_ACTOR));
			}
			case "board_set_attachments": {
				// Resolve EVERY member before adopting any, and store only what resolved.
				//
				// Presence is checked DURABLE-FIRST: the list is absolute, so every write re-states the
				// survivors, and months after their cached copies were swept a cache-only check would
				// find nothing.
				//
				// A member that resolves nowhere is DROPPED rather than failing the op, which is what
				// keeps this op always satisfiable. Making it an error instead means the console retries
				// forever (only a refusal retires a queued action) and eventually closes that Gateway's
				// whole lane; making it a refusal instead discards the owner's good attach along with
				// the dead one. Dropping keeps the plan's invariant - every STORED member is durable
				// under its entry - true by construction rather than by a precondition the caller has to
				// meet. The one exception is a member the sender says it is still uploading, which is a
				// genuine race and stays retryable.
				const attachments = requireBoardAttachments();
				// Before adopting anything: bytes copied under an entry the board does not hold are
				// reachable by neither reclaim site, so they would sit there for good.
				if (!requireBoard().entry(ownerId, op.id)) throw refusalError("entry_missing");
				const supplied = op.supplied;
				const resolved: Array<{ a: (typeof op.attachments)[number]; cached?: string }> = [];
				const dropped: string[] = [];
				for (const a of op.attachments) {
					if (attachments.has(ownerId, op.id, a.blobId)) {
						resolved.push({ a });
						continue;
					}
					const cached = blobStore?.path(a.blobId);
					if (cached) {
						resolved.push({ a, cached });
						continue;
					}
					// Absent `supplied` is an older console that cannot declare, so every member is
					// treated as possibly-arriving and the op stays retryable, as it was before.
					if (!supplied || supplied.includes(a.blobId)) {
						throw new Error(`attachment ${a.blobId} has not finished uploading`);
					}
					dropped.push(a.filename);
				}
				// Adopt only once every member is accounted for, so a partial pass cannot leave bytes
				// under an entry whose stored list never names them.
				for (const r of resolved) {
					if (r.cached) attachments.adopt(ownerId, op.id, r.a.blobId, r.cached);
				}
				if (dropped.length > 0) {
					console.warn(
						`[task-board] ${op.id}: dropped ${dropped.length} attachment(s) with no bytes anywhere`,
					);
				}
				const result = requireBoard().setAttachments(
					ownerId,
					op.id,
					resolved.map((r) => r.a),
					OWNER_ACTOR,
				);
				boardWrite(result);
				return { applied: true, ...(dropped.length > 0 ? { dropped } : {}) };
			}
			case "board_set_parent": {
				return boardWrite(requireBoard().setParent(ownerId, op.id, op.parent, op.rank, OWNER_ACTOR));
			}
			case "board_set_trashed": {
				return boardWrite(requireBoard().setTrashed(ownerId, op.id, op.trashed));
			}
			case "board_set_session": {
				// The one existence check the store cannot make itself: an assign must name a session
				// this Gateway knows (a cross-Gateway assign MOVES the entry first, so the target is
				// always local). Unassign (absent sessionId) needs no such check.
				const sessionId = op.sessionId === undefined ? undefined : targets.boardSessionKey(op.sessionId);
				if (sessionId !== undefined && sessionStore && !sessionStore.getByTeam(sessionId)) {
					throw refusalError("session_missing");
				}
				return boardWrite(requireBoard().setSession(ownerId, op.id, sessionId));
			}
			case "board_remove": {
				return boardWrite(requireBoard().remove(ownerId, op.ids));
			}
			case "board_read": {
				const board = requireBoard();
				board.ensureRegistered(ownerId);
				const projection = board.projection(ownerId);
				return { entries: projection.entries, ...(projection.truncated ? { truncated: true } : {}) };
			}

			case "peek": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				const target = targets.tmuxTarget(op.target);
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
				const target = targets.tmuxTarget(op.target);
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

			case "list_dirs": {
				// The directory picker's type-ahead read: host filesystem only, runs fresh (not in
				// isMutatingOp), same boundary validation as create_session's workdir.
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				if (!isWorkdirPath(op.path)) throw new Error("invalid path: must be absolute or ~-rooted");
				const r = await relayToHost({ kind: "listDirs", path: op.path });
				if (!r.ok) throw new Error(r.error ?? "list failed");
				const listed = r.result as HostListDirsResult;
				return { entries: listed.entries, ...(listed.truncated ? { truncated: true } : {}) };
			}

			// Blob transfer. Deliberately outside isMutatingOp's dedup: a re-put of the same offset
			// is already a no-op in the store (the digest names the content), so opId bookkeeping
			// would add a second, weaker idempotency mechanism on top of a stronger one.
			case "blob_stat":
			case "blob_put":
			case "blob_get":
				// The console asks its ROUTE Gateway for everything, which is regularly not the one
				// holding the bytes; the fetcher closes that gap behind this call.
				return answerBlobOp(blobStore, op, fetchBlobFromGateway, boardAttachments);

			case "create_session": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				if (!op.sessionName && !op.displayLabel) {
					throw new Error("create_session needs a sessionName or a displayLabel");
				}
				// A picked workdir must be a safe path shape before it can touch the record or the
				// launch (fail fast; the store and daemon re-guard). Host sessions only - a
				// devcontainer's workdir is fixed, so a picked one there is a caller bug.
				if (op.workdir != null && !isWorkdirPath(op.workdir)) {
					throw new Error("invalid workdir: must be an absolute or ~-rooted path");
				}
				// Computed once, directly from the request's own displayLabel - never by comparing the
				// eventual sessionLabel/id after the fact, which would race a concurrent rename landing on
				// the same record before this op's reply is constructed. False whenever no displayLabel was
				// sent (the sessionName-adopted path's sessionLabel legitimately defaults to the id itself,
				// unrelated to sanitization).
				const labelSanitized = op.displayLabel != null && sanitizeLabel(op.displayLabel) === null;
				// Resolved BEFORE the mint below: tmuxTarget rejects a foreign address too, but only
				// after a local record has been minted under the foreign spawn name.
				const spawn = targets.localSpawn(op.target);
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
						workdirPath: op.workdir,
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
						workdirPath: op.workdir,
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
					const target = targets.tmuxTarget(op.target, sessionId);
					// The host workdir hint (the daemon opens a host session there, ignoring it for a
					// devcontainer). The store owns the workdirPath-over-workdirHint-over-sessionLabel
					// precedence, so this matches the wake path: a display-label collision (label deduped
					// to "-2", workdirHint pinned to the original) opens the same dir, and a picked path
					// wins over both. The daemon guards traversal too.
					const workdirHint =
						sessionStore && adopted ? sessionStore.hostWorkdirHint(adopted.record) : (op.workdir ?? label);

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
									sessionToken: adopted ? sessionStore?.ensureBindToken(adopted.record) : undefined,
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
				const target = targets.tmuxTarget(op.target);
				assertDaemonDrivable(target);
				const dedupKey = `${conversationId}:${opId}`;
				const r = await relayToHost({ kind: "reloadPlugins", target, dedupKey });
				if (!r.ok) throw new Error(r.error ?? "reload failed");
				return { initiated: true };
			}

			case "forget": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				// Resolved HERE, ahead of the tmux resolution whose refusal the kill try below
				// deliberately swallows: the record drop must never run for a foreign or spawn-point
				// target.
				const { name } = targets.requireLocalComposite(op.target, "forget");
				const dedupKey = `${conversationId}:${opId}`;
				// The tmux kill is best-effort: forget's actual contract is "stop listing this session",
				// which the record drop below alone guarantees. targets.tmuxTarget can throw (the project
				// left knownTeamPaths/offlineCatalog, both reset on a gateway restart until the host's next
				// catalog scan) and the kill itself can fail (host daemon offline, a tmux/docker timeout) -
				// none of that may block the drop, or a session the user asked to forget stays stuck on the
				// board forever with no way to make it go away. An orphaned tmux pane is recoverable; a
				// permanently-stuck board tile is not.
				try {
					const target = targets.tmuxTarget(op.target);
					const r = await relayToHost({ kind: "killSession", target, dedupKey });
					if (!r.ok) console.log(`[console] forget "${name}": kill failed - ${r.error ?? "unknown error"}`);
				} catch (e) {
					console.log(`[console] forget "${name}": kill failed - ${(e as Error).message}`);
				}
				// Drop the durable resume record so the session stops listing as available. The board
				// disposition rides this one call, applied in the same store pass, so the session's
				// end and its work's end cannot be ordered wrongly against each other.
				const disposition: BoardDisposition = op.boardDisposition ?? "release";
				dropSessionResume?.(name, disposition);
				// Echoed, not assumed: a console asking for "cancel" against a Gateway that predates
				// the field gets no answer here and knows its choice was downgraded.
				return { killed: true, boardDisposition: disposition };
			}

			case "close_session": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				// Close kills ONE named session's tmux but KEEPS its record (a restart / mop-up).
				const { name } = targets.requireLocalComposite(op.target, "close");
				const target = targets.tmuxTarget(op.target);
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
				// Relabel a session's record. The record store is local, so a foreign-Gateway target
				// must be refused rather than collide with a same-named local record.
				const { name } = targets.requireLocalComposite(op.target, "rename");
				const applied = sessionStore?.rename(name, op.sessionLabel) ?? null;
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

	/** The canonical share key for an unshare, refused for a foreign address: folded to its bare
	 * field it would resolve the SAME-NAMED local session's share. */
	function canonicalShareTarget(sessionTarget: string): string {
		return targets.shareTarget(
			sessionTarget,
			() => new Error(`cannot unshare "${sessionTarget}": only local sessions have shares`),
		).canonical;
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
		const { name, canonical } = targets.shareTarget(
			sessionTarget,
			() => new Error(`cannot share "${sessionTarget}": only local sessions can be shared`),
		);
		const teams = (await routes.teams().json()) as TeamInfo[];
		const team = teams.find((t) => t.team === name);
		if (!team || (team.kind !== "devcontainer" && team.kind !== "loose")) {
			throw new Error(`cannot share "${name}": only devcontainer and loose sessions can be shared`);
		}
		return canonical;
	}

	async function runFrame(frame: OpenedConsoleFrame, generation = 0): Promise<ConsoleReplyBody> {
		try {
			// Bind/refresh the peer on every frame so a send arriving before an explicit register
			// still routes its replies back to the mailbox. Only a register op may rebind an install
			// to a new device name / key.
			const ownerId = ownerKeyId(frame.ownerSignPub);
			devices.ensurePeer(
				frame.device,
				frame.conversationId,
				frame.signerSignPub,
				ownerId,
				frame.op.kind === "register",
			);
			// Every sealed op proves this device is still here, which is what keeps a phone that only
			// polls from ageing out of the capability union it is still entitled to vote in.
			capabilityStore?.touch(frame.conversationId);
			const result = await dispatch(
				frame.op,
				frame.device,
				frame.conversationId,
				ownerId,
				frame.opId,
				frame.ownerSignPub,
				generation,
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

	/** send/respond share one opCache/durableOpStore key space keyed only by (conversationId, opId)
	 * - namespacing the DURABLE lookup by op kind means a coincidental (client-bug) opId reuse
	 * across the two kinds within one conversation can never replay the wrong-shaped result. Not
	 * applied to the in-memory opCache itself: that cache's own short, teardown/eviction-tied
	 * lifetime already bounds the pre-existing (conv, opId)-only collision window it inherits from
	 * every other mutating op kind, so widening its key space isn't worth the churn. */
	function durableOpKey(kind: string, opId: string): string {
		return `${kind}:${opId}`;
	}

	/** Drop a mutating op's in-memory opCache entry. Needed alongside `durableOpStore?.clear()`
	 * wherever a case's OWN deferred (post-return) continuation discovers a failure - the cached
	 * promise there already resolved to an optimistic success reply (the immediate "running" /
	 * "delivered" return) well before the real outcome was known, so unlike a same-tick failure
	 * (which handleFrame's generic reaction below already evicts), nothing else ever clears it.
	 *
	 * Only actually evicts when `durableOpStore.clear()` reports it genuinely cleared THIS
	 * attempt's own generation (never a no-op refusal) - if a newer attempt has since taken over
	 * the durable record, it necessarily also owns the current opCache entry, so a stale attempt's
	 * deferred failure must leave both alone. With no durable layer at all there is no generation
	 * to arbitrate by, so this falls back to the original unconditional evict. */
	function evictOpCacheIfStillOwned(conv: string, opId: string, kind: string, generation: number): void {
		if (!durableOpStore || durableOpStore.clear(conv, durableOpKey(kind, opId), generation)) {
			devices.opCacheDelete(conv, opId);
		}
	}

	/** Caches a mutating op's reply promise in-memory (the per-process single-flight/replay layer -
	 * see durableOpStore.ts's own doc for how the durable layer beneath it relates). */
	function cacheInMemory(conv: string, opId: string, promise: Promise<ConsoleReplyBody>): void {
		devices.opCacheSet(conv, opId, promise);
	}

	function handleFrame(frame: OpenedConsoleFrame): Promise<ConsoleReplyBody> {
		// Reads (register/poll/list_teams) run fresh every call: they have no side effect to dedupe
		// and must reflect live state (e.g. the current epoch).
		if (!isMutatingOp(frame.op)) return runFrame(frame);

		// Mutating ops are idempotent per (conversation, opId): a retried opId replays the original
		// reply and a concurrent retry coalesces onto the same in-flight promise, so the side effect
		// happens once.
		const conv = frame.conversationId;
		const cached = devices.opCacheGet(conv, frame.opId);
		if (cached) return cached;

		// send/respond and the board mutations additionally get a DURABLE idempotency layer,
		// consulted only on this opCache miss (a fresh process, or an evicted/torn-down entry) - see
		// durableOpStore.ts. For a board op the in-memory FIFO alone cannot be the replay defense:
		// absolute ops are not monotonic, so a retry surviving a gateway restart (or 256 intervening
		// mutating ops) would re-execute and regress a field somebody already advanced.
		const isBoardMutation = isBoardMutationKind(frame.op.kind);
		const isDurableOp = frame.op.kind === "send" || frame.op.kind === "respond" || isBoardMutation;
		let generation = 0;
		if (isDurableOp && durableOpStore) {
			const key = durableOpKey(frame.op.kind, frame.opId);
			const record = durableOpStore.get(conv, key);
			if (record?.state === "complete") {
				const replayed = Promise.resolve<ConsoleReplyBody>({ ok: true, result: record.result });
				cacheInMemory(conv, frame.opId, replayed);
				return replayed;
			}
			// Either no record (a genuinely new op) or an existing in-flight one (the crash-mid-
			// work/eviction-recovery case, today's own recovery, preserved) - either way THIS dispatch
			// takes fresh ownership of the key, so mint a new generation: the case's own deferred
			// continuation closes over it, so its eventual clear() can tell itself apart from a
			// still-newer overlapping attempt that may take over the key later.
			generation = durableOpStore.markInFlight(conv, key);
		}

		const promise = runFrame(frame, generation);
		cacheInMemory(conv, frame.opId, promise);
		// A failed op performed no side effect, so it must be retriable: drop it from the cache(s)
		// so a retry re-runs rather than replaying the failure. Completion (the durable `complete`
		// write) is NOT handled here for send/respond - both have a settlement point that can land
		// well after this promise resolves (a backgrounded send, a federated reply-pin), so each
		// marks its own durable completion directly at its true settle point (see their dispatch
		// cases). This handler only ever needs to react to failure.
		void promise
			.then((reply) => {
				if (reply.ok) {
					// A board mutation's settle point IS this resolution (the store commit was
					// synchronous), so its durable completion is marked centrally here - unlike
					// send/respond, whose true settlement can land long after (see above).
					if (isBoardMutation && reply.result) {
						durableOpStore?.markComplete(conv, durableOpKey(frame.op.kind, frame.opId), reply.result);
					}
					return;
				}
				if (isDurableOp) evictOpCacheIfStillOwned(conv, frame.opId, frame.op.kind, generation);
				else devices.opCacheDelete(conv, frame.opId);
			})
			.catch(() => {
				if (isDurableOp) evictOpCacheIfStillOwned(conv, frame.opId, frame.op.kind, generation);
				else devices.opCacheDelete(conv, frame.opId);
			});
		return promise;
	}

	return { handleFrame, ensurePeer: devices.ensurePeer, removePeer: devices.removePeer };
}
