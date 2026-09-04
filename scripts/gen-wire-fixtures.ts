import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConsolePushOps } from "../src/gateway/consolePushOps.js";
import { ContentKeyStore } from "../src/gateway/federation/contentKeyStore.js";
import { createBoardClient } from "../src/gateway/router/boardClient.js";
import { createKeyRequester } from "../src/gateway/router/keyRequester.js";
import { createPresenceReporter } from "../src/gateway/router/presenceReporter.js";
import { buildRegisterAuth, registerFrame } from "../src/gateway/router/registerAuth.js";
import { createSessionRegistryReporter } from "../src/gateway/router/sessionRegistryReporter.js";
import { composeValueResult } from "../src/gateway/router/valueResult.js";
import { rankBetween } from "../src/shared/board-rank.js";
import type { ConsolePushEntry } from "../src/shared/federation-protocol.js";
import type { PresenceRow } from "../src/shared/presence-identity.js";
import { type WireFixture, WireFixtureSchema, WireManifestSchema } from "../src/shared/schemasWireFixture.js";
import { Address, parseSessionName } from "../src/shared/session-id.js";
import { SessionStore } from "../src/shared/session-store.js";
import { contentKeyOf, loadIdentitySet } from "../src/testing/identitySet.js";

const set = loadIdentitySet();
const root = process.env.WIRE_FIXTURE_DIR ?? path.resolve(import.meta.dirname, "../tests/fixtures/wire/ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-fixtures-"));
const keyStoreDir = path.join(temp, "federation");
fs.mkdirSync(keyStoreDir, { recursive: true });
ContentKeyStore.writeFile(
	path.join(keyStoreDir, "content-keys.json"),
	new Map([[set.content.epoch, contentKeyOf(set)]]),
);

const cases: WireFixture[] = [];
const context = (composer: string, name: string) => {
	let n = 0;
	const inputs: Record<string, unknown> = { draws: {} };
	const randomBytes = (size: number): Buffer => {
		const bytes = createHash("sha256").update(`ts:${composer}:${name}:${n}`).digest().subarray(0, size);
		const label = size === 18 ? "nonce" : size === 12 ? `contentNonce${n}` : `random${n}`;
		(inputs.draws as Record<string, string>)[label] = bytes.toString("base64");
		n += 1;
		return bytes;
	};
	return { inputs, randomBytes, newId: () => randomBytes(16).toString("hex") };
};
const write = (
	composer: string,
	name: string,
	inputs: Record<string, unknown>,
	frame: Record<string, unknown>,
	expect: Record<string, unknown>,
	phone?: Record<string, unknown>,
) => {
	const value = WireFixtureSchema.parse({
		producer: "ts",
		composer,
		case: name,
		clock: set.issuedAt,
		inputs,
		frame,
		...(phone ? { phone } : {}),
		expect,
	});
	const dir = path.join(root, composer);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(value, null, "\t")}\n`);
	cases.push(value);
};

const keyFrames: Record<string, unknown>[] = [];
const keyRequestContext = context("gateway/router/keyRequester", "key-request");
const requester = createKeyRequester({
	domainId: set.domain.id,
	gatewayId: set.gateway.id,
	gatewaySignPub: set.gateway.identity.sign.pub,
	gatewaySignPriv: set.gateway.identity.sign.priv,
	now: () => set.issuedAt,
	randomBytes: keyRequestContext.randomBytes,
	setTimeout: (handler) => {
		handler();
		return 0;
	},
	clearTimeout: () => undefined,
	onError: () => undefined,
	send: async (action, params) => {
		keyFrames.push({ name: action, params });
		return { result: { ok: true } };
	},
});
requester.request(1);
await Promise.resolve();
await Promise.resolve();
if (keyFrames[0])
	write(
		"gateway/router/keyRequester",
		"key-request",
		keyRequestContext.inputs,
		keyFrames[0] as Record<string, unknown>,
		{ outcome: "accepted" },
	);
const keyReceiptContext = context("gateway/router/keyRequester", "key-receipt");
const receiptRequester = createKeyRequester({
	domainId: set.domain.id,
	gatewayId: set.gateway.id,
	gatewaySignPub: set.gateway.identity.sign.pub,
	gatewaySignPriv: set.gateway.identity.sign.priv,
	now: () => set.issuedAt,
	randomBytes: keyReceiptContext.randomBytes,
	onError: () => undefined,
	send: async (action, params) => {
		keyFrames.push({ name: action, params });
		return { result: { ok: true } };
	},
});
await receiptRequester.sendReceipt(1);
if (keyFrames[1])
	write(
		"gateway/router/keyRequester",
		"key-receipt",
		keyReceiptContext.inputs,
		keyFrames[1] as Record<string, unknown>,
		{ outcome: "accepted" },
	);
requester.stop();
receiptRequester.stop();

const authContext = context("gateway/router/registerAuth", "gateway-register");
const auth = buildRegisterAuth({
	gatewayId: set.gateway.id,
	identity: set.gateway.identity,
	selfAdmission: () => set.gateway.admission,
	now: () => set.issuedAt,
	randomBytes: authContext.randomBytes,
});
write(
	"gateway/router/registerAuth",
	"gateway-register",
	{ ...authContext.inputs, gatewayId: set.gateway.id, domainId: set.domain.id },
	{ name: "gateway_register", params: registerFrame({ gatewayId: set.gateway.id, domainId: set.domain.id }, auth) },
	{ ok: true },
);

const keys = new ContentKeyStore(
	keyStoreDir,
	set.gateway.identity.box.priv,
	context("gateway/router/valueResult", "list-dirs").randomBytes,
);
const valueResult = composeValueResult({
	opId: "list-dirs-op",
	conversationId: set.console.conversationId,
	incarnation: 1,
	outcome: { kind: "ok", result: { entries: ["projects"], path: "/home/fixture" } },
	seal: (plaintext, aad) => {
		const sealed = keys.seal(plaintext, {
			domainId: set.domain.id,
			ownerSignPub: set.domain.owner.sign.pub,
			kind: aad.kind,
		});
		return sealed.kind === "ok" ? sealed : null;
	},
});
write(
	"gateway/router/valueResult",
	"list-dirs",
	{ opId: "list-dirs-op", result: { entries: ["projects"], path: "/home/fixture" } },
	{ name: "value_result", params: valueResult },
	{ settled: false, reason: "no_waiter" },
	{ decodeAs: "ContentEnvelope", open: { as: "ConsoleListDirsResult", aadKind: `op.result\nlist-dirs-op` } },
);
write(
	"gateway/router/valueResult",
	"refusal",
	{ opId: "refusal-op", reason: "denied" },
	{
		name: "value_result",
		params: composeValueResult({
			opId: "refusal-op",
			conversationId: set.console.conversationId,
			incarnation: 1,
			outcome: { kind: "refusal", reason: "denied" },
			seal: () => null,
		}),
	},
	{ settled: false, reason: "no_waiter" },
);

const ownerContext = context("gateway/consolePushOps", "owner-rows");
const ownerFrames: Record<string, unknown>[] = [];
const ownerPush = createConsolePushOps({
	dataDir: path.join(temp, "owner-outbox"),
	ownerId: () => "owner",
	routerClient: {
		isConnected: () => true,
		isRegistered: () => true,
		callInboxTool: async (name, params) => {
			ownerFrames.push({ name, params });
			const { opKey } = (params.row as { envelope: { opKey: Record<string, string> } }).envelope;
			return { callId: name, result: { opKey, outcome: "accepted", seq: ownerFrames.length } };
		},
	},
	localGatewayId: set.gateway.id,
	localDomainId: set.domain.id,
	producerSignPriv: set.gateway.identity.sign.priv,
	ownerSignPub: () => set.domain.owner.sign.pub,
	contentKeyStore: new ContentKeyStore(keyStoreDir, set.gateway.identity.box.priv, ownerContext.randomBytes),
	localAddress: (name) => {
		const { project, session } = parseSessionName(name);
		return Address.local(set.domain.id, set.gateway.id, project, session);
	},
	refuseImpersonation: () => null,
	now: () => set.issuedAt,
	newId: ownerContext.newId,
});
const ownerEntries: ConsolePushEntry[] = [
	{ kind: "message", session_id: "fixture-session", from: "agent", body: "Wire message" },
	{
		kind: "reply",
		session_id: "fixture-session",
		from: "agent",
		body: "Wire reply",
		files: [{ filename: "note.txt", mime: "text/plain", size: 4, descriptiveKey: "note", role: "attachment" }],
	},
];
for (const entry of ownerEntries) ownerPush.deliverToOwner({ entry, dedupeKey: `owner-${entry.kind}` });
// Drains overlap; wait for both.
for (let attempt = 0; ownerFrames.length < 2 && attempt < 20; attempt++) {
	await new Promise((resolve) => setImmediate(resolve));
	await ownerPush.drainOutbox();
}
if (ownerFrames.length !== 2) throw new Error(`owner rows sent: ${ownerFrames.length}, expected 2`);
for (const [index, frame] of ownerFrames.entries()) {
	const params = frame.params as { row: { envelope: { opKey: { opId: string; conversationId: string } } } };
	write(
		"gateway/consolePushOps",
		index === 0 ? "message" : "reply",
		{
			...ownerContext.inputs,
			entry: ownerEntries[index],
			opId: params.row.envelope.opKey.opId,
			conversationId: params.row.envelope.opKey.conversationId,
		},
		frame,
		{ outcome: "accepted" },
		{
			// Router stamps seq, acceptedAt, size.
			decodeAs: "RowEnvelope",
			open: {
				as: "MailboxEntry",
				aadKind: `inbox.body\n${params.row.envelope.opKey.conversationId}\n${params.row.envelope.opKey.opId}`,
			},
		},
	);
}
ownerPush.stop();

const presenceRows: PresenceRow[] = [
	{
		team: "alpha",
		gatewayId: set.gateway.id,
		domainId: set.domain.id,
		status: "online",
		kind: "console",
		queue_depth: 0,
	},
	{
		team: "beta",
		gatewayId: set.gateway.id,
		domainId: set.domain.id,
		status: "available",
		kind: "console",
		queue_depth: 0,
	},
];
const presenceFrames: Record<string, unknown>[] = [];
const presence = createPresenceReporter({
	rows: () => presenceRows,
	spawnPoints: () => ({ gatewayId: set.gateway.id, domainId: set.domain.id, hostSpawns: [] }),
	incarnation: () => 1,
	debounceMs: 0,
	now: () => set.issuedAt,
	send: async (name: string, params: Record<string, unknown>) => {
		presenceFrames.push({ name, params });
		return { result: { ok: true } };
	},
});
await presence.baseline();
presenceRows[0] = { ...presenceRows[0], status: "available" };
presenceRows.pop();
presence.markDirty();
await new Promise((resolve) => setTimeout(resolve, 0));
for (const frame of presenceFrames)
	write("gateway/router/presenceReporter", frame.name === "presence_baseline" ? "baseline" : "delta", {}, frame, {
		ok: true,
	});
presence.stop();

const sessionFrames: Record<string, unknown>[] = [];
const sessionStore = new SessionStore({ now: () => set.issuedAt, idGen: () => "fixture" });
const sessionReporter = createSessionRegistryReporter({
	sessionStore,
	localGatewayId: set.gateway.id,
	incarnation: () => 1,
	send: async (name, params) => {
		sessionFrames.push({ name, params });
		return { result: { ok: true } };
	},
});
sessionReporter.attach();
const sessionId = sessionStore.teamOf(sessionStore.mint({ spawn: "fixture-app", sessionLabel: "Fixture" }));
const sessionFrame = (index: number): Record<string, unknown> => {
	const frame = sessionFrames[index];
	if (!frame) throw new Error(`session frame ${index} never sent`);
	return frame;
};
await Promise.resolve();
write("gateway/router/sessionRegistryReporter", "upsert", { sessionId }, sessionFrame(0), { ok: true });

// The write needs the live session.
const boardContext = context("gateway/router/boardClient", "upsert");
const boardFrames: Record<string, unknown>[] = [];
const board = createBoardClient({
	domainId: set.domain.id,
	gatewayId: set.gateway.id,
	ownerSignPub: () => set.domain.owner.sign.pub,
	keys: new ContentKeyStore(keyStoreDir, set.gateway.identity.box.priv, boardContext.randomBytes),
	call: async (name, params) => {
		boardFrames.push({ name, params });
		if (name === "board_read") return { result: { revision: 0, entries: [] } };
		return { result: { outcome: "applied", revision: 1, entries: [], cascaded: [] } };
	},
});
await board.mutate(
	sessionId,
	() => [
		{
			kind: "upsert",
			id: "t-fixture",
			title: "Wire the phone",
			body: "Sealed body",
			rank: rankBetween(undefined, undefined),
		},
	],
	"board-op",
);
const boardFrame = boardFrames.find((frame) => frame.name === "board_op");
if (boardFrame)
	write(
		"gateway/router/boardClient",
		"upsert",
		{ ...boardContext.inputs, id: "t-fixture", opId: "board-op", title: "Wire the phone", body: "Sealed body" },
		boardFrame,
		{ outcome: "applied" },
		{ decodeAs: "BoardOp", open: { title: "board.title\nt-fixture", body: "board.body\nt-fixture" } },
	);

sessionStore.forget(sessionId);
await Promise.resolve();
write("gateway/router/sessionRegistryReporter", "forget", { sessionId }, sessionFrame(1), { ok: true });
sessionReporter.detach();

const manifest = WireManifestSchema.parse({
	_comment: "Generated TS wire fixtures.",
	fixtures: cases.map((fixture) => ({
		file: `${fixture.composer}/${fixture.case}.json`,
		composer: fixture.composer,
		case: fixture.case,
		peer: fixture.producer === "ts" && fixture.phone ? "phone" : "router",
	})),
});
fs.writeFileSync(path.join(root, "_manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
const formatted = Bun.spawnSync(["bunx", "biome", "format", "--write", root]);
fs.rmSync(temp, { recursive: true, force: true });
if (formatted.exitCode !== 0) throw new Error("fixture formatting failed");
