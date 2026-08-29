import { describe, expect, it, vi } from "vitest";
import { createAwarenessBank } from "../gateway/awarenessBank.js";
import { createRoutes } from "../gateway/routes.js";
import { SessionStore } from "../shared/session-store.js";
import { makeCtx, makeRegistry } from "./helpers/routes.js";

describe("routes", () => {
	describe("/send", () => {
		it("returns 404 when target not in registry", async () => {
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			// A composite spawn.session chat target (arity 2) resolves locally; with an empty
			// registry it is not connected and the wake fails, so the send 404s.
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b.dev",
				body: "hi",
			});
			expect(res.status).toBe(404);
		});

		it("the not-found `available` list skips a non-slug Device Name registry key instead of throwing", async () => {
			// A console registers under a free-form human Device Name (not an address slug). A send that
			// 404s maps registry keys to canonical addresses for `available`; the device-name key must be
			// skipped (tryLocalAddress), not throw "invalid address segment".
			const registry = makeRegistry({ "Pixel 10 Pro XL": { readyState: 1, data: { mode: "channel" } } });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b.dev",
				body: "hi",
			});
			expect(res.status).toBe(404);
			expect((await res.json()).available).toEqual([]);
		});

		it("blocks a crosstalk send to the reserved host daemon with 400", async () => {
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "proj-a",
				to: "host",
				body: "hi",
			});
			expect(res.status).toBe(400);
		});

		it("returns 404 when target ws.readyState !== 1", async () => {
			const registry = makeRegistry({ "b.dev": { readyState: 3, data: { mode: "channel" } } });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b.dev",
				body: "hi",
			});
			expect(res.status).toBe(404);
		});

		it("channelOnly send to a channel team proceeds with the deterministic session id", async () => {
			const pushed: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel" },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			// The channel session id carries the canonical fully-qualified target
			// (conv.<conv>.<domain>.<gateway>.<spawn>.<session>) so the console threads
			// the reply under the resolved address.
			expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
			expect(json.status).toBe("running");
			expect(pushed.length).toBe(1);
			expect(pushed[0].type).toBe("channel_push");
			expect((pushed[0] as { session_id: string }).session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
		});

		it("rides banked awareness on the next channel send, and the send empties the bank", async () => {
			// A real bank, keyed the way the board keys it: by the target's bare local name.
			const pushed: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel" },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			const bank = createAwarenessBank({ liveness: () => "live", deliver: () => true });
			const observe = bank.register<string>({
				source: "task-board",
				act: () => "no_act",
				render: () => "The owner edited a.",
			});
			observe([{ sessionKey: "proj-a.dev", identity: "a", pre: "x", post: "y" }]);
			const ctx = makeCtx({ registry: makeRegistry({ "proj-a.dev": fakeWs }), awareness: bank });
			const { send } = createRoutes(ctx);
			for (const body of ["hi", "again"]) {
				await send(new Request("http://localhost/send", { method: "POST" }), {
					from: "pixel",
					fromConversationId: "conv-1",
					to: "proj-a.dev",
					body,
					channelOnly: true,
				});
			}
			expect(pushed[0].awareness).toEqual({ from: "task-board", body: "The owner edited a.", act: "no_act" });
			expect(pushed[1].awareness).toBeUndefined();
			expect(bank.takeFor("proj-a.dev")).toBeNull();
		});

		it("delivers to a live but unconfirmed (still verifying) socket - send() carries no handshake gate", async () => {
			const pushed: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel", handshakeConfirmed: false },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(200);
			expect(pushed.length).toBe(1);
		});

		it("re-pushes an unconfirmed recipient's handshake ahead of the message, then still delivers", async () => {
			const events: string[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel", handshakeConfirmed: false, teamName: "proj-a.dev", subId: "sub-1" },
				send(data: string) {
					events.push((JSON.parse(data) as { type: string }).type);
				},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const repushHandshake = vi.fn().mockImplementation(() => {
				events.push("handshake-repush");
				return "pushed";
			});
			const ctx = makeCtx({ registry, repushHandshake });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(200);
			expect(repushHandshake).toHaveBeenCalledWith("proj-a.dev", "sub-1");
			expect(events).toEqual(["handshake-repush", "channel_push"]);
		});

		it("never re-pushes a handshake for a confirmed recipient", async () => {
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel", handshakeConfirmed: true, teamName: "proj-a.dev", subId: "sub-1" },
				send() {},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const repushHandshake = vi.fn();
			const ctx = makeCtx({ registry, repushHandshake });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(200);
			expect(repushHandshake).not.toHaveBeenCalled();
		});

		it("delivers to an alias re-incarnation via the record's liveTeam (no canonical pane)", async () => {
			const pushed: Record<string, unknown>[] = [];
			const aliasWs = {
				readyState: 1,
				data: { mode: "channel", teamName: "proj-a.alias", handshakeConfirmed: true },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			// The live socket is registered under a DIFFERENT name; nothing under proj-a.dev.
			const registry = makeRegistry({ "proj-a.alias": aliasWs });
			const sessionStore = new SessionStore();
			sessionStore.adoptById("dev", { spawn: "proj-a" });
			sessionStore.confirm("proj-a.dev", { team: "proj-a.alias", subId: "sub-1" });
			const { send } = createRoutes(makeCtx({ registry, sessionStore }));

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			// The session id keys on the TARGET record address, regardless of the alias delivery socket.
			expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
			expect(pushed.length).toBe(1);
			expect((pushed[0] as { session_id: string }).session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
		});

		it("resolves a host-qualified local target to the local session", async () => {
			const pushed: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				data: { mode: "channel" },
				send(data: string) {
					pushed.push(JSON.parse(data));
				},
			};
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			// The console targets the fully-qualified address; its (domain, gateway) is ours,
			// so the local-collapse rule resolves it to the local spawn.session registry entry.
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "alice.test-host.proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			const json = await res.json();
			expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.dev");
			expect(pushed.length).toBe(1);
		});

		it("routes a target qualified with a different Gateway, 503 when the Router is down", async () => {
			const fakeWs = { readyState: 1, data: { mode: "channel" }, send() {} };
			const registry = makeRegistry({ "proj-a.dev": fakeWs });
			// No routerClient in this ctx: the Router is unavailable, so a cross-Gateway
			// target (an arity-4 address whose gateway differs from ours) reports 503
			// rather than misresolving to the same-named local session.
			const ctx = makeCtx({ registry });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "alice.other-host.proj-a.dev",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(503);
		});

		it("a not-yet-existing composite with no displayLabel fails fast instead of silently adopting the typed name", async () => {
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({
					ok: false,
					error: `"proj-a.newsession" does not exist yet; retry with a displayLabel to create it`,
				});
			};
			const ctx = makeCtx({ tryWakeTeam });
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.newsession",
				body: "hi",
				channelOnly: true,
			});
			expect(res.status).toBe(404);
			// The wake carries a provenance key derived from (fromConversationId, to) even though this
			// attempt has no displayLabel, so a retry that DOES supply one still reattaches correctly.
			expect(wakeCalls).toEqual([
				{
					team: "proj-a.newsession",
					createOpts: { displayLabel: undefined, mintedFrom: "conv-1:proj-a.newsession" },
				},
			]);
		});

		it("a not-yet-existing composite with a displayLabel mints and switches to the resolved address for everything downstream", async () => {
			vi.useFakeTimers();
			try {
				const pushed: Record<string, unknown>[] = [];
				const mintedWs = {
					readyState: 1,
					data: { mode: "channel" },
					send(data: string) {
						pushed.push(JSON.parse(data));
					},
				};
				// The minted record's live incarnation registers under the freshly-minted id, never the
				// typed one - nothing is registered under "proj-a.newsession" at all.
				const registry = makeRegistry({ "proj-a.minted1": mintedWs });
				const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> =
					[];
				const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
					wakeCalls.push({ team, createOpts });
					return Promise.resolve({ ok: true, resolvedTeam: "proj-a.minted1" });
				};
				const ctx = makeCtx({ registry, tryWakeTeam });
				const { send } = createRoutes(ctx);

				const resPromise = send(new Request("http://localhost/send", { method: "POST" }), {
					from: "pixel",
					fromConversationId: "conv-1",
					to: "proj-a.newsession",
					body: "hi",
					channelOnly: true,
					displayLabel: "Bug Hunt",
				});
				await vi.advanceTimersByTimeAsync(3000);
				const json = await (await resPromise).json();

				// The wake is requested against the TYPED address (the minted one does not exist to wake
				// yet), carrying the displayLabel and a provenance key derived from the RESOLVED local
				// name (which happens to equal the typed `to` here, since it was already the short form).
				expect(wakeCalls).toEqual([
					{
						team: "proj-a.newsession",
						createOpts: { displayLabel: "Bug Hunt", mintedFrom: "conv-1:proj-a.newsession" },
					},
				]);
				// Everything downstream of the wake - the reply and the channel push - addresses the
				// MINTED session, never the address the caller originally typed.
				expect(json.session_id).toBe("conv.conv-1.alice.test-host.proj-a.minted1");
				expect(pushed.length).toBe(1);
				expect((pushed[0] as { session_id: string }).session_id).toBe(
					"conv.conv-1.alice.test-host.proj-a.minted1",
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("mintedFrom is keyed on the RESOLVED local name, not the caller's raw spelling - two valid spellings of the same target agree", async () => {
			// The same local target can be legally spelled two ways: a short local form, and a
			// self-qualified domain.gateway.spawn.session form (the local-collapse rule folds the
			// latter onto the former). A caller who discovers a session via crosstalk_discover (which
			// renders the qualified form) and later retries using that exact string must still land on
			// the SAME mintedFrom a short-form retry would have used - otherwise the two spellings mint
			// two different sessions for what the caller believes is one retry.
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({ ok: false, error: "not found" });
			};
			const ctx = makeCtx({ tryWakeTeam });
			const { send } = createRoutes(ctx);

			await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				to: "proj-a.newsession",
				body: "hi",
				channelOnly: true,
				displayLabel: "Bug Hunt",
			});
			await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "pixel",
				fromConversationId: "conv-1",
				// The fully-qualified spelling of the identical local target (our own domain/gateway).
				to: "alice.test-host.proj-a.newsession",
				body: "hi again",
				channelOnly: true,
				displayLabel: "Bug Hunt",
			});

			expect(wakeCalls).toHaveLength(2);
			expect(wakeCalls[0].createOpts?.mintedFrom).toBe(wakeCalls[1].createOpts?.mintedFrom);
			expect(wakeCalls[0].team).toBe(wakeCalls[1].team);
		});

		it("a trusted-inbound (federated) send derives mintedFrom from its own inboundSessionId (the real call shape: no fromConversationId of its own)", async () => {
			const wakeCalls: Array<{ team: string; createOpts?: { displayLabel?: string; mintedFrom?: string } }> = [];
			const tryWakeTeam = (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => {
				wakeCalls.push({ team, createOpts });
				return Promise.resolve({ ok: false, error: "not found" });
			};
			const ctx = makeCtx({ tryWakeTeam });
			const { send } = createRoutes(ctx);

			// Mirrors gatewayRelay.ts's actual "send" case body: no fromConversationId is ever set
			// alongside sessionId/returnRoute on a trusted-inbound call, so this does not (and cannot)
			// prove inboundSessionId wins over a competing fromConversationId - only that it is used
			// when fromConversationId is absent, the one shape the real caller produces.
			await send(
				new Request("http://localhost/send", { method: "POST" }),
				{
					from: "alice.friend-gw.proj-a.dev",
					to: "proj-a.newsession",
					body: "hi",
					channelOnly: true,
					displayLabel: "Bug Hunt",
					sessionId: "conv.friend-conv.alice.test-host.proj-a.newsession",
					returnRoute: {
						srcGateway: "friend-gw",
						srcConversationId: "friend-conv",
						srcSession: "conv.friend-conv.alice.test-host.proj-a.newsession",
					},
				},
				{ trustedInbound: true },
			);
			expect(wakeCalls).toEqual([
				{
					team: "proj-a.newsession",
					createOpts: {
						displayLabel: "Bug Hunt",
						mintedFrom: "conv.friend-conv.alice.test-host.proj-a.newsession",
					},
				},
			]);
		});
	});
});

// The console's `from` is the human's free-form Device Name, not a session name, and its ops are
// already authenticated by the sealed relay before they reach here. Gating it on a name that cannot
// resolve to a record blocks the owner from messaging their own sessions at all.
describe("the console sends under its own device name", () => {
	it("accepts a send whose sender is a device name rather than a local session", async () => {
		const sessionStore = new SessionStore();
		const ws = { readyState: 1, send: vi.fn(), data: { mode: "channel", handshakeConfirmed: true } };
		const registry = makeRegistry({ "recipe-app.abc123": ws });
		const { send } = createRoutes(makeCtx({ registry, sessionStore }));

		const res = await send(
			new Request("http://gateway/send"),
			{ from: "Pixel 10 Pro XL", fromConversationId: "owner-1", to: "recipe-app.abc123", body: "hi" },
			{ consoleSender: true },
		);

		expect(res.status).toBe(200);
	});
});
