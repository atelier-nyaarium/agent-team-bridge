import type { Ambient } from "../../shared/ambient.js";
import { pickTiers } from "../../shared/notice.js";
import type { PendingJobStore } from "../../shared/pending-job-store.js";
import { type Address, parseStoreKey } from "../../shared/session-id.js";
import type { GatewayConfig, ResponsePayload, ResponsePushPayload } from "../../shared/types.js";
import { isNoAckSessionId } from "../awarenessBank.js";
import {
	fileBytes,
	getTeamMode,
	jsonResponse,
	MAX_RESPONSE_FILE_BYTES,
	PollRequestSchema,
	RespondBodySchema,
	stampBlobHolder,
	stripFileRefs,
} from "../routeSchemas.js";
import { type Presented, presentedByRequest } from "../sessionAuthority.js";
import {
	type ConversationRegistry,
	getAllActiveWs,
	type HandshakeRepushOutcome,
	type TeamRegistry,
} from "../websocket.js";

type ConsolePushOps = ReturnType<typeof import("../consolePushOps.js").createConsolePushOps>;

export interface RespondRoutesDeps {
	config: GatewayConfig;
	ambient: Pick<Ambient, "newId">;
	localDomain: string;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: Pick<PendingJobStore<ResponsePayload>, "deliver" | "targetOf" | "has" | "poll">;
	resolveHandshake?: (
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		response?: string,
		responderToken?: Presented,
	) => boolean;
	// The pending hs-* id owed by a (team, subId), if any - lets respond() name the exact handshake.
	findPendingHandshake?: (team: string, subId: string) => string | undefined;
	// Re-sends a (team, subId)'s still-pending handshake so a caller that lost the original.
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	// Whether a local session (canonical domain.gateway.spawn.session) is still shared to a friend Domain,.
	isSharedToForReply?: ((sessionTarget: string, domainId: string) => boolean) | null;
	// This Gateway's own Domain owner id (a hash of the owner's signing key), used to key the.
	ownerId?: (() => string | null) | null;
	tryLocalAddress: (name: string) => Address | null;
	relayWithRetry: (
		dstGateway: string,
		op: import("../../shared/federation-protocol.js").FederatedOp,
		label: string,
		dstDomain?: string,
		producerOpId?: string,
	) => Promise<{ ok: boolean; error?: string }>;
	mirrorPeer: ConsolePushOps["mirrorPeer"];
	deliverToOwner: ConsolePushOps["deliverToOwner"];
	refuseForeignReply: (req: Request, target: string) => Response | null;
	refuseForeignPoll: (req: Request, sessionId: string) => Response | null;
	provedLocalSession: (req: Request) => boolean;
}

export function createRespondRoutes({
	config,
	localDomain,
	registry,
	conversationRegistry,
	store,
	resolveHandshake,
	findPendingHandshake,
	repushHandshake,
	isSharedToForReply,
	ownerId,
	tryLocalAddress,
	relayWithRetry,
	mirrorPeer,
	deliverToOwner,
	refuseForeignReply,
	refuseForeignPoll,
	provedLocalSession,
	ambient,
}: RespondRoutesDeps) {
	const { localGatewayId } = config;

	function respond(
		req: Request,
		body: Record<string, unknown>,
		// Unlike send(), respond() never needs to tell "trusted federated relay" apart from a.
		opts: { consoleSender?: boolean; trustedInbound?: boolean; onFederatedSettled?: (ok: boolean) => void } = {},
	): Response {
		const parsed = RespondBodySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}

		const { session_id: respondSessionId, replyAsJson, files: rawFiles, opId: producerOpId, ...rest } = parsed.data;
		// Stamp this Gateway as the holder, but only for a LOCAL agent: it uploaded its bytes here and.
		const files =
			rawFiles &&
			(opts.trustedInbound || opts.consoleSender ? rawFiles : stampBlobHolder(rawFiles, localGatewayId));

		// Raw-bytes backstop before anything is stored or pushed.
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}

		// Check if this is a handshake response (handshakes never carry files). The caller's own.
		const responderToken = presentedByRequest(req);
		if (
			resolveHandshake?.(respondSessionId, replyAsJson ?? undefined, rest.response ?? undefined, responderToken)
		) {
			return jsonResponse({ delivered: true, handshake: true });
		}

		// Nothing can ENFORCE no-reply, so a reply that comes anyway would miss at store.deliver and.
		if (isNoAckSessionId(respondSessionId) && !store.has(respondSessionId)) {
			return jsonResponse({ delivered: true, noAck: true });
		}

		// This reply isn't itself resolving a handshake - but if the CALLER's own bridge handshake is.
		if (rest.conversationId) {
			const callerWs = conversationRegistry.get(rest.conversationId);
			if (callerWs && callerWs.readyState === 1 && !callerWs.data.virtual && !callerWs.data.handshakeConfirmed) {
				const team = callerWs.data.teamName;
				const pendingHsId = team && findPendingHandshake?.(team, callerWs.data.subId);
				// Deliberately does not name the pending hs-* id: conversationId is not secret (it rides.
				if (team && pendingHsId) {
					// Re-push the handshake before bouncing: the caller may have lost the original.
					const outcome = repushHandshake?.(team, callerWs.data.subId);
					const error =
						outcome === "capped"
							? "Your bridge handshake is still unconfirmed after repeated prompts. This session may be stale or lagging a version behind - consider restarting it."
							: outcome === "socket-gone"
								? "Your bridge handshake could not be re-delivered. Try again shortly."
								: "Your bridge handshake is still pending. Reply to the handshake session first with channel_reply_structured, then resend this reply.";
					return jsonResponse({ error }, 409);
				}
			}
		}

		// If JSON reply provided but no explicit response string, pretty-stringify for text consumers.
		const response: ResponsePayload = {
			session_id: respondSessionId,
			status: rest.status as ResponsePayload["status"] | undefined,
			response: rest.response,
			...pickTiers(rest),
			question: rest.question,
			reason: rest.reason,
			estimated_minutes: rest.estimated_minutes,
			what_to_decide: rest.what_to_decide,
			message: rest.message,
		};
		// The STORE keeps names, never a way to get the bytes. `/poll` reads this copy and authorizes.
		if (files && files.length > 0) response.files = stripFileRefs(files);
		if (replyAsJson) {
			response.replyAsJson = replyAsJson;
			if (!response.response) {
				response.response = JSON.stringify(replyAsJson, null, 2);
			}
		}

		// A reply may only come from the session the job is addressed to: the id is a pure function of.
		const jobTarget = store.targetOf(respondSessionId);
		if (jobTarget && !opts.consoleSender && !opts.trustedInbound) {
			const refused = refuseForeignReply(req, jobTarget);
			if (refused) return refused;
		}

		// The respond session_id is the opaque store key the agent echoes verbatim; under the.
		const deliverResult = store.deliver(respondSessionId, response);
		if (!deliverResult) {
			console.log(
				`[respond] 404 - no pending job for ${respondSessionId.slice(0, 8)}... (already delivered or expired)`,
			);
			return jsonResponse({ error: `No pending request for session_id "${respondSessionId}"` }, 404);
		}

		console.log(`[respond] ${respondSessionId}${response.status ? ` → ${response.status}` : ""}`);

		// Cross-Gateway reply-pinning: a job created by a federated send belongs to the.
		if (deliverResult.returnRoute) {
			const rr = deliverResult.returnRoute;
			// Re-check the per-session share on a CROSS-DOMAIN reply (a destination job carries the.
			if (deliverResult.dstDomainId) {
				const pinned = parseStoreKey(rr.srcSession);
				const sessionTarget = pinned?.kind === "conv" ? pinned.address.canonical : undefined;
				if (!sessionTarget || !isSharedToForReply?.(sessionTarget, deliverResult.dstDomainId)) {
					console.log(
						`[respond] ${respondSessionId} DROPPED: session no longer shared to Domain "${deliverResult.dstDomainId}"`,
					);
					return jsonResponse({ delivered: false, dropped: "unshared" });
				}
			}
			const relayOutcome = relayWithRetry(
				rr.srcGateway,
				{
					kind: "response_push",
					session_id: rr.srcSession,
					...(response.status ? { status: response.status } : {}),
					...(response.response ? { response: response.response } : {}),
					...pickTiers(response),
					...(response.replyAsJson ? { replyAsJson: response.replyAsJson } : {}),
					...(response.question ? { question: response.question } : {}),
					...(response.reason ? { reason: response.reason } : {}),
					...(files && files.length > 0 ? { files } : {}),
				},
				"cross-Gateway reply-pin",
				deliverResult.dstDomainId ?? undefined,
				producerOpId,
			);
			if (opts.onFederatedSettled) {
				void relayOutcome.then((r) => opts.onFederatedSettled?.(r.ok));
			}
			console.log(`[respond] ${respondSessionId} pinned to Gateway ${rr.srcGateway} via the Router`);
			// Mirror the LOCAL responder's own thread. Never for the console itself (opts.consoleSender) -.
			const localAddr = opts.consoleSender ? null : tryLocalAddress(deliverResult.to);
			if (localAddr && provedLocalSession(req)) {
				mirrorPeer(localAddr, localAddr.canonical, deliverResult.from, {
					body: response.response,
					files,
					status: response.status,
					...pickTiers(response),
				});
			}
			return jsonResponse({ delivered: true, federated: true });
		}

		// Push response back to the sender. For conversation-routed sends we target the.
		const push: ResponsePushPayload = {
			type: "response_push",
			session_id: respondSessionId,
			response: response.response,
		};
		if (response.status) push.status = response.status;
		// The push carries the full bytes; the store kept metadata only. message_id is the.
		if (files && files.length > 0) {
			push.files = files;
			push.message_id = ambient.newId();
		}
		const pushMsg = JSON.stringify(push);

		let pushedViaConversation = false;
		if (deliverResult.fromConversationId) {
			const senderWs = conversationRegistry.get(deliverResult.fromConversationId);
			// Console threads carry the owner id as their conversation id.
			if (deliverResult.fromConversationId === ownerId?.()) {
				const delivered = deliverToOwner({
					entry: {
						kind: "reply",
						session_id: respondSessionId,
						body: response.response,
						...pickTiers(response),
						status: response.status,
						files: files && files.length > 0 ? files : undefined,
					},
					dedupeKey: ambient.newId(),
					label: "respond",
				});
				pushedViaConversation = delivered === true;
				console.log(
					`[respond] ${delivered === true ? "appended to the owner inbox" : "owner inbox append refused"} for conversation ${deliverResult.fromConversationId.slice(0, 8)}... [${respondSessionId}]`,
				);
			} else if (senderWs && senderWs.readyState === 1) {
				senderWs.send(pushMsg);
				pushedViaConversation = true;
				console.log(
					`[respond] pushed to ${deliverResult.from} via conversation ${deliverResult.fromConversationId.slice(0, 8)}... [${respondSessionId}]`,
				);
			} else {
				console.log(
					`[respond] conversation ${deliverResult.fromConversationId.slice(0, 8)}... offline, response kept in store [${respondSessionId}]`,
				);
			}
			const askerAddr = opts.consoleSender ? null : tryLocalAddress(deliverResult.from);
			if (askerAddr && provedLocalSession(req)) {
				const key = parseStoreKey(respondSessionId);
				const isRemoteAnchor =
					key?.kind === "conv" &&
					(key.address.gateway !== localGatewayId || key.address.domain !== localDomain);
				const mirrorPayload = {
					body: response.response,
					files,
					status: response.status,
					...pickTiers(response),
				};
				if (isRemoteAnchor) {
					mirrorPeer(askerAddr, deliverResult.to, askerAddr.canonical, mirrorPayload);
				} else {
					const replierAddr = tryLocalAddress(deliverResult.to);
					if (replierAddr) {
						mirrorPeer(askerAddr, replierAddr.canonical, askerAddr.canonical, mirrorPayload);
						mirrorPeer(replierAddr, replierAddr.canonical, askerAddr.canonical, mirrorPayload);
					}
				}
			}
		}

		// Conversation-routed sends never degrade to name-based broadcast: the.
		if (!pushedViaConversation && !deliverResult.fromConversationId) {
			const fromSubs = registry.get(deliverResult.from);
			if (fromSubs && getTeamMode(fromSubs) === "channel") {
				try {
					const activeWsList = getAllActiveWs(fromSubs);
					for (const ws of activeWsList) {
						ws.send(pushMsg);
					}
					if (activeWsList.length > 0) {
						console.log(
							`[respond] pushed to ${deliverResult.from} via team broadcast (${activeWsList.length} subs) [${respondSessionId}]`,
						);
					}
				} catch {
					console.log(`[respond] push failed, kept for polling [${respondSessionId.slice(0, 8)}...]`);
				}
			}
		}

		return jsonResponse({ delivered: true });
	}

	function poll(req: Request, body: Record<string, unknown>): Response {
		const parsed = PollRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `session_id is required` }, 400);
		}

		const { session_id } = parsed.data;

		// Before the read, since a persistent entry is not consumed and would keep paying out.
		const refused = refuseForeignPoll(req, session_id);
		if (refused) return refused;

		const result = store.poll(session_id);

		if (result === undefined) {
			return jsonResponse({ error: `No pending job for session_id "${session_id}"` }, 404);
		}

		if (result === null) {
			return jsonResponse({
				session_id,
				status: "running",
				message: `Job is still running. Poll again later.`,
			});
		}

		return jsonResponse(result);
	}

	return { respond, poll };
}
