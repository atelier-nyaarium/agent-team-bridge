import type { BoardAttachmentStore } from "../../shared/board-attachment-store.js";
import type {
	ConsoleOp,
	ConsoleOpResult,
	ConsoleReplyBody,
	CrossDomainShareTarget,
	OpenedConsoleFrame,
} from "../../shared/console-protocol.js";
import {
	ALLOWED_KEYS,
	type HostListDirsResult,
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	isSpawnWorkdirPath,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { MIGRATING } from "../../shared/migration-fence.js";
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

export function createConsoleDispatcher({
	registry,
	conversationRegistry,
	mailboxStore,
	routes,
	localGatewayId,
	localDomainId,
	sendBoundMs = SEND_BOUND_MS,
	createSessionBoundMs = CREATE_SESSION_BOUND_MS,
	isTrustedCatalogProject,
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
	const targets = createConsoleTargets({ localDomainId, localGatewayId, isTrustedCatalogProject });

	function assertDaemonDrivable(target: TmuxTarget): void {
		const record = sessionStore?.getByTeam(composeSessionName(target.name, target.sessionName));
		if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
			throw new Error(`terminal view unavailable for a user-launched session; end it from your terminal`);
		}
	}

	const devices = createConsoleDevices({
		registry,
		conversationRegistry,
		mailboxStore,
		deliver: routes.deliverToOwner,
		isTrustedCatalogProject,
		qualifyFrom: (from) => {
			try {
				return targets.parse(from).canonical;
			} catch {
				return from;
			}
		},
		capabilityStore,
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
		// Retryable fence.
		if (!result.applied && "migrating" in result) throw new Error(MIGRATING);
		// Permanent refusal retires queued action.
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
		generation = 0,
	): Promise<ConsoleOpResult> {
		switch (op.kind) {
			case "register": {
				const box = mailboxStore.ensure(ownerId);
				capabilityStore?.report(conversationId, op.enabledPlugins, op.clientVersion);
				console.log(
					`[console register] conv=${conversationId.slice(0, 12)} owner=${ownerId.slice(0, 12)} dev=${device} build=${op.clientVersion ?? "?"}/${op.clientVariant ?? "?"} -> cursor=${box.highWater} epoch=${box.epoch}`,
				);
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
				throw new Error("first_root is handled directly at the Router, not through a Gateway");
			}

			case "list_teams": {
				const { teams, coverage, spawnPoints } = await routes.discoverFull();
				return {
					teams: teams.filter((t) => t.team !== device && t.kind !== "console"),
					coverage,
					spawnPoints,
				};
			}

			case "send": {
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
						targetDomainId: op.domainId,
						body: op.body,
						files: op.files,
						channelOnly: true,
					},
					{ consoleSender: true },
				);

				let boundTimer: ReturnType<typeof setTimeout> | undefined;
				const bound = new Promise<null>((resolve) => {
					boundTimer = setTimeout(() => resolve(null), sendBoundMs);
				});
				const winner = await Promise.race([sendPromise, bound]);
				clearTimeout(boundTimer);

				if (winner === null) {
					void sendPromise
						.then(async (res) => {
							if (res.ok) {
								durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), {
									session_id: expectedSession,
									status: "sent",
								});
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
									// Best-effort mirror.
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
							evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
						})
						.catch(() => {
							evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
						});
					return { session_id: expectedSession, status: "running" };
				}

				const json = (await winner.json()) as SendRouteJson;
				if (!winner.ok) throw new Error(json.error ?? "send failed");
				const sendResult = { session_id: json.session_id ?? "", status: json.status ?? "running" };
				durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), sendResult);
				try {
					devices.appendIfLive(
						conversationId,
						{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
						`sent:${conversationId}:${opId}`,
					);
				} catch {
					// Durable completion already recorded.
				}
				return sendResult;
			}

			case "respond": {
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
						consoleSender: true,
						onFederatedSettled: durableOpStore
							? (ok) => {
									if (ok) {
										durableOpStore.markComplete(conversationId, durableOpKey(op.kind, opId), {
											delivered: true,
										});
									} else {
										evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
									}
								}
							: undefined,
					},
				);
				const json = (await res.json()) as { error?: string; federated?: boolean; delivered?: boolean };
				if (!res.ok) throw new Error(json.error ?? "respond failed");
				if (!json.federated) {
					if (json.delivered === false) {
						evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
					} else {
						durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), { delivered: true });
					}
				}
				return { delivered: true };
			}

			case "poll": {
				if (op.focus) {
					const declared = op.focus.terminalTeam;
					const local = declared === undefined ? null : targets.tryLocalName(declared);
					intentTracker?.declare(
						conversationId,
						local === null ? op.focus : { ...op.focus, terminalTeam: local },
					);
				}

				const box = mailboxStore.ensure(ownerId);
				let snap = box.drain(op.cursor ?? 0, op.epoch, conversationId);
				const hold = Math.min(op.holdMs ?? 0, HOLD_CAP_MS);

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

				const cursor = op.cursor ?? 0;
				const nothingNew = (s: typeof snap) => s.entries.every((e) => e.seq <= cursor);
				if (nothingNew(snap) && hold > 0) {
					const waits: Promise<unknown>[] = [box.waitForAppend(hold)];
					for (const p of participants) if (p.wait) waits.push(p.wait(hold));
					await Promise.race(waits);
					snap = box.drain(cursor, op.epoch, conversationId);
				}
				if (snap.entries.length > 0 || snap.dropped > 0) {
					console.log(
						`[console poll] conv=${conversationId.slice(0, 12)} reqCursor=${op.cursor ?? 0} reqEpoch=${op.epoch ?? "none"} -> drained=${snap.entries.length} retCursor=${snap.cursor} retEpoch=${snap.epoch} dropped=${snap.dropped}`,
					);
				}
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
				const attachments = requireBoardAttachments();
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
					if (!supplied || supplied.includes(a.blobId)) {
						throw new Error(`attachment ${a.blobId} has not finished uploading`);
					}
					dropped.push(a.filename);
				}
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
				if (op.sinceHash && op.sinceHash === peek.hash) return { hash: peek.hash, unchanged: true };
				if (peek.kind === "container-logs")
					return { text: peek.text, hash: peek.hash, kind: "container-logs" as const };
				return { ansi: peek.ansi, hash: peek.hash, kind: "tmux" as const };
			}

			case "tmux_send": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				if ((op.text == null) === (op.key == null)) {
					throw new Error("tmux_send requires exactly one of text or key");
				}
				const target = targets.tmuxTarget(op.target);
				assertDaemonDrivable(target);
				const dedupKey = `${conversationId}:${opId}`;
				let hostOp: HostOp;
				if (op.key != null) {
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
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				if (!isSpawnWorkdirPath(op.spawn, op.path)) {
					throw new Error("invalid path: must be absolute, ~-rooted, or a Windows drive path");
				}
				const r = await relayToHost({ kind: "listDirs", path: op.path, spawn: op.spawn });
				if (!r.ok) throw new Error(r.error ?? "list failed");
				const listed = r.result as HostListDirsResult;
				return { entries: listed.entries, ...(listed.truncated ? { truncated: true } : {}) };
			}

			case "blob_stat":
			case "blob_put":
			case "blob_get":
				// Fetch Router cache before the source machine.
				return answerBlobOp(blobStore, op, fetchBlobFromGateway, boardAttachments);

			case "create_session": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				if (!op.sessionName && !op.displayLabel) {
					throw new Error("create_session needs a sessionName or a displayLabel");
				}
				const spawn = targets.localSpawn(op.target);
				if (op.workdir != null && !isSpawnWorkdirPath(spawn, op.workdir)) {
					throw new Error("invalid workdir: must be an absolute, ~-rooted, or Windows drive path");
				}
				const labelSanitized = op.displayLabel != null && sanitizeLabel(op.displayLabel) === null;
				const dedupKey = `${conversationId}:${opId}`;
				let sessionId: string;
				let label: string;
				let adopted: { record: SessionRecord; created: boolean } | null | undefined;
				let rollbackEligible = false;
				if (op.sessionName) {
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
				if (sessionStore && !adopted) {
					throw new Error(`cannot create session "${sessionId}": the name is reserved or a project`);
				}
				const mayForget = () => {
					if (!rollbackEligible || adopted == null) return false;
					const current = sessionStore?.getByTeam(sessionStore.teamOf(adopted.record));
					return current === adopted.record && current.confirmedAt === undefined;
				};
				try {
					const target = targets.tmuxTarget(op.target, sessionId);
					const workdirHint =
						sessionStore && adopted ? sessionStore.hostWorkdirHint(adopted.record) : (op.workdir ?? label);

					const launchTeam = composeSessionName(target.name, target.sessionName);
					const viaWake = target.kind === "devcontainer" && tryWakeTeam;
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
									resumeSessionId: adopted?.record.claudeSessionId,
									sessionToken: adopted ? sessionStore?.ensureBindToken(adopted.record) : undefined,
									dedupKey,
								})
					).finally(() => {
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
				const { name } = targets.requireLocalComposite(op.target, "forget");
				if (isWakeInFlight?.(name))
					throw new Error(`"${name}" is waking; wait for it to finish before forgetting`);
				const dedupKey = `${conversationId}:${opId}`;
				try {
					const target = targets.tmuxTarget(op.target);
					const r = await relayToHost({ kind: "killSession", target, dedupKey });
					if (!r.ok) console.log(`[console] forget "${name}": kill failed - ${r.error ?? "unknown error"}`);
				} catch (e) {
					console.log(`[console] forget "${name}": kill failed - ${(e as Error).message}`);
				}
				const disposition: BoardDisposition = op.boardDisposition ?? "release";
				dropSessionResume?.(name, disposition);
				return { killed: true, boardDisposition: disposition };
			}

			case "close_session": {
				if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
				const { name } = targets.requireLocalComposite(op.target, "close");
				const target = targets.tmuxTarget(op.target);
				const record = sessionStore?.getByTeam(name);
				if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
					throw new Error(`"${name}" is user-launched; end it from your terminal`);
				}
				if (isWakeInFlight?.(name)) {
					throw new Error(`"${name}" is waking; wait for it to finish before closing`);
				}
				const dedupKey = `${conversationId}:${opId}`;
				const r = await relayToHost({ kind: "killSession", target, dedupKey });
				if (!r.ok) throw new Error(r.error ?? "close failed");
				return { closed: true };
			}

			case "rename_session": {
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
				return crossDomain.confirm({
					pin: op.pin,
					mySignedLink: op.mySignedLink,
				});
			}

			case "cross_domain_listen_state": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				return crossDomain.listenState(op.listeningToken);
			}

			case "cross_domain_cancel": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				return { cancelled: crossDomain.cancel({ listeningToken: op.listeningToken, pin: op.pin }) };
			}

			case "cross_domain_share": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				const canonicalTarget = await assertShareable(op.sessionTarget, op.target);
				crossDomainShare.share(canonicalTarget, op.target);
				return { ok: true };
			}

			case "cross_domain_unshare": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				const canonicalTarget = canonicalShareTarget(op.sessionTarget);
				const removed = crossDomainShare.unshare(canonicalTarget, op.target);
				if (removed) crossDomainShare.expireSessionJobsForTarget(canonicalTarget, op.target);
				return { ok: true };
			}

			case "cross_domain_list_shares": {
				if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
				return { shares: crossDomainShare.listShares() };
			}

			case "cross_domain_list_peers": {
				if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				return crossDomain.listPeers();
			}

			case "cross_domain_unlink": {
				if (!unlinkDomain) throw new Error("cross-Domain linking is not available on this Gateway");
				return unlinkDomain(op.domainId);
			}

			case "cross_domain_untrust": {
				if (!untrustOwner) throw new Error("cross-Domain linking is not available on this Gateway");
				return untrustOwner(op.ownerSignPub);
			}
		}
	}

	function canonicalShareTarget(sessionTarget: string): string {
		return targets.shareTarget(
			sessionTarget,
			() => new Error(`cannot unshare "${sessionTarget}": only local sessions have shares`),
		).canonical;
	}

	async function assertShareable(sessionTarget: string, target: CrossDomainShareTarget): Promise<string> {
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
			const ownerId = ownerKeyId(frame.ownerSignPub);
			devices.ensurePeer(
				frame.device,
				frame.conversationId,
				frame.signerSignPub,
				ownerId,
				frame.op.kind === "register",
			);
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
			console.error(`[console] ${frame.op.kind} op failed for ${frame.device}: ${message}`);
			return { ok: false, error: message };
		}
	}

	function durableOpKey(kind: string, opId: string): string {
		return `${kind}:${opId}`;
	}

	function evictOpCacheIfStillOwned(conv: string, opId: string, kind: string, generation: number): void {
		if (!durableOpStore || durableOpStore.clear(conv, durableOpKey(kind, opId), generation)) {
			devices.opCacheDelete(conv, opId);
		}
	}

	function cacheInMemory(conv: string, opId: string, promise: Promise<ConsoleReplyBody>): void {
		devices.opCacheSet(conv, opId, promise);
	}

	function handleFrame(frame: OpenedConsoleFrame): Promise<ConsoleReplyBody> {
		if (!isMutatingOp(frame.op)) return runFrame(frame);

		const conv = frame.conversationId;
		const cached = devices.opCacheGet(conv, frame.opId);
		if (cached) return cached;

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
			const marked = durableOpStore.markInFlight(conv, key);
			if (marked === null) throw new Error(MIGRATING);
			generation = marked;
		}

		const promise = runFrame(frame, generation);
		cacheInMemory(conv, frame.opId, promise);
		void promise
			.then((reply) => {
				if (reply.ok) {
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
