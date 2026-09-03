import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConsoleSocket, createConsoleSockets } from "../federation-server/console/consoleSockets.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { signAdmission, signRevocation } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { signOwnerOp, signRowEnvelope } from "../shared/schemasInbox.js";

const domainA = "domain-a";
const domainB = "domain-b";
const roots: string[] = [];

type FakeSocket = ConsoleSocket & { frames: Array<Record<string, unknown>>; closeCount: number };

function socket(): FakeSocket {
	return {
		frames: [],
		closeCount: 0,
		send(data) {
			this.frames.push(JSON.parse(data) as Record<string, unknown>);
		},
		close() {
			this.closeCount++;
		},
	};
}

function setup() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-sockets-"));
	roots.push(dataDir);
	let now = Date.now();
	let owner = generateIdentity();
	while (owner.sign.pub.includes("/")) owner = generateIdentity();
	const consoleIdentity = generateIdentity();
	const secondConsoleIdentity = generateIdentity();
	const router = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: () => owner.sign.pub,
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: () => now,
	});
	const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
	const admission = signAdmission(
		{
			kind: "console",
			signPub: consoleIdentity.sign.pub,
			boxPub: consoleIdentity.box.pub,
			issuedAt: 1,
			nonce: "admission",
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	let admitted = [admission];
	let revocations: ReturnType<typeof signRevocation>[] = [];
	const intake = new OwnerOpIntake({
		inbox,
		getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: admitted, revocations }),
		push: () => true,
		now: () => now,
	});
	intake.register("hello", (op) => ({
		hello: { domainId: op.domainId, signerSignPub: op.signerSignPub },
	}));
	const hub = createConsoleSockets({
		handleOwnerOp: (raw) => intake.handle(raw),
		registerConsumer: inbox.registerConsumer.bind(inbox),
		readOwner: inbox.readOwner.bind(inbox),
		readOwnerKeyRows: inbox.readOwnerKeyRows.bind(inbox),
		advanceCursor: inbox.advanceCursor.bind(inbox),
		ownerFloor: inbox.ownerFloor.bind(inbox),
		planeVersions: () => ({ board: 4 }),
		now: () => now,
		admittedConsoleSigners: () => admitted.map((item) => item.admission.signPub),
	});
	return {
		consoleIdentity,
		secondConsoleIdentity,
		inbox,
		hub,
		owner,
		router,
		admission,
		setAdmitted: (next: typeof admitted) => (admitted = next),
		setRevocations: (next: typeof revocations) => (revocations = next),
		registry,
		setNow: (value: number) => (now = value),
	};
}

function helloAs(
	fixture: ReturnType<typeof setup>,
	identity: ReturnType<typeof generateIdentity>,
	domainId = domainA,
	nonce = `hello-${Math.random()}`,
) {
	return signOwnerOp(
		{
			v: 1,
			domainId,
			signerSignPub: identity.sign.pub,
			conversationId: "console",
			device: "phone",
			opId: nonce,
			at: fixture.registry.now(),
			nonce: Buffer.from(nonce).toString("base64"),
			op: { kind: "hello" },
		},
		identity.sign.priv,
	);
}

function hello(fixture: ReturnType<typeof setup>, domainId = domainA, nonce = `hello-${Math.random()}`) {
	return helloAs(fixture, fixture.consoleIdentity, domainId, nonce);
}

function row(fixture: ReturnType<typeof setup>, domainId = domainA, opId = `row-${Math.random()}`) {
	return fixture.inbox.appendRouterRow({
		address: { kind: "owner", domainId, ownerSignPub: fixture.owner.sign.pub },
		kind: "op_result",
		opKey: { conversationId: "router", opId },
		body: { outcome: "accepted" },
	}).row as NonNullable<ReturnType<typeof fixture.inbox.appendRouterRow>["row"]>;
}

function keyRow(
	fixture: ReturnType<typeof setup>,
	kind: "key_request" | "key_grant",
	domainId = domainA,
	opId = `key-${Math.random()}`,
) {
	const address = { kind: "owner" as const, domainId, ownerSignPub: fixture.owner.sign.pub };
	const envelope = {
		origin: { kind: "router" as const, domainId },
		opKey: { conversationId: "router", opId },
		epoch: "clear" as const,
		kind,
		contentRefs: [],
	};
	return fixture.inbox.appendRow({
		address,
		row: { envelope, producerSig: signRowEnvelope(envelope, fixture.router.sign.priv), body: { kind } },
		producerSignPub: fixture.router.sign.pub,
	}).row as NonNullable<ReturnType<typeof fixture.inbox.appendRouterRow>["row"]>;
}

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("console sockets", () => {
	it("keeps a bound socket open when an owner read is uncertain", async () => {
		const fixture = setup();
		const client = socket();
		const hub = createConsoleSockets({
			handleOwnerOp: async () => ({ hello: { domainId: domainA, signerSignPub: "console" } }),
			registerConsumer: () => ({ cursor: 0, cursorEpoch: 1 }),
			readOwner: () => ({ outcome: "durability_uncertain" as const }),
			readOwnerKeyRows: () => [],
			advanceCursor: () => ({ outcome: "ok" as const }),
			ownerFloor: () => 1,
		});
		hub.open(client);
		await hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture) }));
		expect(client.frames.at(-1)).toEqual({ type: "refused", reason: "durability_uncertain" });
		expect(client.closeCount).toBe(0);
		expect(hub.boundCount).toBe(1);
	});
	it("closes a silent socket after the hello deadline", () => {
		vi.useFakeTimers();
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);

		vi.advanceTimersByTime(10_000);

		expect(client.frames).toContainEqual({ type: "refused", reason: "no_hello" });
		expect(client.closeCount).toBe(1);
		fixture.registry.close();
	});

	it("refuses a tampered hello without registering a consumer", async () => {
		const fixture = setup();
		const client = socket();
		const op = hello(fixture);
		op.op = { kind: "hello", changed: true };
		fixture.hub.open(client);

		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: op }));

		expect(client.frames).toContainEqual({ type: "refused", reason: "not admitted" });
		expect(fixture.inbox.readOwner(domainA, fixture.consoleIdentity.sign.pub, 0, 10)).toMatchObject({
			outcome: "cursor_stale",
		});
		expect(fixture.hub.boundCount).toBe(0);
		fixture.registry.close();
	});

	it("welcomes an offline phone and drains waiting rows", async () => {
		const fixture = setup();
		const waiting = [row(fixture, domainA, "one"), row(fixture, domainA, "two")];
		const client = socket();
		fixture.hub.open(client);

		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture) }));

		expect(client.frames[0]).toMatchObject({
			type: "welcome",
			cursor: 0,
			floor: 1,
			versions: { board: 4 },
		});
		const welcome = client.frames[0] as { cursorEpoch: number };
		const consumer = fixture.registry.for(domainA).get("consumer", `consumer:${fixture.consoleIdentity.sign.pub}`);
		expect(Number.isInteger(welcome.cursorEpoch)).toBe(true);
		expect(welcome.cursorEpoch).toBeGreaterThan(0);
		expect(welcome.cursorEpoch).toBe(consumer?.clear.cursorEpoch);
		expect(client.frames[1]).toMatchObject({ type: "inbox_rows", cursor: 2, rows: waiting });
		fixture.registry.close();
	});

	it("drops incarnation rows for revoked console signers", async () => {
		const fixture = setup();
		const first = socket();
		fixture.hub.open(first);
		await fixture.hub.message(first, JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "a") }));

		const secondAdmission = signAdmission(
			{
				kind: "console",
				signPub: fixture.secondConsoleIdentity.sign.pub,
				boxPub: fixture.secondConsoleIdentity.box.pub,
				issuedAt: 2,
				nonce: "admission-b",
			},
			fixture.owner.sign.priv,
			fixture.owner.sign.pub,
		);
		fixture.setAdmitted([secondAdmission]);
		fixture.setRevocations([
			signRevocation(
				{ signPub: fixture.consoleIdentity.sign.pub, issuedAt: 2, nonce: "revoke-a" },
				fixture.owner.sign.priv,
				fixture.owner.sign.pub,
			),
		]);
		const second = socket();
		fixture.hub.open(second);
		await fixture.hub.message(
			second,
			JSON.stringify({ type: "hello", ownerOp: helloAs(fixture, fixture.secondConsoleIdentity, domainA, "b") }),
		);

		fixture.setAdmitted([fixture.admission]);
		fixture.setRevocations([]);
		const restored = socket();
		fixture.hub.open(restored);
		await fixture.hub.message(
			restored,
			JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "a-again") }),
		);

		expect((restored.frames[0] as { incarnation: number }).incarnation).toBe(1);
		fixture.registry.close();
	});

	// Avoid pinning compaction floor.
	it("gives a planes-only console no rows and no consumer", async () => {
		const fixture = setup();
		row(fixture, domainA, "waiting");
		const client = socket();
		fixture.hub.open(client);

		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture), mode: "planes" }));

		expect(client.frames[0]).toMatchObject({ type: "welcome" });
		expect(client.frames.some((frame) => frame.type === "inbox_rows")).toBe(false);
		fixture.hub.pushOwnerRow(domainA, null, row(fixture, domainA, "pushed"));
		expect(client.frames.some((frame) => frame.type === "inbox_rows")).toBe(false);
		fixture.hub.pushPlane(domainA, "presence", 3, { rows: [] });
		expect(client.frames.at(-1)).toMatchObject({ type: "plane", name: "presence", version: 3 });
		fixture.registry.close();
	});

	it("pushes key rows to planes-only consoles but skips message rows", async () => {
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);
		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture), mode: "planes" }));
		const key = keyRow(fixture, "key_grant", domainA, "pushed-key");
		const message = row(fixture, domainA, "pushed-message");

		fixture.hub.pushOwnerRow(domainA, null, key);
		fixture.hub.pushOwnerRow(domainA, null, message);

		expect(client.frames.at(-1)).toMatchObject({ type: "inbox_rows", rows: [key] });
		expect(client.frames.filter((frame) => frame.type === "inbox_rows")).toHaveLength(1);
		fixture.registry.close();
	});

	it("replays only recent key rows to planes-only consoles", async () => {
		const fixture = setup();
		const now = fixture.registry.now();
		fixture.setNow(now - 60 * 60 * 1000);
		const recent = keyRow(fixture, "key_request", domainA, "recent-key");
		fixture.setNow(now - 2 * 24 * 60 * 60 * 1000);
		keyRow(fixture, "key_grant", domainA, "old-key");
		row(fixture, domainA, "old-message");
		fixture.setNow(now);
		const client = socket();
		fixture.hub.open(client);

		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture), mode: "planes" }));

		expect(client.frames.filter((frame) => frame.type === "inbox_rows")).toHaveLength(1);
		expect(client.frames.at(-1)).toMatchObject({ type: "inbox_rows", rows: [recent] });
	});

	it("refuses an ack from a console that holds no cursor", async () => {
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);
		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture), mode: "planes" }));
		const incarnation = (client.frames[0] as { incarnation: number }).incarnation;

		await fixture.hub.message(client, JSON.stringify({ type: "ack", incarnation, cursor: 1, cursorEpoch: 1 }));

		expect(client.frames.at(-1)).toMatchObject({ type: "refused", reason: "planes_only" });
		fixture.registry.close();
	});

	it("advances the durable cursor before the next drain", async () => {
		const fixture = setup();
		const first = row(fixture, domainA, "first");
		const client = socket();
		fixture.hub.open(client);
		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture) }));
		const welcome = client.frames[0] as { incarnation: number; cursorEpoch: number };
		const next = row(fixture, domainA, "next");

		await fixture.hub.message(
			client,
			JSON.stringify({
				type: "ack",
				incarnation: welcome.incarnation,
				cursor: first.seq,
				cursorEpoch: welcome.cursorEpoch,
			}),
		);

		expect(
			fixture.inbox.readOwner(
				domainA,
				fixture.consoleIdentity.sign.pub,
				(first.seq as number) + 1,
				10,
				welcome.cursorEpoch,
			),
		).toEqual([next]);
		expect(client.frames.at(-1)).toMatchObject({ type: "inbox_rows", rows: [next] });
		fixture.registry.close();
	});

	it("refuses an ack below the compaction floor with gap details", async () => {
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);
		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture) }));
		const welcome = client.frames[0] as { incarnation: number; cursorEpoch: number };
		const pending = row(fixture, domainA, "compact");
		fixture.inbox.advanceCursor(
			domainA,
			fixture.consoleIdentity.sign.pub,
			pending.seq as number,
			welcome.cursorEpoch,
		);
		fixture.inbox.compactOwnerInbox(domainA);

		await fixture.hub.message(
			client,
			JSON.stringify({
				type: "ack",
				incarnation: welcome.incarnation,
				cursor: 0,
				cursorEpoch: welcome.cursorEpoch,
			}),
		);

		expect(client.frames.at(-1)).toEqual({ type: "refused", reason: "cursor_stale", floor: 2, dropped: 2 });
		expect(client.closeCount).toBe(1);
		fixture.registry.close();
	});

	it("retires the older socket and ignores its late ack", async () => {
		const fixture = setup();
		const oldClient = socket();
		const newClient = socket();
		fixture.hub.open(oldClient);
		await fixture.hub.message(
			oldClient,
			JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "old") }),
		);
		const oldWelcome = oldClient.frames[0] as { incarnation: number; cursorEpoch: number };
		const pending = row(fixture, domainA, "fenced");
		fixture.hub.open(newClient);
		await fixture.hub.message(
			newClient,
			JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "new") }),
		);

		await fixture.hub.message(
			oldClient,
			JSON.stringify({
				type: "ack",
				incarnation: oldWelcome.incarnation,
				cursor: pending.seq,
				cursorEpoch: oldWelcome.cursorEpoch,
			}),
		);

		expect(oldClient.frames.at(-1)).toEqual({ type: "refused", reason: "superseded" });
		expect(
			fixture.inbox.readOwner(domainA, fixture.consoleIdentity.sign.pub, 1, 10, oldWelcome.cursorEpoch),
		).toEqual([pending]);
		fixture.registry.close();
	});

	it("refuses a second hello on a bound socket", async () => {
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);
		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "first") }));
		await fixture.hub.message(
			client,
			JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "second") }),
		);

		expect(client.frames.at(-1)).toEqual({ type: "refused", reason: "already_bound" });
		expect(client.closeCount).toBe(1);
		expect(fixture.hub.boundCount).toBe(0);
		fixture.registry.close();
	});

	it("pushes owner rows and planes only within their Domain", async () => {
		const fixture = setup();
		const a = socket();
		const b = socket();
		fixture.hub.open(a);
		fixture.hub.open(b);
		await fixture.hub.message(a, JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainA, "a") }));
		await fixture.hub.message(b, JSON.stringify({ type: "hello", ownerOp: hello(fixture, domainB, "b") }));
		const pushed = row(fixture, domainA, "push");

		fixture.hub.pushOwnerRow(domainA, null, pushed);
		fixture.hub.pushPlane(domainA, "board", 5, { changed: true });

		expect(a.frames.at(-2)).toMatchObject({ type: "inbox_rows", rows: [pushed] });
		expect(a.frames.at(-1)).toMatchObject({ type: "plane", name: "board", version: 5 });
		expect(b.frames).not.toContainEqual(expect.objectContaining({ type: "plane" }));
		expect(b.frames).not.toContainEqual(expect.objectContaining({ type: "inbox_rows" }));
		fixture.registry.close();
	});

	it("closes a forgotten console", async () => {
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);
		await fixture.hub.message(client, JSON.stringify({ type: "hello", ownerOp: hello(fixture) }));

		fixture.hub.forget(domainA, fixture.consoleIdentity.sign.pub);

		expect(client.frames.at(-1)).toEqual({ type: "refused", reason: "revoked" });
		expect(client.closeCount).toBe(1);
		fixture.registry.close();
	});

	it.each([
		["not JSON", "malformed"],
		[JSON.stringify({ type: "unknown" }), "malformed"],
	])("refuses %s", async (data, reason) => {
		const fixture = setup();
		const client = socket();
		fixture.hub.open(client);

		await fixture.hub.message(client, data);

		expect(client.frames.at(-1)).toEqual({ type: "refused", reason });
		expect(client.closeCount).toBe(1);
		fixture.registry.close();
	});
});
