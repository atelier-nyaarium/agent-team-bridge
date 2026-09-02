import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConsoleSocket, createConsoleSockets } from "../federation-server/console/consoleSockets.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { signOwnerOp } from "../shared/schemasInbox.js";

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
	let owner = generateIdentity();
	while (owner.sign.pub.includes("/")) owner = generateIdentity();
	const consoleIdentity = generateIdentity();
	const router = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: () => owner.sign.pub,
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: () => 100,
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
	const intake = new OwnerOpIntake({
		inbox,
		getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] }),
		push: () => true,
		now: () => 100,
	});
	intake.register("hello", (op) => ({
		hello: { domainId: op.domainId, signerSignPub: op.signerSignPub },
	}));
	const hub = createConsoleSockets({
		handleOwnerOp: (raw) => intake.handle(raw),
		registerConsumer: inbox.registerConsumer.bind(inbox),
		readOwner: inbox.readOwner.bind(inbox),
		advanceCursor: inbox.advanceCursor.bind(inbox),
		ownerFloor: inbox.ownerFloor.bind(inbox),
		planeVersions: () => ({ board: 4 }),
	});
	return { consoleIdentity, inbox, hub, owner, registry };
}

function hello(fixture: ReturnType<typeof setup>, domainId = domainA, nonce = `hello-${Math.random()}`) {
	return signOwnerOp(
		{
			v: 1,
			domainId,
			signerSignPub: fixture.consoleIdentity.sign.pub,
			conversationId: "console",
			device: "phone",
			opId: nonce,
			at: 100,
			nonce: Buffer.from(nonce).toString("base64"),
			op: { kind: "hello" },
		},
		fixture.consoleIdentity.sign.priv,
	);
}

function row(fixture: ReturnType<typeof setup>, domainId = domainA, opId = `row-${Math.random()}`) {
	return fixture.inbox.appendRouterRow({
		address: { kind: "owner", domainId, ownerSignPub: fixture.owner.sign.pub },
		kind: "op_result",
		opKey: { conversationId: "router", opId },
		body: { outcome: "accepted" },
	}).row as NonNullable<ReturnType<typeof fixture.inbox.appendRouterRow>["row"]>;
}

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("console sockets", () => {
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
			cursorEpoch: 1,
			floor: 1,
			versions: { board: 4 },
		});
		expect(client.frames[1]).toMatchObject({ type: "inbox_rows", cursor: 2, rows: waiting });
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

		// readOwner is inclusive of fromSeq, so "after the acked row" reads from one above it.
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
		// The late ack changed nothing, so the row is still above the cursor and still unread.
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
