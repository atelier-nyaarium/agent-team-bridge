import { describe, expect, it, vi } from "vitest";
import { createRoutes, createRoutesCarryOver } from "../gateway/routes.js";
import { generateIdentity } from "../shared/crypto.js";
import { makeCtx } from "./helpers/federation.js";

describe("cross-Domain inbox append", () => {
	it("seals one peer row and returns the Router answer", async () => {
		const identity = generateIdentity();
		const blobId = `sha256-${"a".repeat(64)}`;
		const uploadAll = vi.fn().mockResolvedValue([blobId]);
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const router = {
			isConnected: () => true,
			callInboxTool: async (action: string, params: Record<string, unknown>) => {
				calls.push({ action, params });
				return { result: { outcome: "accepted", seq: 3 } };
			},
		} as unknown as NonNullable<ReturnType<typeof makeCtx>["routerClient"]>;
		const routes = createRoutes({
			...makeCtx("hosta", {
				sealer: {
					seal: () => ({ ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" }),
				} as never,
			}),
			carryOver: createRoutesCarryOver(),
			routerClient: router,
			producerSignPriv: identity.sign.priv,
			blobUploader: { uploadAll } as never,
			crossDomainPeers: {
				resolveByGateway: () => ({ friendDomainId: "beta" }),
				all: () => [{ friendDomainId: "beta", friendGatewayId: "hostb" }],
			} as never,
		});
		const response = await routes.send(new Request("http://gateway/send", { method: "POST" }), {
			from: "source.dev",
			fromConversationId: "conversation",
			to: "beta.hostb.target.dev",
			body: "hello",
			files: [
				{
					filename: "x.txt",
					mime: "text/plain",
					size: 1,
					descriptiveKey: "x",
					blobId,
					role: "attachment",
				},
			],
			channelOnly: true,
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			action: "inbox_append",
			params: { address: "session:beta/hostb/target.dev" },
		});
		expect((calls[0].params.row as { body: unknown }).body).toMatchObject({ ciphertext: expect.any(String) });
		const envelope = (calls[0].params.row as { envelope: { opKey: { conversationId: string }; origin: unknown } })
			.envelope;
		expect(envelope.opKey.conversationId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
		expect(envelope.origin).toMatchObject({ kind: "gateway" });
		// Peer cache has no keys.
		expect(envelope).toMatchObject({ contentRefs: [] });
		expect(uploadAll).toHaveBeenCalledWith([blobId], "cache");
	});

	it("carries the caller's opId into the envelope so a retried send is one operation", async () => {
		const identity = generateIdentity();
		const calls: Array<{ params: Record<string, unknown> }> = [];
		const router = {
			isConnected: () => true,
			callInboxTool: async (_action: string, params: Record<string, unknown>) => {
				calls.push({ params });
				return { result: { outcome: "accepted", seq: 3 } };
			},
		} as unknown as NonNullable<ReturnType<typeof makeCtx>["routerClient"]>;
		const routes = createRoutes({
			...makeCtx("hosta", {
				sealer: {
					seal: () => ({ ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" }),
				} as never,
			}),
			carryOver: createRoutesCarryOver(),
			routerClient: router,
			producerSignPriv: identity.sign.priv,
			crossDomainPeers: {
				resolveByGateway: () => ({ friendDomainId: "beta" }),
				all: () => [{ friendDomainId: "beta", friendGatewayId: "hostb" }],
			} as never,
		});
		const post = (opId?: string) =>
			routes.send(new Request("http://gateway/send", { method: "POST" }), {
				from: "source.dev",
				fromConversationId: "conversation",
				to: "beta.hostb.target.dev",
				body: "hello",
				channelOnly: true,
				...(opId ? { opId } : {}),
			});

		await post("op-retry");
		await post("op-retry");
		await post();

		const opIdOf = (i: number) =>
			(calls[i]?.params.row as { envelope: { opKey: { opId: string } } }).envelope.opKey.opId;
		expect(opIdOf(0)).toBe("op-retry");
		expect(opIdOf(1)).toBe("op-retry");
		expect(opIdOf(2)).toEqual(expect.any(String));
		expect(opIdOf(2)).not.toBe("op-retry");
	});

	it("surfaces a refused Router answer as a failed send", async () => {
		const identity = generateIdentity();
		const router = {
			isConnected: () => true,
			callInboxTool: async () => ({ result: { outcome: "refused" } }),
		} as unknown as NonNullable<ReturnType<typeof makeCtx>["routerClient"]>;
		const routes = createRoutes({
			...makeCtx("hosta", {
				sealer: {
					seal: () => ({ ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" }),
				} as never,
			}),
			routerClient: router,
			producerSignPriv: identity.sign.priv,
			crossDomainPeers: {
				resolveByGateway: () => ({ friendDomainId: "beta" }),
				all: () => [{ friendDomainId: "beta", friendGatewayId: "hostb" }],
			} as never,
		});
		const response = await routes.send(new Request("http://gateway/send", { method: "POST" }), {
			from: "source.dev",
			fromConversationId: "conversation",
			to: "beta.hostb.target.dev",
			body: "hello",
			channelOnly: true,
		});
		expect(response.status).toBe(502);
	});
});
