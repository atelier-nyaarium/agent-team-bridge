import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Allowlist } from "../arbiter/federation/allowlist.js";
import { createPhoneHandler } from "../arbiter/phone/phoneHandler.js";
import { createPhoneSealer } from "../arbiter/phone/phoneSealer.js";
import { createPhoneRelayPump } from "../arbiter/phone/relayPump.js";
import type { ConversationRegistry, TeamRegistry } from "../arbiter/websocket.js";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity, type Identity, type SealedEnvelope, seal, unseal } from "../shared/crypto.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import type { PhoneOp, PhoneOpEnvelope, PhoneRelayReply, PhoneReplyBody } from "../shared/phone-protocol.js";

////////////////////////////////
//  Harness

const dirs: string[] = [];
function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pump-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const owner = generateIdentity();
const arbiter = generateIdentity();

/** An allowlist rooted at the owner that admits `phone` as a kind:phone device. */
function admittedAllowlist(phone: Identity): Allowlist {
	const a = new Allowlist(tmpDir());
	a.setOwner(owner.sign.pub);
	a.addAdmission(
		signAdmission(
			{ kind: "phone", signPub: phone.sign.pub, boxPub: phone.box.pub, issuedAt: 1000, nonce: "AA==" },
			owner.sign.priv,
			owner.sign.pub,
		),
	);
	return a;
}

/** Seal a phone op to the arbiter, exactly as the Android client does. */
function sealFrame(
	phone: Identity,
	op: PhoneOp,
	opts: { opId?: string; conversationId?: string; device?: string; at?: number } = {},
): { type: "phone_relay"; v: number; opId: string; signerSignPub: string; sealed: SealedEnvelope } {
	const env: PhoneOpEnvelope = {
		v: 1,
		conversationId: opts.conversationId ?? "conv-1",
		device: opts.device ?? "pixel",
		at: opts.at ?? Date.now(),
		op,
	};
	const sealed = seal(Buffer.from(JSON.stringify(env)), arbiter.box.pub, phone.sign.priv);
	return { type: "phone_relay", v: 1, opId: opts.opId ?? "op-1", signerSignPub: phone.sign.pub, sealed };
}

function openReply(phone: Identity, reply: PhoneRelayReply): PhoneReplyBody {
	if (!reply.sealed) throw new Error(`reply not sealed: ${reply.error}`);
	return JSON.parse(unseal(reply.sealed, phone.box.priv, arbiter.sign.pub).toString("utf8")) as PhoneReplyBody;
}

function makePump(phone: Identity, replies: PhoneRelayReply[]) {
	const registry: TeamRegistry = new Map();
	const conversationRegistry: ConversationRegistry = new Map();
	const handler = createPhoneHandler({
		registry,
		conversationRegistry,
		mailboxStore: new DeviceMailboxStore(),
		localSwitchId: "test-host",
		routes: {
			send: async () => jsonRes({}),
			respond: () => jsonRes({}),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
		},
	});
	const pump = createPhoneRelayPump({
		sealer: createPhoneSealer(arbiter, admittedAllowlist(phone)),
		handleFrame: handler.handleFrame,
		sendReply: async (reply) => {
			replies.push(reply);
			return {};
		},
	});
	return { pump, registry };
}

////////////////////////////////
//  Tests

describe("createPhoneRelayPump (sealed)", () => {
	it("a sealed frame from an admitted phone opens, runs, and the reply is sealed back", async () => {
		const phone = generateIdentity();
		const replies: PhoneRelayReply[] = [];
		const { pump, registry } = makePump(phone, replies);

		pump(sealFrame(phone, { kind: "register" }, { opId: "op-1" }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].error).toBeUndefined();
		const body = openReply(phone, replies[0]);
		expect(body.ok).toBe(true);
		expect(body.result).toMatchObject({ device: "pixel", cursor: 0 });
		expect(registry.get("pixel")).toBeDefined();
	});

	it("a frame signed by an unadmitted phone is rejected with a cleartext error", async () => {
		const phone = generateIdentity();
		const stranger = generateIdentity();
		const replies: PhoneRelayReply[] = [];
		const { pump } = makePump(phone, replies); // allowlist admits `phone`, not `stranger`

		pump(sealFrame(stranger, { kind: "register" }, { opId: "op-x" }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].sealed).toBeUndefined();
		expect(replies[0].error).toContain("not admitted");
	});

	it("a replayed sealed frame is rejected after the first delivery", async () => {
		const phone = generateIdentity();
		const replies: PhoneRelayReply[] = [];
		const { pump } = makePump(phone, replies);

		const frame = sealFrame(phone, { kind: "register" }, { opId: "op-1" });
		pump(frame);
		await flush();
		pump(frame); // identical bytes (same seal nonce) -> a replay
		await flush();

		expect(replies).toHaveLength(2);
		expect(openReply(phone, replies[0]).ok).toBe(true);
		expect(replies[1].sealed).toBeUndefined();
		expect(replies[1].error).toContain("replayed");
	});

	it("a stale sealed frame (old timestamp) is rejected", async () => {
		const phone = generateIdentity();
		const replies: PhoneRelayReply[] = [];
		const { pump } = makePump(phone, replies);

		pump(sealFrame(phone, { kind: "register" }, { opId: "op-old", at: 1 }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].error).toContain("stale");
	});

	it("an invalid frame with a usable opId gets a cleartext error reply", async () => {
		const phone = generateIdentity();
		const replies: PhoneRelayReply[] = [];
		const { pump } = makePump(phone, replies);

		pump({ type: "phone_relay", opId: "op-bad", op: { kind: "nonsense" } });
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].error).toContain("Invalid relay frame");
		expect(replies[0].sealed).toBeUndefined();
	});

	it("an invalid frame without an opId is dropped without reply or throw", async () => {
		const phone = generateIdentity();
		const replies: PhoneRelayReply[] = [];
		const { pump } = makePump(phone, replies);

		pump("garbage");
		pump(null);
		pump({ type: "phone_relay" });
		await flush();

		expect(replies).toHaveLength(0);
	});

	it("a sendReply failure is contained (no unhandled rejection)", async () => {
		const phone = generateIdentity();
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const handler = createPhoneHandler({
			registry,
			conversationRegistry,
			mailboxStore: new DeviceMailboxStore(),
			localSwitchId: "test-host",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});
		const pump = createPhoneRelayPump({
			sealer: createPhoneSealer(arbiter, admittedAllowlist(phone)),
			handleFrame: handler.handleFrame,
			sendReply: async () => {
				throw new Error("evie gone");
			},
		});

		pump(sealFrame(phone, { kind: "register" }, { opId: "op-1" }));
		await flush();
		// Reaching here without vitest reporting an unhandled rejection is the assertion.
	});
});
