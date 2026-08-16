import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { createConsoleSealer } from "../gateway/console/consoleSealer.js";
import { createConsoleRelayPump } from "../gateway/console/relayPump.js";
import { Allowlist } from "../gateway/federation/allowlist.js";
import type { ConversationRegistry, TeamRegistry } from "../gateway/websocket.js";
import { signAdmission } from "../shared/admission.js";
import type { ConsoleOp, ConsoleOpEnvelope, ConsoleRelayReply, ConsoleReplyBody } from "../shared/console-protocol.js";
import { generateIdentity, type Identity, type SealedEnvelope, seal, unseal } from "../shared/crypto.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { MAX_RELAY_FRAME_BYTES } from "../shared/router-protocol.js";

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
const gateway = generateIdentity();

/** An allowlist rooted at the owner that admits `device` as a kind:console device. */
function admittedAllowlist(device: Identity): Allowlist {
	const a = new Allowlist(tmpDir());
	a.setOwner(owner.sign.pub);
	a.addAdmission(
		signAdmission(
			{ kind: "console", signPub: device.sign.pub, boxPub: device.box.pub, issuedAt: 1000, nonce: "AA==" },
			owner.sign.priv,
			owner.sign.pub,
		),
	);
	return a;
}

/** Seal a console op to the gateway, exactly as the Android client does. */
function sealFrame(
	device: Identity,
	op: ConsoleOp,
	opts: { opId?: string; conversationId?: string; device?: string; at?: number } = {},
): { type: "console_relay"; v: number; opId: string; signerSignPub: string; sealed: SealedEnvelope } {
	const env: ConsoleOpEnvelope = {
		v: 1,
		conversationId: opts.conversationId ?? "conv-1",
		device: opts.device ?? "pixel",
		at: opts.at ?? Date.now(),
		op,
	};
	const sealed = seal(Buffer.from(JSON.stringify(env)), gateway.box.pub, device.sign.priv);
	return { type: "console_relay", v: 1, opId: opts.opId ?? "op-1", signerSignPub: device.sign.pub, sealed };
}

function openReply(device: Identity, reply: ConsoleRelayReply): ConsoleReplyBody {
	if (!reply.sealed) throw new Error(`reply not sealed: ${reply.error}`);
	return JSON.parse(unseal(reply.sealed, device.box.priv, gateway.sign.pub).toString("utf8")) as ConsoleReplyBody;
}

function makePump(device: Identity, replies: ConsoleRelayReply[]) {
	const registry: TeamRegistry = new Map();
	const conversationRegistry: ConversationRegistry = new Map();
	const handler = createConsoleDispatcher({
		registry,
		conversationRegistry,
		mailboxStore: new DeviceMailboxStore(),
		localGatewayId: "test-host",
		localDomainId: "test-domain",
		routes: {
			send: async () => jsonRes({}),
			respond: () => jsonRes({}),
			teams: () => jsonRes([]),
			discover: async () => jsonRes([]),
		},
	});
	const pump = createConsoleRelayPump({
		sealer: createConsoleSealer(gateway, admittedAllowlist(device)),
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

describe("createConsoleRelayPump (sealed)", () => {
	it("a sealed frame from an admitted console opens, runs, and the reply is sealed back", async () => {
		const device = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const { pump, registry } = makePump(device, replies);

		pump(sealFrame(device, { kind: "register" }, { opId: "op-1" }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].error).toBeUndefined();
		const body = openReply(device, replies[0]);
		expect(body.ok).toBe(true);
		expect(body.result).toMatchObject({ device: "pixel", cursor: 0 });
		expect(registry.get("pixel")).toBeDefined();
	});

	it("refuses to put an oversized reply on the shared socket, failing the op instead", async () => {
		// An oversized frame does not fail politely: the Router's WebSocket closes the gateway connection
		// and every team's traffic goes with it. So the budget has to be enforced where a frame
		// becomes bytes, not merely agreed upon by constants. Without the check this test does not
		// fail loudly, it takes down the socket in production and looks fine here.
		const device = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const registry: TeamRegistry = new Map();
		const pump = createConsoleRelayPump({
			sealer: createConsoleSealer(gateway, admittedAllowlist(device)),
			// Cast: the reply-body union describes real op results, and the point here is a body too
			// big to put on the wire, whatever its shape.
			handleFrame: async () => ({ ok: true, result: { blob: "x".repeat(MAX_RELAY_FRAME_BYTES) } }) as never,
			sendReply: async (reply) => {
				replies.push(reply);
				return {};
			},
		});

		pump(sealFrame(device, { kind: "register" }, { opId: "op-big" }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].sealed).toBeUndefined();
		expect(replies[0].error).toContain(`exceeds ${MAX_RELAY_FRAME_BYTES}`);
		expect(registry.size).toBe(0);
	});

	it("a frame signed by an unadmitted console is rejected with a cleartext error", async () => {
		const device = generateIdentity();
		const stranger = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const { pump } = makePump(device, replies); // allowlist admits `device`, not `stranger`

		pump(sealFrame(stranger, { kind: "register" }, { opId: "op-x" }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].sealed).toBeUndefined();
		expect(replies[0].error).toContain("not admitted");
	});

	it("a replayed sealed frame is rejected after the first delivery", async () => {
		const device = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const { pump } = makePump(device, replies);

		const frame = sealFrame(device, { kind: "register" }, { opId: "op-1" });
		pump(frame);
		await flush();
		pump(frame); // identical bytes (same seal nonce) -> a replay
		await flush();

		expect(replies).toHaveLength(2);
		expect(openReply(device, replies[0]).ok).toBe(true);
		expect(replies[1].sealed).toBeUndefined();
		expect(replies[1].error).toContain("replayed");
	});

	it("a stale sealed frame (old timestamp) is rejected", async () => {
		const device = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const { pump } = makePump(device, replies);

		pump(sealFrame(device, { kind: "register" }, { opId: "op-old", at: 1 }));
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].error).toContain("stale");
	});

	it("an invalid frame with a usable opId gets a cleartext error reply", async () => {
		const device = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const { pump } = makePump(device, replies);

		pump({ type: "console_relay", opId: "op-bad", op: { kind: "nonsense" } });
		await flush();

		expect(replies).toHaveLength(1);
		expect(replies[0].error).toContain("Invalid relay frame");
		expect(replies[0].sealed).toBeUndefined();
	});

	it("an invalid frame without an opId is dropped without reply or throw", async () => {
		const device = generateIdentity();
		const replies: ConsoleRelayReply[] = [];
		const { pump } = makePump(device, replies);

		pump("garbage");
		pump(null);
		pump({ type: "console_relay" });
		await flush();

		expect(replies).toHaveLength(0);
	});

	it("a sendReply failure is contained (no unhandled rejection)", async () => {
		const device = generateIdentity();
		const registry: TeamRegistry = new Map();
		const conversationRegistry: ConversationRegistry = new Map();
		const handler = createConsoleDispatcher({
			registry,
			conversationRegistry,
			mailboxStore: new DeviceMailboxStore(),
			localGatewayId: "test-host",
			localDomainId: "test-domain",
			routes: {
				send: async () => jsonRes({}),
				respond: () => jsonRes({}),
				teams: () => jsonRes([]),
				discover: async () => jsonRes([]),
			},
		});
		const pump = createConsoleRelayPump({
			sealer: createConsoleSealer(gateway, admittedAllowlist(device)),
			handleFrame: handler.handleFrame,
			sendReply: async () => {
				throw new Error("router gone");
			},
		});

		pump(sealFrame(device, { kind: "register" }, { opId: "op-1" }));
		await flush();
		// Reaching here without vitest reporting an unhandled rejection is the assertion.
	});
});
