import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { z } from "zod";
import type { RouterReachAnswer } from "../federation-server/consoleSurface.js";
import { APP_TOKEN_HEADER } from "../federation-server/consoleSurface.js";
import type { ConsoleOp } from "../shared/console-protocol.js";
import {
	type ContentAad,
	inboxBodyAadKind,
	openContent,
	opPayloadAadKind,
	opResultAadKind,
	sealContent,
	valueResultAadKind,
} from "../shared/content-envelope.js";
import { type EnrollOp, type EnrollResult, EnrollResultSchema } from "../shared/federation-enroll-ops.js";
import { type BoardReadResult, BoardReadResultSchema } from "../shared/schemasBoardState.js";
import { MailboxEntrySchema } from "../shared/schemasConsoleOp.js";
import { type ContentEnvelope, ContentEnvelopeSchema } from "../shared/schemasContentKey.js";
import {
	formatInboxAddress,
	type InboxRow,
	InboxRowSchema,
	type OpResultEnvelope,
	OpResultEnvelopeSchema,
	type OwnerOp,
	type OwnerOpFields,
	signOwnerOp,
	signRowEnvelope,
} from "../shared/schemasInbox.js";
import { type FixtureDraws, FixtureWorld } from "./fixtureWorld.js";
import type { IdentitySet } from "./identitySet.js";

export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;

export interface PhoneDriverDeps {
	world?: FixtureWorld;
	set?: IdentitySet;
	handle: (request: Request) => Promise<Response>;
	now?: () => number;
	draws?: FixtureDraws;
	randomBytes?: (size: number) => Buffer;
	newOpId?: () => string;
}

export interface PostAnswer {
	status: number;
	body: unknown;
}

export interface ReachAnswer extends RouterReachAnswer {
	gateways: Array<{ gatewayId: string; signFp: string | null }>;
}

export interface ValueAnswer {
	envelope: OpResultEnvelope;
	result: unknown;
}

export interface PhoneDriver {
	ownerOp(op: Record<string, unknown>, opId?: string): OwnerOp;
	post(op: OwnerOp): Promise<PostAnswer>;
	console(body: Record<string, unknown>): Promise<PostAnswer>;
	enroll(op: EnrollOp): Promise<EnrollResult & Record<string, unknown>>;
	reach(): Promise<ReachAnswer>;
	send(op: Record<string, unknown>, opId?: string): Promise<unknown>;
	value(consoleOp: ConsoleOp, opId?: string): Promise<ValueAnswer>;
	deliver(sessionId: string, consoleOp: ConsoleOp, opId?: string): Promise<OpResultEnvelope>;
	consumerRegister(): Promise<{ cursor: number; cursorEpoch: number }>;
	inboxRead(fromSeq?: number, limit?: number): Promise<InboxRow[]>;
	inboxAdvance(cursor: number): Promise<unknown>;
	planesRead(
		known?: Record<string, number>,
	): Promise<{ planes: Array<{ name: string; version: number; payload?: unknown }> }>;
	seal(plaintext: string, kind: ContentAad["kind"]): ContentEnvelope;
	openText(envelope: ContentEnvelope, kind: ContentAad["kind"]): string;
	open(row: InboxRow): unknown;
	boardRead(): Promise<BoardReadResult>;
	entries(rows: InboxRow[]): MailboxEntry[];
}

const ENTRY_KINDS = new Set(["message", "reply", "notice", "sent", "peer", "plugin_action"]);

export function createPhoneDriver(deps: PhoneDriverDeps): PhoneDriver {
	const world = deps.world ?? FixtureWorld.from(deps.set as IdentitySet);
	const { set } = world;
	const now = deps.now ?? Date.now;
	const randomBytes = deps.randomBytes ?? (deps.draws ? deps.draws.next.bind(deps.draws) : nodeRandomBytes);
	const newOpId = deps.newOpId ?? (() => `op-${randomBytes(6).toString("hex")}`);
	const key = world.contentKey;
	const aad = (kind: ContentAad["kind"], epoch = set.content.epoch): ContentAad => ({
		domainId: set.domain.id,
		ownerSignPub: set.domain.owner.sign.pub,
		epoch,
		kind,
	});

	function ownerOp(op: Record<string, unknown>, opId = newOpId()): OwnerOp {
		const fields: OwnerOpFields = {
			v: 1,
			domainId: set.domain.id,
			signerSignPub: set.console.identity.sign.pub,
			conversationId: set.console.conversationId,
			device: set.console.device,
			opId,
			at: now(),
			nonce: randomBytes(18).toString("base64"),
			op,
		};
		return signOwnerOp(fields, set.console.identity.sign.priv);
	}

	async function consolePost(body: Record<string, unknown>): Promise<PostAnswer> {
		const response = await deps.handle(
			new Request("https://router.test/console", {
				method: "POST",
				headers: { [APP_TOKEN_HEADER]: `Bearer ${set.tokens.console}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const text = await response.text();
		let answer: unknown = text;
		try {
			answer = JSON.parse(text);
		} catch {}
		return { status: response.status, body: answer };
	}

	const post = (op: OwnerOp): Promise<PostAnswer> => consolePost({ ownerOp: op });

	async function enroll(op: EnrollOp): Promise<EnrollResult & Record<string, unknown>> {
		const body = (await consolePost({ enrollOp: op })).body as Record<string, unknown>;
		return { ...body, ...EnrollResultSchema.parse(body) };
	}

	async function reach(): Promise<ReachAnswer> {
		const headers = { [APP_TOKEN_HEADER]: `Bearer ${set.tokens.console}`, "content-type": "application/json" };
		const reachResponse = await deps.handle(
			new Request("https://router.test/console", {
				method: "POST",
				headers,
				body: JSON.stringify({ reach: { signerSignPub: set.console.identity.sign.pub } }),
			}),
		);
		if (!reachResponse.ok) throw new Error(`reach answered ${reachResponse.status}`);
		const gatewaysResponse = await deps.handle(
			new Request("https://router.test/console", {
				method: "POST",
				headers,
				body: JSON.stringify({ gateways: {} }),
			}),
		);
		if (!gatewaysResponse.ok) throw new Error(`gateways answered ${gatewaysResponse.status}`);
		return { ...(await reachResponse.json()), ...(await gatewaysResponse.json()) } as ReachAnswer;
	}

	async function send(op: Record<string, unknown>, opId?: string): Promise<unknown> {
		const answer = await post(ownerOp(op, opId));
		if (answer.status !== 200)
			throw new Error(`owner op ${String(op.kind)} answered ${answer.status}: ${String(answer.body)}`);
		return answer.body;
	}

	const seal = (plaintext: string, kind: ContentAad["kind"]): ContentEnvelope =>
		sealContent(Buffer.from(plaintext, "utf8"), key, aad(kind));
	const openText = (envelope: ContentEnvelope, kind: ContentAad["kind"]): string =>
		openContent(envelope, key, aad(kind, envelope.epoch)).toString("utf8");

	async function value(consoleOp: ConsoleOp, opId = newOpId()): Promise<ValueAnswer> {
		// Value answers may be clear refusals, not result envelopes.
		const body = await send(
			{
				kind: "gateway_value",
				gatewayId: set.gateway.id,
				value: seal(JSON.stringify(consoleOp), opPayloadAadKind()),
			},
			opId,
		);
		const envelope = OpResultEnvelopeSchema.parse(body);
		const sealed = ContentEnvelopeSchema.safeParse(envelope.result);
		if (!sealed.success) return { envelope, result: envelope.result };
		const plaintext = openContent(sealed.data, key, aad(valueResultAadKind(opId), sealed.data.epoch));
		return { envelope, result: JSON.parse(plaintext.toString("utf8")) };
	}

	async function deliver(sessionId: string, consoleOp: ConsoleOp, opId = newOpId()): Promise<OpResultEnvelope> {
		const envelope = {
			origin: { kind: "console" as const, domainId: set.domain.id, device: set.console.device },
			opKey: { conversationId: set.console.conversationId, opId },
			epoch: set.content.epoch,
			kind: "console_op" as const,
			contentRefs: [],
		};
		const row = {
			envelope,
			producerSig: signRowEnvelope(envelope, set.console.identity.sign.priv),
			body: seal(JSON.stringify(consoleOp), opPayloadAadKind()),
		};
		const address = formatInboxAddress({
			kind: "session",
			domainId: set.domain.id,
			gatewayId: set.gateway.id,
			sessionId,
		});
		return OpResultEnvelopeSchema.parse(await send({ kind: "deliver", address, row }, opId));
	}

	let consumer: { cursor: number; cursorEpoch: number } | null = null;
	async function consumerRegister(): Promise<{ cursor: number; cursorEpoch: number }> {
		const body = (await send({ kind: "consumer_register", incarnation: 0 })) as {
			cursor: number;
			cursorEpoch: number;
		};
		consumer = { cursor: Number(body.cursor), cursorEpoch: Number(body.cursorEpoch) };
		return consumer;
	}

	async function inboxRead(fromSeq = 1, limit = 100): Promise<InboxRow[]> {
		const { cursorEpoch } = consumer ?? (await consumerRegister());
		const body = await send({ kind: "inbox_read", fromSeq, limit, cursorEpoch });
		if (!Array.isArray(body)) throw new Error(`inbox_read answered ${JSON.stringify(body)}`);
		return body.map((row) => InboxRowSchema.parse(row));
	}

	function open(row: InboxRow): unknown {
		if (typeof row.envelope.epoch !== "number") return row.body;
		const { conversationId, opId } = row.envelope.opKey;
		const kind =
			row.envelope.kind === "op_result"
				? opResultAadKind(conversationId, opId)
				: inboxBodyAadKind(conversationId, opId);
		const plaintext = openContent(ContentEnvelopeSchema.parse(row.body), key, aad(kind, row.envelope.epoch));
		return JSON.parse(plaintext.toString("utf8"));
	}

	return {
		ownerOp,
		post,
		console: consolePost,
		enroll,
		reach,
		send,
		value,
		deliver,
		consumerRegister,
		inboxRead,
		inboxAdvance: async (cursor) => {
			const { cursorEpoch } = consumer ?? (await consumerRegister());
			return send({ kind: "inbox_advance", cursor, cursorEpoch });
		},
		planesRead: async (known = {}) => {
			const envelope = OpResultEnvelopeSchema.parse(await send({ kind: "planes_read", known }));
			return envelope.result as { planes: Array<{ name: string; version: number; payload?: unknown }> };
		},
		seal,
		openText,
		open,
		boardRead: async () => BoardReadResultSchema.parse(await send({ kind: "board_read" })),
		entries: (rows) =>
			rows.filter((row) => ENTRY_KINDS.has(row.envelope.kind)).map((row) => MailboxEntrySchema.parse(open(row))),
	};
}
