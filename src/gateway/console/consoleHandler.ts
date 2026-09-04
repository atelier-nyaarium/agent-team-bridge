import crypto from "node:crypto";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type { ConsoleOp, ConsoleOpResult, CrossDomainShareTarget } from "../../shared/console-protocol.js";
import {
	ALLOWED_KEYS,
	type HostListDirsResult,
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	isSpawnWorkdirPath,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { fenced, MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import { DELIVERY_OP_KINDS, TOLERATED_DELIVERY_OP_KINDS, VALUE_OP_KINDS } from "../../shared/schemasConsoleOp.js";
import { composeSessionName, SpawnPoint, storeKey } from "../../shared/session-id.js";
import { sanitizeLabel } from "../../shared/session-sanitize.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { TeamInfo } from "../../shared/types.js";
import { answerBlobOp } from "../blobOps.js";
import { readAnchorsPlaneName } from "../readAnchors.js";
import { createConsoleTargets } from "./consoleTargets.js";
import {
	type ConsoleHandlerDeps,
	CREATE_SESSION_BOUND_MS,
	CreateSessionAmbiguousError,
	FAKE_REQ,
	friendlyPeekError,
	SEND_BOUND_MS,
	type SendRouteJson,
} from "./consoleTypes.js";

export type { ConsoleHandlerDeps, ConsoleRoutes } from "./consoleTypes.js";
export { CREATE_SESSION_BOUND_MS } from "./consoleTypes.js";

export function createConsoleDispatcher({
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
	planeRegistry,
	readAnchors,
	blobStore,
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
	const ownerByConversation = new Map<string, string>();
	const appendIfLive = (
		conversationId: string,
		entry: import("../../shared/console-protocol.js").MailboxInput,
		dedupeKey?: string,
	): undefined | typeof MIGRATING => {
		if (fenced()) return MIGRATING;
		const ownerId = ownerByConversation.get(conversationId);
		if (!ownerId) return;
		const delivered = routes.deliverToOwner({
			entry: entry as import("../../shared/federation-protocol.js").ConsolePushEntry,
			dedupeKey: dedupeKey ?? crypto.randomUUID(),
			label: "console-device",
		});
		return delivered ? undefined : fenced() ? MIGRATING : undefined;
	};
	function assertDaemonDrivable(target: TmuxTarget): void {
		const record = sessionStore?.getByTeam(composeSessionName(target.name, target.sessionName));
		if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
			throw new Error(`terminal view unavailable for a user-launched session; end it from your terminal`);
		}
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
								const appended = appendIfLive(
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
								if (appended === MIGRATING) {
									evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
									return;
								}
								durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), {
									session_id: expectedSession,
									status: "sent",
								});
								return;
							}
							const json = (await res.json().catch(() => ({}))) as SendRouteJson;
							appendIfLive(conversationId, {
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
				const appended = appendIfLive(
					conversationId,
					{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
					`sent:${conversationId}:${opId}`,
				);
				if (appended === MIGRATING) throw new Error(MIGRATING);
				durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), sendResult);
				return sendResult;
			}

			case "respond": {
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

			case "report_read": {
				if (!readAnchors) throw new Error("read-anchor sync is not available on this Gateway");
				const advanced = readAnchors.report(ownerId, op.team, { epoch: op.epoch, seq: op.seq, at: Date.now() });
				if (advanced) planeRegistry?.markDirty(readAnchorsPlaneName(ownerId));
				return { advanced };
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
				// Blank names the spawn point's own default directory, which the machine spells back.
				if (op.path.length > 0 && !isSpawnWorkdirPath(op.spawn, op.path)) {
					throw new Error("invalid path: must be absolute, ~-rooted, or a Windows drive path");
				}
				const r = await relayToHost({ kind: "listDirs", path: op.path, spawn: op.spawn });
				if (!r.ok) throw new Error(r.error ?? "list failed");
				const listed = r.result as HostListDirsResult;
				return {
					entries: listed.entries,
					...(listed.truncated ? { truncated: true } : {}),
					...(listed.path ? { path: listed.path } : {}),
				};
			}

			case "blob_stat":
			case "blob_put":
			case "blob_get":
				// Fetch Router cache before the source machine.
				return answerBlobOp(blobStore, op, fetchBlobFromGateway);

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
			case "wake": {
				if (!tryWakeTeam) throw new Error("wake is unavailable");
				const { name, spawn, session } = targets.requireLocalComposite(op.target, "wake");
				// The owner's button re-creates a record the gateway lost, under the session's own id, as
				// create_session does with a typed sessionName. A send never adopts a typed name; the
				// console may. A launch that never comes up forgets the record again.
				const adopted =
					sessionStore && !sessionStore.getByTeam(name)
						? sessionStore.adoptById(session, { spawn, sessionLabel: session, workdirHint: session })
						: null;
				const mayForget = () => {
					if (!adopted || !sessionStore) return false;
					const current = sessionStore.getByTeam(name);
					return current === adopted && current.confirmedAt === undefined;
				};
				// Bounded like create_session: a slow launch answers pending and finishes on its own.
				let boundTimer: ReturnType<typeof setTimeout> | undefined;
				const bound = new Promise<null>((resolve) => {
					boundTimer = setTimeout(() => resolve(null), createSessionBoundMs);
				});
				const wake = tryWakeTeam(name);
				const winner = await Promise.race([wake, bound]);
				clearTimeout(boundTimer);
				if (winner === null) {
					void wake
						.then((r) => {
							if (!r.ok && mayForget()) sessionStore?.forget(name);
						})
						.catch(() => {
							if (mayForget()) sessionStore?.forget(name);
						});
					return { ok: true, status: "pending" as const };
				}
				if (!winner.ok) {
					if (mayForget()) sessionStore?.forget(name);
					const reason =
						winner.error ??
						(winner.errorKind === "disconnected"
							? "the host is not connected"
							: winner.errorKind === "timeout"
								? "it did not come online in time"
								: "unknown error");
					throw new Error(`failed to wake "${name}": ${reason}`);
				}
				return winner;
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

	function durableOpKey(kind: string, opId: string): string {
		return `${kind}:${opId}`;
	}

	function evictOpCacheIfStillOwned(conv: string, opId: string, kind: string, generation: number): void {
		durableOpStore?.clear(conv, durableOpKey(kind, opId), generation);
	}

	async function handleValue(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		opId: string,
		ownerSignPub: string,
	): Promise<ConsoleOpResult> {
		if (!VALUE_OP_KINDS.has(op.kind)) throw new Error("value op kind is not allowed");
		ownerByConversation.set(conversationId, ownerKeyId(ownerSignPub));
		return dispatch(op, device, conversationId, ownerKeyId(ownerSignPub), opId, ownerSignPub);
	}

	async function handleDelivery(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		opId: string,
		ownerSignPub: string,
	): Promise<ConsoleOpResult> {
		if (!DELIVERY_OP_KINDS.has(op.kind) && !TOLERATED_DELIVERY_OP_KINDS.has(op.kind))
			throw new Error("delivery op kind is not allowed");
		ownerByConversation.set(conversationId, ownerKeyId(ownerSignPub));
		return dispatch(op, device, conversationId, ownerKeyId(ownerSignPub), opId, ownerSignPub);
	}

	return { handleValue, handleDelivery };
}
