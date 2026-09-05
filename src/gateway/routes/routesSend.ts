import type { Ambient } from "../../shared/ambient.js";
import type { FederatedOp } from "../../shared/federation-protocol.js";
import type { PendingJobStore } from "../../shared/pending-job-store.js";
import {
	Address,
	composeSessionName,
	LOCAL_DOMAIN_SENTINEL,
	parseSessionName,
	parseTarget,
	SpawnPoint,
	storeKey,
} from "../../shared/session-id.js";
import type { ChannelFile, GatewayConfig, ResponsePayload, RidingAwareness } from "../../shared/types.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import {
	fileBytes,
	getTeamMode,
	jsonResponse,
	MAX_RESPONSE_FILE_BYTES,
	POST_WAKE_SETTLE_MS,
	SendRequestSchema,
	stampBlobHolder,
} from "../routeSchemas.js";
import { presentedByRequest, type SessionAuthority } from "../sessionAuthority.js";
import type { WakeResult } from "../wake.js";
import {
	type ConversationRegistry,
	getAllActiveWs,
	type HandshakeRepushOutcome,
	resolveLiveIncarnation,
	type TeamRegistry,
} from "../websocket.js";
import type { CallerScope } from "./callerGuards.js";

type ConsolePushOps = ReturnType<typeof import("../consolePushOps.js").createConsolePushOps>;

export interface SendRoutesDeps {
	config: GatewayConfig;
	localDomain: string;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer">;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: Pick<PendingJobStore<ResponsePayload>, "create">;
	tryWakeTeam: (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => Promise<WakeResult>;
	// Session records support live-incarnation resolution. Optional in test harnesses.
	sessionStore?: import("../../shared/session-store.js").SessionStore;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "isConnected"> | null;
	// Re-sends a (team, subId)'s still-pending handshake so a caller that lost the original.
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	// The sole resolver of "what must a caller prove to act as X". Absent in test harnesses that do.
	auth?: SessionAuthority;
	awareness?: { takeFor(sessionKey: string): RidingAwareness | null };
	// Holds a channel message for a session that could not take it, and hands it over when the.
	deliveries?: ChannelDeliveryCoordinator;
	localAddress: (name: string) => Address;
	consoleSelfAddress: (ownerId: string) => Address;
	tryLocalAddress: (name: string) => Address | null;
	resolveLocalTarget: (to: string) => { name: string; address: Address } | null;
	targetDomainId: (targetGateway: string, targetDomain?: string) => string | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
		producerOpId?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	mirrorPeer: ConsolePushOps["mirrorPeer"];
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
	provedLocalSession: (req: Request) => boolean;
}

export function createSendRoutes({
	config,
	localDomain,
	ambient,
	registry,
	conversationRegistry,
	store,
	tryWakeTeam,
	sessionStore,
	routerClient,
	repushHandshake,
	auth,
	awareness,
	deliveries,
	localAddress,
	consoleSelfAddress,
	tryLocalAddress,
	resolveLocalTarget,
	targetDomainId,
	relayToGateway,
	mirrorPeer,
	refuseImpersonation,
	provedLocalSession,
}: SendRoutesDeps) {
	const { localGatewayId } = config;

	/** Origin side of a cross-Gateway channel send. Keeps a local pollable anchor keyed
	 * by the canonical session id (so the sender can poll and the eventual
	 * response_push delivers back to its conversation), forwards the send to the
	 * destination Gateway with a return-route, and hands the session id back. */
	async function sendCrossGateway(args: {
		targetGateway: string;
		targetName: string;
		targetDomain?: string;
		from: string;
		// Pre-built canonical sender address. The console sets it (owner-id based) because its `from`.
		fromAddress?: string;
		fromConversationId: string | undefined;
		body?: string;
		files?: ChannelFile[];
		// Threaded through to the destination Gateway's own local send() so a not-yet-existing target.
		displayLabel?: string;
		disposition?: "asking" | "informing" | "closing";
		/** The caller's id, so its retries stay one operation. */
		opId?: string;
	}): Promise<Response> {
		const {
			targetGateway,
			targetName,
			targetDomain,
			from,
			fromAddress,
			fromConversationId,
			body,
			files,
			displayLabel,
			disposition,
			opId,
		} = args;
		if (!routerClient?.isConnected()) {
			return jsonResponse({ error: `Router unavailable; cannot reach Gateway "${targetGateway}"` }, 503);
		}
		if (!fromConversationId) {
			return jsonResponse({ error: `fromConversationId is required for a cross-Gateway send` }, 400);
		}
		// Resolve the destination Domain ONCE so the address's domain segment and the anchor's.
		const resolvedDomain = targetDomainId(targetGateway, targetDomain);
		const { project: tSpawn, session: tSession } = parseSessionName(targetName);
		const targetAddr = Address.remote(resolvedDomain ?? localDomain, targetGateway, tSpawn, tSession);
		const qualifiedTo = targetAddr.canonical;
		const srcSession = storeKey({ kind: "conv", conversationId: fromConversationId, address: targetAddr });
		const senderAddr = fromAddress ? null : localAddress(from);
		const senderCanonical = fromAddress ?? senderAddr!.canonical;
		const op: FederatedOp = {
			kind: "send",
			from: senderCanonical,
			to: targetName,
			body: body ?? "",
			...(files && files.length > 0 ? { files } : {}),
			...(displayLabel ? { displayLabel } : {}),
			...(disposition ? { disposition } : {}),
			returnRoute: { srcGateway: localGatewayId, srcConversationId: fromConversationId, srcSession },
		};
		const relay = await relayToGateway(targetGateway, op, targetDomain, opId);
		if (!relay.ok)
			return jsonResponse({ error: relay.error ?? `cross-Gateway send to "${qualifiedTo}" failed` }, 502);
		// Keep a local pollable anchor ONLY once the destination accepted the send, so.
		store.create(srcSession, from, qualifiedTo, {
			persistent: true,
			fromConversationId,
			dstDomainId: resolvedDomain ?? undefined,
		});
		// Mirror the LOCAL sender's own outbound leg; the remote target's own gateway mirrors its.
		if (senderAddr) {
			mirrorPeer(senderAddr, senderCanonical, targetAddr.canonical, { body, files });
		}
		return jsonResponse({
			session_id: srcSession,
			status: "running",
			message: `Message routed to ${qualifiedTo} via the Router. Responses will be pushed back automatically.`,
		});
	}

	async function send(
		req: Request,
		body: Record<string, unknown>,
		opts: { trustedInbound?: boolean; consoleSender?: boolean } = {},
	): Promise<Response> {
		const parsed = SendRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const {
			from,
			fromConversationId,
			to,
			targetDomainId: targetDomain,
			body: msgBody,
			files: rawSendFiles,
			channelOnly,
			displayLabel,
			disposition,
			opId: producerOpId,
		} = parsed.data;
		// Same rule as respond: only a local agent's own upload gets this Gateway's stamp.
		const files =
			rawSendFiles &&
			(opts.trustedInbound || opts.consoleSender ? rawSendFiles : stampBlobHolder(rawSendFiles, localGatewayId));
		// Only a real external caller is gated. A federated relay speaks for a remote sender, and the.
		if (!opts.trustedInbound && !opts.consoleSender) {
			const refused = refuseImpersonation(req, from, "session");
			if (refused) return refused;
			// fromConversationId decides where the eventual REPLY lands, so naming someone else's is.
			const holder = fromConversationId ? conversationRegistry.get(fromConversationId) : undefined;
			if (auth && !auth.satisfies(auth.toAnswerFor(holder), presentedByRequest(req))) {
				console.warn(`[auth] refused a send claiming another session's conversation`);
				return jsonResponse({ error: "conversation is not this caller's" }, 403);
			}
		}
		// The federated-inbound-only fields are honored ONLY when the call comes from the trusted.
		const trustedInbound = opts.trustedInbound === true;
		const inboundSessionId = trustedInbound ? parsed.data.sessionId : undefined;
		const returnRoute = trustedInbound ? parsed.data.returnRoute : undefined;
		const dstDomainId = trustedInbound ? parsed.data.dstDomainId : undefined;

		// Raw-bytes backstop at the trust boundary before the payload is pushed.
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}

		// Classify the target by arity. An INBOUND federated send (the gateway-relay handler) arrives.
		const parsedTarget = inboundSessionId ? null : parseTarget(to, localDomain, localGatewayId);
		if (parsedTarget instanceof SpawnPoint) {
			return jsonResponse(
				{ error: `"${to}" is a spawn-point, not a session; address a session as spawn.session` },
				400,
			);
		}
		// Cross-Gateway OUTBOUND: an Address whose (domain, gateway) is not ours routes through the.
		if (parsedTarget && (parsedTarget.domain !== localDomain || parsedTarget.gateway !== localGatewayId)) {
			const realDomain =
				parsedTarget.domain !== localDomain && parsedTarget.domain !== LOCAL_DOMAIN_SENTINEL
					? parsedTarget.domain
					: targetDomain;
			return await sendCrossGateway({
				targetGateway: parsedTarget.gateway,
				targetName: composeSessionName(parsedTarget.spawn, parsedTarget.session),
				targetDomain: realDomain,
				from,
				// A console send carries a non-slug Device Name as `from`; build its sender address from.
				fromAddress:
					opts.consoleSender && fromConversationId
						? consoleSelfAddress(fromConversationId).canonical
						: undefined,
				fromConversationId,
				body: msgBody,
				files,
				displayLabel,
				disposition,
				opId: producerOpId,
			});
		}

		// Resolve the target to a local registry name + its canonical Address. A local target.
		let target = resolveLocalTarget(to);
		if (!target) {
			return jsonResponse({ error: `Gateway for "${to}" is not reachable from this Gateway` }, 404);
		}
		let localName = target.name;
		let qualifiedTo = target.address.canonical;

		// The headless "host" daemon is never a direct crosstalk target (it carries no agent).
		if (localName === "host") {
			return jsonResponse(
				{
					error: `"${localName}" is a reserved name; crosstalk_send targets container teams only.`,
				},
				400,
			);
		}

		// Resolve the live incarnation serving this record: its canonical pane, else an alias.
		let targetWs = resolveLiveIncarnation(registry, sessionStore, localName);

		// If offline, attempt to wake the container - or, for a target with no record yet, create it.
		if (!targetWs) {
			// A retry sharing the same (sender conversation, resolved target) provenance reattaches to.
			const mintedFrom =
				inboundSessionId ?? (fromConversationId ? `${fromConversationId}:${localName}` : undefined);
			const woken = await tryWakeTeam(localName, { displayLabel, mintedFrom });
			if (!woken.ok) {
				// Say WHICH failure this was. All three used to fall through to the "is not connected".
				if (woken.error) return jsonResponse({ error: woken.error }, 404);
				if (woken.errorKind === "disconnected") {
					return jsonResponse(
						{
							error: `machine "${target.address.gateway}" is not reachable, so "${qualifiedTo}" was never woken`,
						},
						404,
					);
				}
				if (woken.errorKind === "timeout") {
					// Ambiguous by contract: the waiter gave up and the launch may still be coming. Calling.
					return jsonResponse({ error: `"${qualifiedTo}" is still starting; try again shortly` }, 404);
				}
			}
			if (woken.ok) {
				// Minting (no existing record, a displayLabel was set) lands on a fresh id, never the.
				if (woken.resolvedTeam && woken.resolvedTeam !== localName) {
					localName = woken.resolvedTeam;
					const resolved = tryLocalAddress(localName);
					if (resolved) {
						target = { name: localName, address: resolved };
						qualifiedTo = resolved.canonical;
					}
				}
				// Claude Code needs time after MCP connect to initialize its channel listener.
				await new Promise((r) => ambient.setTimer(() => r(undefined), POST_WAKE_SETTLE_MS));
				targetWs = resolveLiveIncarnation(registry, sessionStore, localName);
			}
		}

		// Deliver to the resolved incarnation's own team subs (localName for a canonical pane, the.
		const subs = targetWs ? registry.get(targetWs.data.teamName ?? localName) : undefined;
		// Nothing is listening. Without somewhere to hold the message this is the end of the road, so.
		if ((!targetWs || !subs) && !deliveries) {
			return jsonResponse(
				{
					error: `Team "${qualifiedTo}" is not connected`,
					available: [...registry.keys()]
						.filter((k) => k !== "host")
						.map((k) => tryLocalAddress(k)?.canonical)
						.filter((c): c is string => c != null),
				},
				404,
			);
		}

		// An absent session is taken as channel mode: every bridge connection registers as one (see.
		const targetMode = subs ? getTeamMode(subs) : "channel";

		// channelOnly senders (the console) must never reach the CLI branch below:.
		if (channelOnly && targetMode !== "channel") {
			return jsonResponse(
				{ error: `"${localName}" is a CLI-mode agent; console chat supports channel-mode (Claude) teams only` },
				409,
			);
		}

		// Channel mode: stable job id per (sender_conversation_id, target_team) pair.
		if (targetMode === "channel") {
			try {
				// A federated inbound send carries the origin's session id; a local send.
				const channelJobId =
					inboundSessionId ??
					(fromConversationId
						? storeKey({ kind: "conv", conversationId: fromConversationId, address: target.address })
						: null);
				if (!channelJobId) {
					return jsonResponse({ error: `fromConversationId is required for channel-mode targets` }, 400);
				}

				// Honor a Domain binding ONLY on an inbound federated send (the gateway-relay.
				const inboundDstDomainId = inboundSessionId ? dstDomainId : undefined;
				store.create(channelJobId, from, localName, {
					persistent: true,
					fromConversationId,
					returnRoute,
					dstDomainId: inboundDstDomainId,
				});

				// message_id is the file-materialization bucket key, read only when files are present.
				const hasFiles = files !== undefined && files.length > 0;
				const messageId = hasFiles ? ambient.newId() : undefined;
				// Taken once, HERE, and carried on the row. Reading it at delivery would drop it on a.
				const riding = awareness?.takeFor(localName) ?? undefined;

				if (deliveries) {
					const outcome = deliveries.accept({
						// Minted per send. The console's own op store already collapses its retries before.
						deliveryId: ambient.newId(),
						team: targetWs?.data.teamName ?? localName,
						channelJobId,
						from,
						body: msgBody || "",
						...(hasFiles ? { files, messageId } : {}),
						...(riding ? { awareness: riding } : {}),
						...(disposition ? { disposition } : {}),
						enqueuedAt: ambient.now(),
					});
					if (outcome === "refused") {
						return jsonResponse(
							{ error: `"${qualifiedTo}" has too many messages waiting; nothing was accepted` },
							503,
						);
					}
					console.log(`[send] channel_push ${outcome} for ${qualifiedTo} [${channelJobId}] from ${from}`);
				} else {
					const channelPayload: Record<string, unknown> = {
						type: "channel_push",
						from,
						body: msgBody || "",
						session_id: channelJobId,
					};
					if (hasFiles) {
						channelPayload.message_id = messageId;
						channelPayload.files = files;
					}
					const activeWs = subs ? getAllActiveWs(subs) : [];
					if (activeWs.length === 0) {
						throw new Error(`Team "${qualifiedTo}" has no active connections`);
					}
					if (riding) channelPayload.awareness = riding;
					if (disposition) channelPayload.disposition = disposition;
					const payload = JSON.stringify(channelPayload);

					for (const ws of activeWs) {
						// An unconfirmed recipient gets its still-pending handshake re-pushed AHEAD of the.
						if (!ws.data.handshakeConfirmed && ws.data.teamName) {
							repushHandshake?.(ws.data.teamName, ws.data.subId);
						}
						ws.send(payload);
					}

					console.log(
						`[send] channel_push to ${qualifiedTo} [${channelJobId}]${messageId ? ` msg=${messageId.slice(0, 8)}` : ""} from ${from} (${activeWs.length} sub-session${activeWs.length > 1 ? "s" : ""})`,
					);
				}

				if (targetWs && !targetWs.data.virtual) {
					const toAddr = target.address;
					if (inboundSessionId) {
						// Federated inbound landing: only the local target is ours to mirror. `from` here.
						mirrorPeer(toAddr, from, toAddr.canonical, { body: msgBody, files });
					} else if (!opts.consoleSender) {
						// A malformed `from` (never slug-validated at the SendRequestSchema boundary) must.
						const fromAddr = tryLocalAddress(from);
						if (fromAddr && provedLocalSession(req)) {
							mirrorPeer(fromAddr, fromAddr.canonical, toAddr.canonical, { body: msgBody, files });
							mirrorPeer(toAddr, fromAddr.canonical, toAddr.canonical, { body: msgBody, files });
						}
					}
				}

				return jsonResponse({
					session_id: channelJobId,
					status: "running",
					message: `Message pushed to ${localName} via channel. Responses will be pushed back automatically.`,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[send] channel error:`, message);
				return jsonResponse({ error: message }, 500);
			}
		}

		// Unreachable: targetMode is the single-value `channel` literal, so the block above always.
		return jsonResponse({ error: "unsupported connection mode" }, 400);
	}

	return { send };
}
