import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { Mutex } from "../shared/mutex.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import { composeConvSessionId, noticeSessionId } from "../shared/phone-protocol.js";
import { ChannelFilesSchema, PostResponsePartsSchema } from "../shared/schemas.js";
import type {
	ArbiterConfig,
	ChannelFile,
	ConnectionMode,
	ResponsePayload,
	ResponsePushPayload,
	TeamInfo,
} from "../shared/types.js";
import {
	type ConversationRegistry,
	formatHolderConnectedMessage,
	getAllActiveWs,
	RESERVED_TEAM_NAMES,
	type TeamRegistry,
	type WsData,
} from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

export interface RoutesDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	getMutex: ((team: string) => Mutex) & { peek: (team: string) => Mutex | undefined };
	tryWakeTeam: (team: string) => Promise<boolean>;
	offlineCatalog: Map<string, string>;
	// Durable team -> projectPath map (never cleared, unlike offlineCatalog which
	// empties when the host daemon disconnects). Membership in either marks a
	// team as devcontainer-backed.
	knownTeamPaths: Map<string, string>;
	// Phone mailboxes, for broadcast notices (notify_human). Optional so test
	// harnesses without a phone bridge need not supply one.
	mailboxStore?: import("../shared/device-mailbox.js").DeviceMailboxStore;
	config: ArbiterConfig;
	evieClient?: import("./evie/evieClient.js").EvieClient | null;
	resolveHandshake?: (sessionId: string, replyAsJson?: Record<string, unknown>, response?: string) => boolean;
	pinnedHolders: Map<string, string | null>;
	sessionToChannel: Map<string, string>;
	postSystemMessageToChannel: (channelId: string, text: string) => Promise<void>;
}

const SendRequestSchema = z.object({
	from: z.string(),
	fromConversationId: z.string().optional(),
	to: z.string(),
	type: z.string().optional(),
	effort: z.string().optional(),
	body: z.string().optional(),
	session_id: z.string().optional(),
	debug: z.boolean().optional(),
	replyJsonSchema: z.string().optional(),
	files: ChannelFilesSchema.optional(),
	// Phone-originated sends: reject CLI-mode targets instead of entering the
	// CLI branch, which mints a random session id the phone can never thread.
	channelOnly: z.boolean().optional(),
});

const RespondBodySchema = z.object({
	session_id: z.string(),
	status: z.string().optional(),
	response: z.string().optional(),
	replyAsJson: z.record(z.string(), z.unknown()).optional(),
	question: z.string().optional(),
	reason: z.string().optional(),
	estimated_minutes: z.number().optional(),
	what_to_decide: z.string().optional(),
	message: z.string().optional(),
	files: ChannelFilesSchema.optional(),
});

// Raw-bytes backstop on attachment payloads at the trust boundary. Shape
// validation does not bound memory, so sum the decoded sizes cheaply (base64 is
// ~4/3 of the bytes) before anything is stored or pushed.
const MAX_RESPONSE_FILE_BYTES = 10_000_000;

function fileBytes(files: ChannelFile[]): number {
	let n = 0;
	for (const f of files) n += f.base64 ? Math.floor((f.base64.length * 3) / 4) : f.size;
	return n;
}

/** Drop base64 so a persistent store entry never retains the bytes; the live
 * push and the mailbox carry the payload, the store keeps only metadata. */
function stripFileBytes(files: ChannelFile[]): ChannelFile[] {
	return files.map(({ base64: _omit, ...meta }) => meta);
}

const PollRequestSchema = z.object({
	session_id: z.string(),
});

const EvieToolCallSchema = z.object({
	action: z.string(),
	params: z.record(z.string(), z.unknown()),
});

const HumanRespondSchema = z.object({
	from: z.string(),
	session_id: z.string(),
	parts: PostResponsePartsSchema,
});

// summary and full are REQUIRED: a notice must always carry an addressable
// short tier and a real body (no ghost pings that are only a bar headline).
// title accepts the legacy `tiny` key during the rename transition; the
// handler resolves `title ?? tiny`.
const HumanNotifySchema = z
	.object({
		from: z.string().min(1).max(128),
		title: z.string().min(1).max(200).optional(),
		tiny: z.string().min(1).max(200).optional(),
		summary: z.string().min(1),
		full: z.string().min(1),
		files: ChannelFilesSchema.optional(),
	})
	.refine((d) => Boolean(d.title || d.tiny), { message: "title (or legacy tiny) is required" });

const HumanTransferSchema = z.object({
	from: z.string(),
	session_id: z.string(),
	team: z.string(),
	brief: z.string().min(1),
});

////////////////////////////////
//  Functions & Helpers

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Get the first active WebSocket for a team (any sub-session). */
function getFirstWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData> | undefined {
	for (const [, ws] of subs) {
		if (ws.readyState === 1) return ws;
	}
	return undefined;
}

/** Get the mode of a team, preferring real sockets over virtual phone peers
 * (which are always channel mode and could otherwise misroute a CLI team). */
function getTeamMode(subs: Map<string, ServerWebSocket<WsData>>): ConnectionMode {
	let virtualMode: ConnectionMode | null = null;
	for (const [, ws] of subs) {
		if (!ws.data.virtual) return ws.data.mode;
		virtualMode = virtualMode ?? ws.data.mode;
	}
	return virtualMode ?? "cli";
}

/**
 * Derive the stable channel job id for a channel-mode exchange.
 * Same (sender conversation id, target team) pair always produces the same key, so
 * subsequent sends reuse the same store entry instead of generating a fresh UUID
 * that eventually gets swept. Falls back to null if the sender did not provide
 * a conversation id (channel mode should always provide one now).
 */
function deriveChannelJobId(fromConversationId: string | undefined, to: string): string | null {
	if (!fromConversationId) return null;
	return composeConvSessionId(fromConversationId, to);
}

export function createRoutes({
	registry,
	conversationRegistry,
	store,
	getMutex,
	tryWakeTeam,
	offlineCatalog,
	knownTeamPaths,
	mailboxStore,
	config,
	evieClient,
	resolveHandshake,
	pinnedHolders,
	sessionToChannel,
	postSystemMessageToChannel,
}: RoutesDeps) {
	const { LOG_PATH, RESPONSE_TIMEOUT_MS } = config;

	function ingest(req: Request, body: Record<string, unknown>): Response {
		const payload: Record<string, unknown> = body && typeof body === "object" ? body : { message: String(body) };
		payload.timestamp = payload.timestamp ?? Date.now();
		const line = `${JSON.stringify(payload)}\n`;
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(LOG_PATH, line);
			return jsonResponse({ ok: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[ingest]`, message);
			return jsonResponse({ ok: false, error: message }, 500);
		}
	}

	function pending(): Response {
		const list = store.listAll().map((e) => ({
			session_id: e.id,
			from: e.from,
			to: e.to,
			state: e.state,
		}));
		return jsonResponse(list);
	}

	function teams(): Response {
		const teamsList: TeamInfo[] = [];
		const seen = new Set<string>();
		const isDevcontainer = (name: string) => offlineCatalog.has(name) || knownTeamPaths.has(name);

		for (const [name, subs] of registry) {
			if (name === "host") continue;
			seen.add(name);
			const lock = getMutex.peek(name);
			teamsList.push({
				team: name,
				status: "online",
				mode: getTeamMode(subs),
				kind: isDevcontainer(name) ? "devcontainer" : "loose",
				queue_depth: lock ? lock.queue.length + (lock.locked ? 1 : 0) : 0,
			});
		}

		for (const [name] of offlineCatalog) {
			if (seen.has(name)) continue;
			teamsList.push({ team: name, status: "available", kind: "devcontainer", queue_depth: 0 });
		}

		return jsonResponse(teamsList);
	}

	async function send(req: Request, body: Record<string, unknown>): Promise<Response> {
		const parsed = SendRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const {
			from,
			fromConversationId,
			to,
			type,
			effort,
			body: msgBody,
			debug,
			replyJsonSchema,
			files,
			channelOnly,
		} = parsed.data;

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

		if (RESERVED_TEAM_NAMES.has(to)) {
			return jsonResponse(
				{
					error: `"${to}" is a reserved name. Use transfer_human_to for the Discord channel; crosstalk_send targets container teams only.`,
				},
				400,
			);
		}

		let subs = registry.get(to);
		let targetWs = subs ? getFirstWs(subs) : undefined;

		// If offline, attempt to wake the container
		if (!targetWs) {
			const woken = await tryWakeTeam(to);
			if (woken) {
				// Claude Code needs time after MCP connect to initialize its channel listener.
				// Registration happens instantly but channel notifications aren't ready yet.
				await new Promise((r) => setTimeout(r, 3000));
				subs = registry.get(to);
				targetWs = subs ? getFirstWs(subs) : undefined;
			}
		}

		if (!targetWs || !subs) {
			return jsonResponse(
				{
					error: `Team "${to}" is not connected`,
					available: [...registry.keys()].filter((k) => !RESERVED_TEAM_NAMES.has(k)),
				},
				404,
			);
		}

		const targetMode = getTeamMode(subs);

		// channelOnly senders (the phone) must never reach the CLI branch below:
		// it mints a fresh random session id that can never join the sender's
		// deterministic conversation threads. Checked post-wake, so even a
		// sleeping CLI team that this send just woke gets a clean error instead
		// of an orphan session.
		if (channelOnly && targetMode !== "channel") {
			return jsonResponse(
				{ error: `"${to}" is a CLI-mode agent; phone chat supports channel-mode (Claude) teams only` },
				409,
			);
		}

		// Channel mode: stable job id per (sender_conversation_id, target_team) pair.
		// Same pair reuses the same store entry forever; entries are persistent.
		if (targetMode === "channel") {
			try {
				const channelJobId = deriveChannelJobId(fromConversationId, to);
				if (!channelJobId) {
					return jsonResponse({ error: `fromConversationId is required for channel-mode targets` }, 400);
				}

				const isFollowUp = store.has(channelJobId);
				store.create(channelJobId, from, to, { persistent: true, fromConversationId });

				const messageId = crypto.randomUUID();
				const channelPayload: Record<string, unknown> = {
					type: "channel_push",
					from,
					request_type: type || "question",
					body: msgBody || "",
					effort: effort || "auto",
					session_id: channelJobId,
					message_id: messageId,
					is_follow_up: isFollowUp,
				};
				if (replyJsonSchema) channelPayload.replyJsonSchema = replyJsonSchema;
				// message_id becomes the materialization bucket key in the target container.
				if (files && files.length > 0) channelPayload.files = files;
				const payload = JSON.stringify(channelPayload);

				const activeWs = getAllActiveWs(subs);
				if (activeWs.length === 0) {
					throw new Error(`Team "${to}" has no active connections`);
				}

				for (const ws of activeWs) {
					ws.send(payload);
				}

				console.log(
					`[send] channel_push to ${to} [${channelJobId}] msg=${messageId.slice(0, 8)} from ${from} (${activeWs.length} sub-session${activeWs.length > 1 ? "s" : ""})`,
				);

				return jsonResponse({
					session_id: channelJobId,
					status: "running",
					message: `Message pushed to ${to} via channel. Responses will be pushed back automatically.`,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[send] channel error:`, message);
				return jsonResponse({ error: message }, 500);
			}
		}

		// CLI mode: send to first available sub, mutex + wait for response
		const sessionId = crypto.randomUUID();
		let release: (() => void) | undefined;

		try {
			const mutex = getMutex(to);
			release = await mutex.acquire(sessionId);

			console.log(`[mutex] ${to} locked by ${sessionId} (from ${from})`);

			store.create(sessionId, from, to);

			const payload = {
				type: "inject",
				from,
				request_type: type || "question",
				body: msgBody || "",
				effort: effort || "auto",
				session_id: sessionId,
				is_follow_up: false,
			};

			if (targetWs.readyState !== 1) {
				throw new Error(`Team "${to}" disconnected before message could be delivered`);
			}
			targetWs.send(JSON.stringify(payload));

			const waitResult = await store.waitForResult(sessionId, RESPONSE_TIMEOUT_MS);

			if (release) {
				console.log(`[mutex] ${to} released [${waitResult.delivered ? "delivered" : "running"}]`);
				release();
			}

			if (waitResult.delivered && waitResult.result) {
				const response = waitResult.result;
				if (debug) {
					return jsonResponse({ ...response, session_id: sessionId, from, to, is_follow_up: false });
				}
				return jsonResponse(response);
			}

			return jsonResponse({
				session_id: sessionId,
				status: "running",
				message: `No response from ${to} within ${RESPONSE_TIMEOUT_MS / 1000}s. Poll with session_id to check later.`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[send] Error:`, message);
			if (release) release();
			return jsonResponse({ error: message }, 500);
		}
	}

	function respond(req: Request, body: Record<string, unknown>): Response {
		const parsed = RespondBodySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}

		const { session_id: respondSessionId, replyAsJson, files, ...rest } = parsed.data;

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

		// Check if this is a handshake response (handshakes never carry files).
		if (resolveHandshake?.(respondSessionId, replyAsJson ?? undefined, rest.response ?? undefined)) {
			return jsonResponse({ delivered: true, handshake: true });
		}

		// If JSON reply provided but no explicit response string, pretty-stringify for text consumers
		const response: ResponsePayload = {
			session_id: respondSessionId,
			status: rest.status as ResponsePayload["status"] | undefined,
			response: rest.response,
			question: rest.question,
			reason: rest.reason,
			estimated_minutes: rest.estimated_minutes,
			what_to_decide: rest.what_to_decide,
			message: rest.message,
		};
		// The store result is poll-recoverable and (for channel convs) never swept,
		// so it keeps file metadata only; the bytes ride the live push/mailbox below.
		if (files && files.length > 0) response.files = stripFileBytes(files);
		if (replyAsJson) {
			response.replyAsJson = replyAsJson;
			if (!response.response) {
				response.response = JSON.stringify(replyAsJson, null, 2);
			}
		}

		const deliverResult = store.deliver(respondSessionId, response);
		if (!deliverResult) {
			console.log(
				`[respond] 404 - no pending job for ${respondSessionId.slice(0, 8)}... (already delivered or expired)`,
			);
			return jsonResponse({ error: `No pending request for session_id "${respondSessionId}"` }, 404);
		}

		console.log(`[respond] ${respondSessionId}${response.status ? ` → ${response.status}` : ""}`);

		// Push response back to the sender. For conversation-routed sends we target the
		// specific sub-session via conversationRegistry so parallel host windows don't
		// all receive each other's replies. Fall back to team broadcast if there
		// is no conversation id on the entry (CLI mode that still uses waitForResult
		// has already been satisfied above and won't hit this branch for a push).
		const push: ResponsePushPayload = {
			type: "response_push",
			session_id: respondSessionId,
			response: response.response,
			replyAsJson: response.replyAsJson,
			question: response.question,
			reason: response.reason,
		};
		if (response.status) push.status = response.status;
		// The push carries the full bytes (the store kept metadata only).
		if (files && files.length > 0) push.files = files;
		const pushMsg = JSON.stringify(push);

		let pushedViaConversation = false;
		if (deliverResult.fromConversationId) {
			const senderWs = conversationRegistry.get(deliverResult.fromConversationId);
			if (senderWs && senderWs.readyState === 1) {
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
		}

		// Conversation-routed sends never degrade to name-based broadcast: the
		// sender team name may since have been claimed by an unrelated identity
		// (e.g. a real team replacing an evicted phone peer), and the result
		// stays poll-recoverable in the store regardless.
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

	function health(): Response {
		return jsonResponse({
			ok: true,
			teams: registry.size,
			pending_jobs: store.size,
		});
	}

	async function evieToolCall(req: Request, body: Record<string, unknown>): Promise<Response> {
		if (!evieClient || !evieClient.isConnected()) {
			return jsonResponse({ error: `Evie-bot is not connected.` }, 503);
		}

		const parsed = EvieToolCallSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: action (string) and params (object) are required` }, 400);
		}

		const { action, params } = parsed.data;
		const result = await evieClient.callTool(action, params as Record<string, unknown>);
		return jsonResponse(result, result.error ? 500 : 200);
	}

	function evieTools(): Response {
		if (!evieClient || !evieClient.isConnected()) {
			return jsonResponse({ error: `Evie-bot is not connected.`, tools: [] }, 503);
		}
		return jsonResponse({ tools: evieClient.getToolSchemas() });
	}

	// The host process registers two WebSockets with arbiter: "arbiter" (channel mode,
	// the channel responder) and "host" (cli mode, the wake-listener daemon). They are
	// the same Claude process, so either identity is authoritative for the other when
	// checking channel-holder equality.
	function holderMatchesSender(holder: string, from: string): boolean {
		if (holder === from) return true;
		if (RESERVED_TEAM_NAMES.has(holder) && RESERVED_TEAM_NAMES.has(from)) return true;
		return false;
	}

	async function humanRespond(body: Record<string, unknown>): Promise<Response> {
		const parsed = HumanRespondSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, session_id, parts } = parsed.data;

		const channelId = sessionToChannel.get(session_id);
		if (!channelId) {
			return jsonResponse(
				{ error: `Unknown session_id. Only sessions from recent channel_push messages are valid.` },
				404,
			);
		}

		const currentHolder = pinnedHolders.get(channelId) ?? null;
		if (currentHolder !== null && !holderMatchesSender(currentHolder, from)) {
			return jsonResponse(
				{
					error: `Channel is currently held by "${currentHolder}". Ask them via crosstalk_send for the line, then they can transfer_human_to you.`,
				},
				403,
			);
		}

		if (currentHolder === null) {
			pinnedHolders.set(channelId, from);
			await postSystemMessageToChannel(channelId, formatHolderConnectedMessage(from));
		}

		if (!evieClient || !evieClient.isConnected()) {
			return jsonResponse({ error: `Evie-bot is not connected.` }, 503);
		}

		const result = await evieClient.callTool("post_response", { parts, channelId });
		if (result.error) {
			return jsonResponse({ error: result.error }, 500);
		}
		const partsSent = (result.result as { partsSent?: number } | undefined)?.partsSent ?? parts.length;
		console.log(`[human] ${from} responded to channel ${channelId} (${partsSent}/${parts.length} parts)`);
		return jsonResponse({ ok: true, partsSent });
	}

	async function humanTransfer(body: Record<string, unknown>): Promise<Response> {
		const parsed = HumanTransferSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, session_id, team: teamInput, brief } = parsed.data;

		const channelId = sessionToChannel.get(session_id);
		if (!channelId) {
			return jsonResponse(
				{ error: `Unknown session_id. Only sessions from recent channel_push messages are valid.` },
				404,
			);
		}

		const target = teamInput;
		if (holderMatchesSender(target, from)) {
			return jsonResponse({ error: `You are already the holder.` }, 400);
		}

		const currentHolder = pinnedHolders.get(channelId) ?? null;
		if (currentHolder !== null && !holderMatchesSender(currentHolder, from)) {
			return jsonResponse(
				{
					error: `Channel is currently held by "${currentHolder}". Ask them via crosstalk_send for the line first.`,
				},
				403,
			);
		}

		let subs = registry.get(target);
		let activeWs = subs ? getAllActiveWs(subs) : [];

		if (activeWs.length === 0) {
			if (RESERVED_TEAM_NAMES.has(target)) {
				return jsonResponse({ error: `"${target}" is offline; cannot transfer.` }, 503);
			}
			const woken = await tryWakeTeam(target);
			if (!woken) {
				return jsonResponse({ error: `Failed to wake target team "${target}".` }, 503);
			}
			await new Promise((r) => setTimeout(r, 3000));
			subs = registry.get(target);
			activeWs = subs ? getAllActiveWs(subs) : [];
			if (activeWs.length === 0) {
				return jsonResponse({ error: `Target team "${target}" did not come online.` }, 503);
			}
		}

		await postSystemMessageToChannel(channelId, formatHolderConnectedMessage(target));
		pinnedHolders.set(channelId, target);

		const briefSessionId = crypto.randomUUID();
		sessionToChannel.set(briefSessionId, channelId);

		const pushPayload = {
			type: "channel_push",
			from: "discord",
			request_type: "handoff",
			body: `[Handoff brief from ${from}]\n\n${brief}`,
			effort: "standard",
			session_id: briefSessionId,
			is_follow_up: false,
		};
		const serialized = JSON.stringify(pushPayload);
		for (const ws of activeWs) {
			ws.send(serialized);
		}

		console.log(`[human] ${from} → ${target} transfer on channel ${channelId} [${briefSessionId.slice(0, 8)}]`);
		return jsonResponse({ ok: true, target, session_id: briefSessionId });
	}

	/** Broadcast a notice to every registered phone mailbox. Notices thread under
	 * the sender on the phone and are never respondable: they are appended
	 * directly here (not via a peer push), so no inbound session is recorded. */
	function humanNotify(body: Record<string, unknown>): Response {
		const parsed = HumanNotifySchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const { from, summary, full, files } = parsed.data;
		const title = parsed.data.title ?? parsed.data.tiny;
		if (files && files.length > 0) {
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}
		if (!mailboxStore) {
			return jsonResponse({ error: "phone bridge is not enabled on this arbiter" }, 503);
		}
		let delivered = 0;
		mailboxStore.forEach((_conversationId, box) => {
			box.append({
				kind: "notice",
				session_id: noticeSessionId(from),
				from,
				title,
				summary,
				body: full,
				...(files && files.length > 0 ? { files } : {}),
			});
			delivered++;
		});
		console.log(`[notify] notice from ${from} delivered to ${delivered} phone(s)`);
		return jsonResponse({ delivered });
	}

	return {
		ingest,
		pending,
		teams,
		send,
		respond,
		poll,
		health,
		evieToolCall,
		evieTools,
		humanRespond,
		humanTransfer,
		humanNotify,
	};
}
