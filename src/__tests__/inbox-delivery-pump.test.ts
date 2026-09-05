import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInboxClaims } from "../gateway/router/inboxClaims.js";
import { createInboxDeliveryPump } from "../gateway/router/inboxDeliveryPump.js";
import { processAmbient } from "../shared/ambient.js";
import { inboxBodyAadKind, opPayloadAadKind } from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";
import type { PendingDelivery } from "../shared/pending-delivery-store.js";

const roots: string[] = [];
const address = "session:domain/gateway/session";
const envelope = (epoch: number | "peer" | "clear") => ({
	origin: { kind: "session" as const, domainId: "domain", gatewayId: "origin", sessionId: "source" },
	opKey: { conversationId: "conversation", opId: "operation" },
	epoch,
	kind: "message" as const,
	contentRefs: [],
});
const row = (
	epoch: number | "peer" = 1,
	body: unknown = { v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" },
) => ({
	seq: 1,
	acceptedAt: 10,
	size: 1,
	envelope: envelope(epoch),
	producerSig: "c2ln",
	body,
});
const setup = (root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pump-"))) => {
	if (!roots.includes(root)) roots.push(root);
	const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
	const claims = createInboxClaims(root, processAmbient());
	const coordinator = {
		accepted: [] as PendingDelivery[],
		accept(value: PendingDelivery) {
			this.accepted.push(value);
			return "delivered" as const;
		},
		acknowledge: (_id: string) => {},
	};
	const pump = (overrides: Record<string, unknown> = {}) =>
		createInboxDeliveryPump({
			claims,
			routerClient: { callInboxTool: async (action, params) => calls.push({ action, params }) },
			domainId: "domain",
			ownerSignPub: () => "owner",
			contentKeyStore: {
				open: () => ({
					kind: "ok",
					plaintext: Buffer.from('{"to":"session","from":"source","body":"hi"}'),
				}),
			} as never,
			coordinator: coordinator as never,
			isSessionLive: () => true,
			...overrides,
		});
	return { calls, coordinator, pump, claims };
};

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inbox delivery pump", () => {
	it("offers a live row once and a receiver ack delivers it", async () => {
		const { calls, coordinator, pump } = setup();
		const stale = pump({ incarnation: () => 2 });
		await stale.onFrame({ address, rows: [row()], incarnation: 1, deliveryEpoch: 1 });
		expect(coordinator.accepted).toHaveLength(0);
		expect(calls).toHaveLength(0);
		const deliveryPump = pump();
		await deliveryPump.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(coordinator.accepted).toHaveLength(1);
		expect(calls).toHaveLength(0);
		expect(await deliveryPump.onChannelDeliveryAck("other", `${address}:1:1`)).toBe(false);
		expect(await deliveryPump.onChannelDeliveryAck("session", `${address}:1:1`)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls.at(-1)).toMatchObject({ action: "inbox_ack", params: { outcome: "delivered", seq: 1 } });
	});

	it("wakes a sleeping session, keeps a missing epoch claim, and fails a bad tag", async () => {
		const sleeping = setup();
		const woken: string[] = [];
		const wake = async (team: string) => {
			woken.push(team);
			return { ok: false, errorKind: "timeout" };
		};
		const held = { accept: () => "queued" as const, acknowledge: () => true };
		await sleeping
			.pump({ coordinator: held, isSessionLive: () => false, tryWakeTeam: wake })
			.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(woken).toEqual(["session"]);
		expect(sleeping.calls.at(-1)).toMatchObject({ action: "inbox_ack", params: { outcome: "waking" } });

		const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pump-"));
		const missing = setup(missingRoot);
		const missingPump = missing.pump({ ownerSignPub: () => null });
		await missingPump.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(missing.calls.at(-1)).toMatchObject({
			action: "inbox_ack",
			params: { outcome: "waking", reason: "missing_epoch" },
		});
		const retry = setup(missingRoot);
		await retry.pump({ ownerSignPub: () => null }).onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(retry.calls).toHaveLength(1);

		const bad = setup();
		await bad
			.pump({ contentKeyStore: { open: () => ({ kind: "bad_tag" }) } })
			.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(bad.calls.at(-1)).toMatchObject({
			action: "inbox_ack",
			params: { outcome: "failed", reason: "bad_tag" },
		});
	});

	it("opens Router scheduled messages with the operation AAD", async () => {
		const kinds: string[] = [];
		const payloadCiphertext = "AgICAgICAgICAgICAgICAg==";
		const scheduledCiphertext = "AQEBAQEBAQEBAQEBAQEBAQ==";
		const contentBody = (ciphertext: string) => ({ v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext });
		const open = (body: unknown, aad: { kind: string }) => {
			kinds.push(aad.kind);
			if (
				aad.kind.startsWith(inboxBodyAadKind("", "").split("\n")[0]) &&
				(body as { ciphertext: string }).ciphertext === payloadCiphertext
			)
				return { kind: "bad_tag" };
			return { kind: "ok", plaintext: Buffer.from('{"to":"session","from":"source","body":"hi"}') };
		};
		const routerMessage = setup().pump({ contentKeyStore: { open } } as never);
		await routerMessage.onFrame({
			address,
			rows: [
				{
					...row(1, contentBody(scheduledCiphertext)),
					envelope: { ...envelope(1), origin: { kind: "router", domainId: "domain" } },
				},
			],
			deliveryEpoch: 1,
		});
		const failedSetup = setup();
		const failed = failedSetup.pump({ contentKeyStore: { open } } as never);
		await failed.onFrame({
			address,
			rows: [
				{
					...row(1, contentBody(payloadCiphertext)),
					envelope: { ...envelope(1), origin: { kind: "router", domainId: "domain" } },
				},
			],
			deliveryEpoch: 1,
		});
		expect(failedSetup.calls.at(-1)).toMatchObject({ params: { outcome: "failed", reason: "bad_tag" } });
		const consoleMessage = setup().pump({ contentKeyStore: { open } } as never);
		await consoleMessage.onFrame({
			address,
			rows: [
				{
					...row(1, contentBody(payloadCiphertext)),
					envelope: { ...envelope(1), origin: { kind: "console", domainId: "domain" } },
				},
			],
			deliveryEpoch: 1,
		});
		expect(kinds).toEqual([
			inboxBodyAadKind("conversation", "operation"),
			inboxBodyAadKind("conversation", "operation"),
			opPayloadAadKind(),
		]);
	});

	it("refuses console delivery addressed to another Domain or Gateway", async () => {
		const setupResult = setup();
		const identity = generateIdentity();
		let dispatched = 0;
		const sealedResults: unknown[] = [];
		const delivery = setupResult.pump({
			gatewayId: "gateway",
			routerClient: {
				callInboxTool: async (action: string, params: Record<string, unknown>) => {
					setupResult.calls.push({ action, params });
					return { result: { outcome: action === "inbox_append" ? "accepted" : "delivered" } };
				},
			},
			producerSignPriv: identity.sign.priv,
			consoleDispatch: async () => {
				dispatched++;
				return { renamed: true };
			},
			contentKeyStore: {
				open: () => ({
					kind: "ok",
					plaintext: Buffer.from('{"kind":"rename_session","target":"session","sessionLabel":"renamed"}'),
				}),
				seal: (plaintext: Buffer) => {
					sealedResults.push(JSON.parse(plaintext.toString("utf8")));
					return { kind: "ok", envelope: row().body };
				},
			} as never,
		});
		for (const foreignAddress of ["session:other-domain/gateway/session", "session:domain/other-gateway/session"]) {
			await delivery.onFrame({
				address: foreignAddress,
				rows: [{ ...row(), envelope: { ...envelope(1), kind: "console_op" } }],
				deliveryEpoch: 1,
			});
		}
		expect(dispatched).toBe(0);
		expect(sealedResults).toEqual([
			{ ok: false, error: "target_mismatch" },
			{ ok: false, error: "target_mismatch" },
		]);
		expect(setupResult.calls).toHaveLength(4);
		expect(setupResult.calls.filter((call) => call.action === "inbox_ack")).toHaveLength(2);
		expect(setupResult.calls.at(-1)).toMatchObject({ params: { outcome: "delivered" } });
	});

	it("dispatches a console op that names its session by the canonical dotted address", async () => {
		const setupResult = setup();
		const identity = generateIdentity();
		let dispatched = 0;
		const sealedResults: unknown[] = [];
		const delivery = setupResult.pump({
			gatewayId: "gateway",
			routerClient: {
				callInboxTool: async (action: string, params: Record<string, unknown>) => {
					setupResult.calls.push({ action, params });
					return { result: { outcome: action === "inbox_append" ? "accepted" : "delivered" } };
				},
			},
			producerSignPriv: identity.sign.priv,
			consoleDispatch: async () => {
				dispatched++;
				return { closed: true };
			},
			contentKeyStore: {
				open: () => ({
					kind: "ok",
					plaintext: Buffer.from('{"kind":"close_session","target":"domain.gateway.session"}'),
				}),
				seal: (plaintext: Buffer) => {
					sealedResults.push(JSON.parse(plaintext.toString("utf8")));
					return { kind: "ok", envelope: row().body };
				},
			} as never,
		});
		await delivery.onFrame({
			address: "session:domain/gateway/session",
			rows: [{ ...row(), envelope: { ...envelope(1), kind: "console_op" } }],
			deliveryEpoch: 1,
		});
		expect(dispatched).toBe(1);
		expect(sealedResults).toEqual([{ ok: true, result: { closed: true } }]);
	});

	it("refuses value-shaped ops sent as deliveries, peek included now that its shim is retired", async () => {
		const identity = generateIdentity();
		let dispatched = 0;
		for (const clear of ['{"kind":"peek","target":"session"}', '{"kind":"list_dirs","path":"/tmp"}']) {
			const refused = setup();
			const refusalBodies: unknown[] = [];
			const refusedPump = refused.pump({
				gatewayId: "gateway",
				producerSignPriv: identity.sign.priv,
				consoleDispatch: async () => {
					dispatched++;
					return {};
				},
				contentKeyStore: {
					open: () => ({ kind: "ok", plaintext: Buffer.from(clear) }),
					seal: (plaintext: Buffer) => {
						refusalBodies.push(JSON.parse(plaintext.toString("utf8")));
						return { kind: "ok", envelope: row().body };
					},
				} as never,
			});
			await refusedPump.onFrame({
				address,
				rows: [{ ...row(), envelope: { ...envelope(1), kind: "console_op" } }],
				deliveryEpoch: 1,
			});
			expect(refusalBodies).toEqual([{ ok: false, error: "delivery op kind is not allowed" }]);
		}
		expect(dispatched).toBe(0);
	});

	it("requests a missing console-op epoch and retries after the key grant", async () => {
		const setupResult = setup();
		const identity = generateIdentity();
		let installed = false;
		let dispatched = 0;
		const requested: number[] = [];
		const delivery = setupResult.pump({
			gatewayId: "gateway",
			gatewaySignPub: "Z2F0ZXdheS1zaWdu",
			producerSignPriv: identity.sign.priv,
			consoleDispatch: async () => {
				dispatched++;
				return { renamed: true };
			},
			keyRequester: {
				request: (epoch: number) => requested.push(epoch),
				installed: () => {},
				sendReceipt: async () => {},
				resendReceipts: async () => {},
			},
			allowlistSnapshot: () => ({ ownerSignPub: "owner", admissions: [], revocations: [] }),
			contentKeyStore: {
				open: () =>
					installed
						? {
								kind: "ok",
								plaintext: Buffer.from(
									'{"kind":"rename_session","target":"session","sessionLabel":"renamed"}',
								),
							}
						: { kind: "missing_epoch", epoch: 2 },
				install: () => {
					installed = true;
					return "installed";
				},
				seal: () => ({ kind: "ok", envelope: row().body }),
			} as never,
		});
		await delivery.onFrame({
			address,
			rows: [{ ...row(2), envelope: { ...envelope(2), kind: "console_op" } }],
			deliveryEpoch: 1,
		});
		expect(requested).toEqual([2]);
		expect(dispatched).toBe(0);
		await delivery.onFrame({
			address: "gateway:domain/gateway",
			rows: [
				{
					...row(1),
					seq: 2,
					envelope: {
						...envelope("clear"),
						kind: "key_grant",
						origin: { kind: "router", domainId: "domain" },
					},
					body: {
						v: 1,
						recipientSignPub: "Z2F0ZXdheS1zaWdu",
						envelope: {
							epoch: 2,
							signerSignPub: "signer",
							sealed: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
						},
						at: 10,
					},
				},
			],
			deliveryEpoch: 1,
		});
		expect(dispatched).toBe(1);
		expect(setupResult.calls).toContainEqual(
			expect.objectContaining({ action: "inbox_ack", params: expect.objectContaining({ outcome: "delivered" }) }),
		);
	});

	it("fails a bad-tag console op without waiting", async () => {
		const setupResult = setup();
		const identity = generateIdentity();
		const requested: number[] = [];
		let dispatched = 0;
		await setupResult
			.pump({
				gatewayId: "gateway",
				producerSignPriv: identity.sign.priv,
				consoleDispatch: async () => {
					dispatched++;
					return {};
				},
				keyRequester: {
					request: (epoch: number) => requested.push(epoch),
					installed: () => {},
					sendReceipt: async () => {},
					resendReceipts: async () => {},
				},
				contentKeyStore: { open: () => ({ kind: "bad_tag" }) } as never,
			})
			.onFrame({
				address,
				rows: [{ ...row(), envelope: { ...envelope(1), kind: "console_op" } }],
				deliveryEpoch: 1,
			});
		expect(dispatched).toBe(0);
		expect(requested).toEqual([]);
		expect(setupResult.calls).toEqual([
			expect.objectContaining({
				action: "inbox_ack",
				params: { address, seq: 1, deliveryEpoch: 1, outcome: "failed", reason: "bad_tag" },
			}),
		]);
	});

	it("answers a claimed delivery as lost without dispatching again", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pump-"));
		const first = setup(root);
		const identity = generateIdentity();
		const sealedBodies: unknown[] = [];
		let dispatched = 0;
		const overrides = {
			producerSignPriv: identity.sign.priv,
			consoleDispatch: async () => {
				dispatched++;
				return { renamed: true };
			},
			contentKeyStore: {
				open: () => ({ kind: "ok", plaintext: Buffer.from('{"kind":"rename_session","target":"other"}') }),
				seal: (plaintext: Buffer) => {
					sealedBodies.push(JSON.parse(plaintext.toString("utf8")));
					return { kind: "ok", envelope: row().body };
				},
			} as never,
		};
		first.claims.claim(address, 1, 1);
		const second = setup(root);
		await second.pump(overrides).onFrame({
			address,
			rows: [{ ...row(), envelope: { ...envelope(1), kind: "console_op" } }],
			deliveryEpoch: 1,
		});
		expect(dispatched).toBe(0);
		expect(second.calls.map((call) => call.action)).toEqual(["inbox_append", "inbox_ack"]);
		expect(sealedBodies.at(-1)).toEqual({ ok: false, error: "lost" });
		expect(second.calls[0]).toMatchObject({ action: "inbox_append" });
	});

	it("keeps a failed Router ack claim and re-acks without offering again", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pump-"));
		const first = setup(root);
		const firstPump = first.pump({
			routerClient: { callInboxTool: async () => ({ error: "offline" }) },
			ownerSignPub: () => null,
		});
		await firstPump.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		const second = setup(root);
		await second
			.pump({
				routerClient: {
					callInboxTool: async (_action: string, params: Record<string, unknown>) =>
						second.calls.push({ action: "ack", params }),
				},
				ownerSignPub: () => null,
			})
			.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(second.coordinator.accepted).toHaveLength(0);
		expect(second.calls).toHaveLength(1);
		expect(second.calls[0]).toMatchObject({ params: { outcome: "waking" } });
	});

	it("clears a waking claim after a Router gone reply", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-pump-"));
		const first = setup(root);
		await first
			.pump({
				coordinator: { accept: () => "queued", acknowledge: () => undefined } as never,
				isSessionLive: () => true,
				routerClient: { callInboxTool: async () => ({ result: { outcome: "gone" } }) },
			})
			.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		const second = setup(root);
		await second.pump().onFrame({
			address,
			rows: [row()],
			deliveryEpoch: 1,
		});
		expect(second.coordinator.accepted).toHaveLength(1);
	});

	it("acknowledges definitive wake failures and coordinator delivery", async () => {
		const setupResult = setup();
		const acknowledged: string[] = [];
		await setupResult
			.pump({
				coordinator: {
					accept: () => "queued",
					acknowledge: (id: string) => acknowledged.push(id),
				} as never,
				isSessionLive: () => false,
				tryWakeTeam: async () => ({ ok: false, error: "rejected", errorKind: "bad_request" }),
			})
			.onFrame({ address, rows: [row()], deliveryEpoch: 1 });
		expect(acknowledged).toEqual([`${address}:1:1`]);
		expect(setupResult.calls.at(-1)).toMatchObject({ params: { outcome: "failed", reason: "rejected" } });
	});

	it("fails peer rows before calling the peer handler", async () => {
		const opened = setup();
		const handled: unknown[] = [];
		const sealedBody = { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" };
		await opened
			.pump({
				sealer: {
					openWithSource: () => {
						throw new Error("bad");
					},
				},
				peerHandler: async (op: unknown) => handled.push(op),
			})
			.onFrame({ address, rows: [row("peer", sealedBody)], deliveryEpoch: 1 });
		expect(opened.calls.at(-1)).toMatchObject({ params: { outcome: "failed", reason: "bad_tag" } });

		const malformed = setup();
		await malformed
			.pump({
				sealer: { openWithSource: () => ({ body: { nope: true }, srcDomainId: "friend" }) },
				peerHandler: async (op: unknown) => handled.push(op),
			})
			.onFrame({ address, rows: [row("peer", sealedBody)], deliveryEpoch: 1 });
		expect(malformed.calls.at(-1)).toMatchObject({ params: { outcome: "failed", reason: "malformed_body" } });
		expect(handled).toHaveLength(0);
	});

	it("fails producer clear rows and delivers Router results", async () => {
		const result = setup();
		await result.pump().onFrame({
			address,
			rows: [
				{
					...row(1, { result: true }),
					envelope: {
						...envelope("clear"),
						kind: "op_result",
						origin: { kind: "router", domainId: "domain" },
					},
				},
			],
			deliveryEpoch: 1,
		});
		expect(result.calls.at(-1)).toMatchObject({ params: { outcome: "delivered" } });
		expect(result.coordinator.accepted).toHaveLength(0);
	});

	it("rejects receiver acks for other teams and unclaimed rows", async () => {
		const setupResult = setup();
		const deliveryPump = setupResult.pump();
		expect(await deliveryPump.onChannelDeliveryAck("other", `${address}:1:1`)).toBe(false);
		expect(await deliveryPump.onChannelDeliveryAck("session", `${address}:1:1`)).toBe(false);
		expect(setupResult.calls).toHaveLength(0);

		const peer = setup();
		const handled: unknown[] = [];
		await peer
			.pump({
				sealer: { openWithSource: () => ({ body: { kind: "list_teams" }, srcDomainId: "friend" }) },
				peerHandler: async (op: unknown, srcGateway: string, srcDomainId: string | null) =>
					handled.push([op, srcGateway, srcDomainId]),
			})
			.onFrame({
				address,
				rows: [row("peer", { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" })],
				deliveryEpoch: 1,
			});
		expect(handled).toEqual([[{ kind: "list_teams" }, "origin", "friend"]]);
		expect(peer.calls.at(-1)).toMatchObject({ action: "inbox_ack", params: { outcome: "delivered" } });
	});

	it("replaces duplicate missing rows before retrying after installation", async () => {
		const setupResult = setup();
		let installed = false;
		const requester = {
			request: () => {},
			installed: () => {},
			sendReceipt: async () => {},
			resendReceipts: async () => {},
		};
		const deliveryPump = setupResult.pump({
			gatewayId: "gateway",
			gatewaySignPub: "Z2F0ZXdheS1zaWdu",
			keyRequester: requester,
			allowlistSnapshot: () => ({ ownerSignPub: "owner", admissions: [], revocations: [] }),
			contentKeyStore: {
				open: () =>
					installed
						? { kind: "ok", plaintext: Buffer.from('{"to":"session","from":"source","body":"hi"}') }
						: { kind: "missing_epoch", epoch: 2 },
				install: () => {
					installed = true;
					return "installed";
				},
			} as never,
		});
		const missing = row(2);
		await deliveryPump.onFrame({ address, rows: [missing], deliveryEpoch: 1 });
		await deliveryPump.onFrame({ address, rows: [missing], deliveryEpoch: 1 });
		await deliveryPump.onFrame({
			address: "gateway:domain/gateway",
			rows: [
				{
					seq: 2,
					acceptedAt: 10,
					size: 1,
					envelope: {
						...envelope("clear"),
						kind: "key_grant",
						origin: { kind: "router", domainId: "domain" },
					},
					producerSig: "c2ln",
					body: {
						v: 1,
						recipientSignPub: "Z2F0ZXdheS1zaWdu",
						envelope: {
							epoch: 2,
							signerSignPub: "signer",
							sealed: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
						},
						at: 10,
					},
				},
			],
			deliveryEpoch: 1,
		});
		expect(setupResult.coordinator.accepted).toHaveLength(1);
	});
});
