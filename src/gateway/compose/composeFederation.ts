// Stage 8: everything the FederationActive phase owns, built from one bootstrap.

import { DomainSnapshotSchema } from "../../shared/admission.js";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import { DurableStore, restoreDurable } from "../../shared/durable-store.js";
import { stableHash } from "../../shared/plane-registry.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import { WIRE_NONCE_BYTES } from "../../shared/wire-vocabulary.js";
import { readBlobRange } from "../blobOps.js";
import type { FederationSlice, GatewayBootstrap } from "../boot.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import {
	CrossDomainHandshakeCoordinator,
	parseCommitReply,
	parseRevealReply,
} from "../federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../federation/crossDomainPeers.js";
import { CrossDomainShareState } from "../federation/crossDomainShareState.js";
import { logAdmitGatewayQr } from "../federation/enrollQr.js";
import type { createGatewayRelayHandler } from "../federation/gatewayRelay.js";
import { ReplayGuard } from "../federation/replayGuard.js";
import { createSealer } from "../federation/sealer.js";
import { createBlobUploader } from "../router/blobUploader.js";
import { createBoardClient } from "../router/boardClient.js";
import { createInboxDeliveryPump } from "../router/inboxDeliveryPump.js";
import { createKeyRequester } from "../router/keyRequester.js";
import { createPresenceReporter } from "../router/presenceReporter.js";
import { buildRegisterAuth } from "../router/registerAuth.js";
import { startRouterClient } from "../router/routerClient.js";
import { createShareAttestor } from "../router/shareAttestor.js";
import { routerWsConnection, saveRouterReach } from "../router/transport.js";
import { resolveLiveIncarnation } from "../websocket.js";
import type { AwarenessStage } from "./composeAwareness.js";
import type { HostStage } from "./composeHost.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ConsoleDeliveryHandler = (
	op: import("../../shared/console-protocol.js").ConsoleOp,
	device: string,
	conversationId: string,
	opId: string,
	ownerSignPub: string,
) => Promise<unknown>;

type PeerHandleOp = ReturnType<typeof createGatewayRelayHandler>["handleOp"];

export interface FederationStageDeps {
	dataDir: string;
	federationDir: string;
	localGatewayId: string;
	/** Null dials the transport's Router. */
	routerBootstrapUrl: string | null;
	ambient: Ambient;
	context: FederationContext;
	stores: StoresStage;
	sessions: SessionsStage;
	host: Pick<HostStage, "wakeService">;
	awareness: Pick<AwarenessStage, "boardObserve">;
	/** Later stages, read on demand. */
	routes: () => GatewayRoutes;
	channelDeliveries: () => ChannelDeliveryCoordinator;
	consoleDispatch: () => ConsoleDeliveryHandler | null;
	peerHandleOp: () => PeerHandleOp | null;
	unlinkDomain: () => ((domainId: string) => unknown) | null;
}

export interface FederationStage {
	buildSlice: (boot: GatewayBootstrap) => FederationSlice;
	startShareSweep: (slice: FederationSlice) => void;
	/** Re-attests the live cross-Domain job set. */
	attest: () => void;
	markPresenceDirty: () => void;
	channelDeliveryAck: (team: string, deliveryId: string) => void;
	stop: () => void;
}

export function composeFederation(deps: FederationStageDeps): FederationStage {
	const { context, stores, sessions, localGatewayId, federationDir, dataDir, ambient } = deps;
	const now = () => ambient.now();
	let presenceReporter: ReturnType<typeof createPresenceReporter> | null = null;
	let shareAttestor: ReturnType<typeof createShareAttestor> | null = null;
	let keyRequester: ReturnType<typeof createKeyRequester> | null = null;
	let inboxPump: ReturnType<typeof createInboxDeliveryPump> | null = null;
	let shareSweepTimer: IntervalHandle | null = null;

	function buildSlice(gatewayBootstrap: GatewayBootstrap): FederationSlice {
		let slice: FederationSlice;
		const { domainId } = gatewayBootstrap;
		const allowlist = gatewayBootstrap.allowlist;
		const crossDomainPeers = new CrossDomainPeers(federationDir, () => {
			sessions.planeRegistry.markDirty("linked-peers");
			slice.handlers?.presence.presenceSource.recomputeAll();
		});
		sessions.planeRegistry.registerPlane(
			{
				name: "linked-peers",
				snapshot: () =>
					crossDomainPeers
						.all()
						.map((p) => ({
							domainId: p.friendDomainId,
							gatewayId: p.friendGatewayId,
							ownerSignPub: p.friendOwnerSignPub,
						}))
						.sort((a, b) => `${a.domainId}.${a.gatewayId}`.localeCompare(`${b.domainId}.${b.gatewayId}`)),
				identityOf: (snapshot) => stableHash(snapshot),
			},
			stores.restored.planes?.["linked-peers"],
		);
		const shareState = new CrossDomainShareState(
			federationDir,
			(reason) => {
				if (reason.kind === "domain") slice.handlers?.presence.presenceSource.recomputeDomain(reason.domainId);
				else slice.handlers?.presence.presenceSource.recomputeAll();
				shareAttestor?.attest();
			},
			ambient,
		);
		const federationIdentity = gatewayBootstrap.identity;
		const replayDurable = new DurableStore(dataDir, "replay-guard");
		const replayGuard = new ReplayGuard(ambient);
		restoreDurable("replay-guard", () => {
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		});
		const sealer = createSealer(
			federationIdentity,
			allowlist,
			localGatewayId,
			crossDomainPeers,
			domainId,
			replayGuard,
			ambient,
		);
		const routeHandshake = async (
			action: string,
			receiverGatewayId: string,
			payload: unknown,
		): Promise<unknown> => {
			const res = await slice.routerClient.callTool(action, {
				handshakeId: ambient.randomBytes(WIRE_NONCE_BYTES).toString("base64url"),
				srcDomain: domainId,
				srcGateway: localGatewayId,
				dstGateway: receiverGatewayId,
				payload,
			});
			if (res.error) throw new Error(res.error);
			const r = res.result as { ok?: boolean; error?: string; result?: unknown } | undefined;
			if (!r?.ok) throw new Error(r?.error ?? "the friend's Gateway did not complete the handshake");
			return r.result;
		};
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: {
				ownerSignPub: () => allowlist.ownerSignPub,
				gatewaySignPub: federationIdentity.sign.pub,
				gatewayBoxPub: federationIdentity.box.pub,
				domainId,
				gatewayId: localGatewayId,
			},
			peers: crossDomainPeers,
			ambient,
			route: {
				sendCommit: async (receiverGatewayId, req) => {
					const r = await routeHandshake("cross_domain_handshake", receiverGatewayId, req);
					return parseCommitReply(r);
				},
				sendReveal: async (receiverGatewayId, req) => {
					const r = await routeHandshake("cross_domain_handshake_reveal", receiverGatewayId, req);
					return parseRevealReply(r);
				},
			},
		});
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		if (!allowlist.selfAdmission(federationIdentity.sign.pub))
			logAdmitGatewayQr(federationIdentity, localGatewayId);

		const connection = routerWsConnection(gatewayBootstrap.transport);
		const bootstrap = deps.routerBootstrapUrl ?? connection.url;
		console.log(`[router] direct transport -> ${bootstrap}`);

		const routerClient = startRouterClient({
			ambient,
			url: bootstrap,
			headers: connection.headers,
			tls: connection.tls,
			gatewayId: localGatewayId,
			domainId,
			reach: gatewayBootstrap.reach,
			onReach: (learned) => saveRouterReach(federationDir, learned),
			onGatewayRelay: (frame) => {
				slice.handlers?.frames.gatewayRelay(frame);
			},
			onValueOp: (frame) => {
				slice.handlers?.frames.valueOp(frame);
			},
			onCrossDomainHandshake: (frame) => {
				slice.handlers?.frames.crossDomainHandshake(frame);
			},
			onDomainSync: (domain) => {
				const parsed = DomainSnapshotSchema.safeParse(domain);
				if (!parsed.success) {
					console.warn(`[federation] dropped malformed domain sync: ${parsed.error.issues[0]?.message}`);
					return;
				}
				if (allowlist.applySnapshot(parsed.data)) {
					console.log(`[federation] domain sync applied (${parsed.data.admissions.length} admissions)`);
				}
			},
			onDomainMeta: (meta) => {
				slice.domainMeta = meta;
				sessions.presence.markDirty();
			},
			onDomainUpdate: (meta) => {
				slice.domainMeta = { ...(slice.domainMeta ?? {}), displayName: meta.displayName };
				sessions.presence.markDirty();
			},
			buildRegisterAuth: () =>
				buildRegisterAuth({
					gatewayId: localGatewayId,
					identity: federationIdentity,
					selfAdmission: () => allowlist.selfAdmission(federationIdentity.sign.pub),
					ambient,
				}),
			onDisconnect: () => {
				console.error(`[router] disconnected from the Router`);
			},
			onRegistered: () => {
				sessions.sessionReporter.reconcile();
				presenceReporter?.baseline();
				shareAttestor?.attest();
				void inboxPump?.resendReceipts();
				// Older rows are sealed under the epochs below the oldest held one.
				const oldestHeld = Math.min(...context.contentKeys().epochs());
				const wanted = Number.isFinite(oldestHeld) ? oldestHeld - 1 : 1;
				for (let epoch = 1; epoch <= wanted; epoch += 1) {
					if (context.contentKeys().keyFor(epoch) === null) keyRequester?.request(epoch);
				}
			},
			onPresenceResync: () => presenceReporter?.resync(),
			onUnlink: (frame) => {
				const unlinked = (frame as { domainId?: unknown }).domainId;
				if (typeof unlinked === "string") deps.unlinkDomain()?.(unlinked);
			},
			onInboxDeliver: (frame) =>
				void inboxPump?.onFrame(
					frame as { address: string; rows: unknown; incarnation?: number; deliveryEpoch: number },
				),
			onBlobFetch: (frame) => {
				const request = frame as { opId: string; blobId: string; range?: { offset: number; length: number } };
				try {
					const read = readBlobRange(
						stores.blobStore,
						request.blobId,
						request.range?.offset ?? 0,
						request.range?.length ?? MAX_BLOB_BYTES,
					);
					void routerClient.callInboxTool("blob_fetch_reply", {
						opId: request.opId,
						outcome: "fetched",
						bytes: read.bytes.toString("base64"),
						eof: read.eof,
						sealed: false,
					});
				} catch {
					void routerClient.callInboxTool("blob_fetch_reply", {
						opId: request.opId,
						outcome: "absent",
						sealed: false,
					});
				}
			},
		});
		presenceReporter = createPresenceReporter({
			rows: () => sessions.presence.snapshot(),
			spawnPoints: () => ({
				gatewayId: localGatewayId,
				domainId,
				hostSpawns: sessions.hostSpawnPoints.known ? sessions.hostSpawnPoints.ids : [],
			}),
			send: (action, params) => routerClient.callInboxTool(action, params),
			incarnation: () => routerClient.incarnation(),
			ambient,
		});
		shareAttestor = createShareAttestor({
			ambient,
			shares: () => [...new Set(shareState.all().map((share) => share.sessionTarget))],
			liveJobIds: (sessionTarget) =>
				stores.jobs.liveCrossDomainJobIds(
					sessionTarget,
					(gatewayId) => crossDomainPeers.all().some((peer) => peer.friendGatewayId === gatewayId),
					SHARE_TTL_MS,
					now(),
				),
			send: (action, params) => routerClient.callInboxTool(action, params),
			incarnation: () => routerClient.incarnation(),
		});
		shareAttestor.start();
		const blobUploader = createBlobUploader({
			call: (action, params) => routerClient.callInboxTool(action, params),
			blobs: stores.blobStore,
			incarnation: () => routerClient.incarnation(),
			domainId,
			ownerSignPub: () => allowlist.ownerSignPub,
			ambient,
			keys: gatewayBootstrap.contentKeys,
		});
		const boardClient = createBoardClient({
			call: (action, params) => routerClient.callInboxTool(action, params),
			domainId,
			gatewayId: localGatewayId,
			ownerSignPub: () => allowlist.ownerSignPub,
			keys: gatewayBootstrap.contentKeys,
		});
		keyRequester = createKeyRequester({
			domainId,
			gatewayId: localGatewayId,
			gatewaySignPub: federationIdentity.sign.pub,
			gatewaySignPriv: federationIdentity.sign.priv,
			ambient,
			send: (action, params) => routerClient.callInboxTool(action, params),
			onError: (message) => {
				deps.routes().deliverToOwner({
					entry: {
						kind: "notice",
						session_id: `gateway.${localGatewayId}.key-request`,
						title: "Content key unavailable",
						summary: message,
						body: message,
					},
					dedupeKey: `key-request:${domainId}:${localGatewayId}`,
					label: "key-request",
				});
			},
		});
		inboxPump = createInboxDeliveryPump({
			claims: stores.inboxClaims,
			routerClient,
			boardObservation: (sessionKey, row) =>
				deps.awareness.boardObserve([
					{
						sessionKey,
						identity: row.identity,
						pre: row.pre ? boardClient.openEntry(row.pre) : undefined,
						post: row.post ? boardClient.openEntry(row.post) : undefined,
					},
				]),
			incarnation: () => routerClient.incarnation(),
			domainId,
			gatewayId: localGatewayId,
			gatewaySignPub: federationIdentity.sign.pub,
			ownerSignPub: () => allowlist.ownerSignPub,
			contentKeyStore: gatewayBootstrap.contentKeys,
			consoleDispatch: (op, device, conversationId, opId, ownerSignPub) => {
				const handler = deps.consoleDispatch();
				return handler
					? handler(op, device, conversationId, opId, ownerSignPub)
					: Promise.reject(new Error("console handler unavailable"));
			},
			producerSignPriv: federationIdentity.sign.priv,
			allowlistSnapshot: () => allowlist.getSnapshot(),
			keyRequester,
			sealer,
			coordinator: deps.channelDeliveries(),
			tryWakeTeam: (team) => deps.host.wakeService.tryWakeTeam(team),
			isSessionLive: (sessionId) => !!resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessionId),
			peerHandler: (op, srcGateway, srcDomainId) => {
				const handler = deps.peerHandleOp();
				if (!handler) throw new Error("peer handler not ready");
				return handler(op, srcGateway, srcDomainId);
			},
		});

		slice = {
			allowlist,
			crossDomainPeers,
			shareState,
			coordinator,
			sealer,
			routerClient,
			contentKeyStore: gatewayBootstrap.contentKeys,
			boardClient,
			blobUploader,
			replayPersist: () => replayDurable.save(replayGuard.snapshot()),
			domainMeta: null,
			handlers: null,
		};
		return slice;
	}

	function startShareSweep(slice: FederationSlice): void {
		const isLive = (sessionTarget: string): boolean =>
			stores.jobs.hasLiveCrossDomainThread(
				sessionTarget,
				(gatewayId) => slice.crossDomainPeers.all().some((p) => p.friendGatewayId === gatewayId),
				SHARE_TTL_MS,
				now(),
			);
		shareSweepTimer = ambient.setInterval(() => {
			const dropped = slice.shareState.sweep(now(), SHARE_TTL_MS, isLive);
			if (dropped > 0) console.log(`[federation] auto-forgot ${dropped} stale cross-Domain share(s)`);
		}, 3_600_000);
	}

	return {
		buildSlice,
		startShareSweep,
		attest: () => shareAttestor?.attest(),
		markPresenceDirty: () => presenceReporter?.markDirty(),
		channelDeliveryAck: (team, deliveryId) => void inboxPump?.onChannelDeliveryAck(team, deliveryId),
		stop: () => {
			if (shareSweepTimer) ambient.clearInterval(shareSweepTimer);
			shareAttestor?.stop();
			presenceReporter?.stop();
			keyRequester?.stop();
		},
	};
}
