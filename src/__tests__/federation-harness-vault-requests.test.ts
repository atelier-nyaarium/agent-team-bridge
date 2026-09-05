import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	VAULT_GATEWAYS_KIND,
	VAULT_PUBLIC_TITLE_KIND,
	VAULT_TYPED_KIND,
	VAULT_VALUE_KIND,
	vaultAadKind,
} from "../shared/content-envelope.js";
import {
	VaultListResultSchema,
	type VaultRequest,
	VaultRequestSchema,
	VaultRetractSchema,
} from "../shared/schemasVault.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import { createGatewayPort, runAskpass } from "../vault-askpass/askpass.js";

type UseAnswer = { outcome: string; decision?: string; value?: string; requestId?: string; reason?: string };

describe("federation harness: vault requests", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	let alice: FakeSession;
	const entryId = "deploy-key";

	const launch = async (label: string): Promise<FakeSession> => {
		h.host.handlers.onCreateSession = (op) => {
			sessions.push(
				attachFakeSession(h.gateway, {
					team: composeSessionName(op.target.name, op.target.sessionName),
					conversationId: `conv-${label.toLowerCase()}`,
					sessionToken: op.sessionToken,
				}),
			);
		};
		const before = sessions.length;
		const { result } = await h.phone.value({ kind: "create_session", target: "host", displayLabel: label });
		expect(result).toMatchObject({ created: true });
		const created = await h.waitFor(() => sessions[before], "the daemon's launch");
		await created.ready();
		return created;
	};
	const post = async (caller: FakeSession, path: string, body: Record<string, unknown>) => {
		const response = await caller.post(path, body);
		return { status: response.status, json: (await response.json()) as UseAnswer & Record<string, unknown> };
	};
	const vaultRows = async (actionType: string) =>
		h.phone
			.entries(await h.phone.inboxRead())
			.filter(
				(entry) =>
					entry.kind === "plugin_action" && entry.pluginId === "vault" && entry.actionType === actionType,
			);
	/** Oldest vault requests first. */
	const requestRows = async (): Promise<VaultRequest[]> =>
		(await vaultRows("request")).map((entry) => VaultRequestSchema.parse(entry.payload));
	const nextRequest = async (seen: number): Promise<VaultRequest> =>
		h.waitFor(async () => (await requestRows())[seen], "the request row");
	/** A settled request is retracted from every console. */
	const retracted = (requestId: string): Promise<unknown> =>
		h.waitFor(
			async () =>
				(await vaultRows("retract")).find(
					(entry) => VaultRetractSchema.parse(entry.payload).requestId === requestId,
				),
			"the retract row",
		);

	beforeAll(async () => {
		h = await startFederationHarness();
		alice = await launch("Alice");
		const written = await h.phone.send({
			kind: "vault_put",
			put: {
				id: entryId,
				expectedRevision: 0,
				sealed: {
					publicTitle: h.phone.seal("Deploy key", vaultAadKind(VAULT_PUBLIC_TITLE_KIND, entryId)),
					value: h.phone.seal("hunter2", vaultAadKind(VAULT_VALUE_KIND, entryId)),
				},
			},
		});
		expect(written).toMatchObject({ outcome: "applied" });
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("an agent searches public fields only, and an unbound caller gets nothing", async () => {
		const found = await post(alice, "/vault/search", { query: "deploy" });
		expect(found.json).toEqual({ entries: [{ id: entryId, publicTitle: "Deploy key", hasValue: true }] });
		expect(JSON.stringify(found.json)).not.toContain("hunter2");
		const unbound = await h.gateway.router(
			new Request("http://gateway.test/vault/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(unbound.status).toBe(401);
	});

	it("the sealed allowlist admits this gateway by name; another name or an unreadable list shuts it out", async () => {
		const putListed = async (id: string, gateways: string, sealedUnder = id) =>
			h.phone.send({
				kind: "vault_put",
				put: {
					id,
					expectedRevision: 0,
					sealed: {
						publicTitle: h.phone.seal(`Listed ${id}`, vaultAadKind(VAULT_PUBLIC_TITLE_KIND, id)),
						value: h.phone.seal("k", vaultAadKind(VAULT_VALUE_KIND, id)),
						gateways: h.phone.seal(gateways, vaultAadKind(VAULT_GATEWAYS_KIND, sealedUnder)),
					},
				},
			});
		await putListed("named-here", JSON.stringify([h.set.gateway.id]));
		await putListed("named-elsewhere", JSON.stringify(["other-gateway"]));
		await putListed("unreadable-list", JSON.stringify([h.set.gateway.id]), "some-other-entry");

		const found = await post(alice, "/vault/search", { query: "listed" });
		expect(found.json.entries).toEqual([{ id: "named-here", publicTitle: "Listed named-here", hasValue: true }]);
		for (const entryId of ["named-elsewhere", "unreadable-list"]) {
			const refused = await post(alice, "/vault/use", { entryId, operation: "ssh deploy@prod", waitMs: 200 });
			expect(refused.status).toBe(403);
			expect(refused.json).toMatchObject({ outcome: "refused" });
		}
	});

	it("a request reaches the phone as a row, and one approval answers the waiting use", async () => {
		const seen = (await requestRows()).length;
		const use = post(alice, "/vault/use", { entryId, operation: "ssh deploy@prod uptime", waitMs: 10_000 });
		const request = await nextRequest(seen);
		expect(request).toMatchObject({ kind: "entry", entryId, shape: "ssh deploy@prod", sessionTarget: alice.team });
		const answered = await h.phone.value({ kind: "vault_answer", requestId: request.requestId, decision: "once" });
		expect(answered.result).toEqual({ ok: true });
		expect((await use).json).toEqual({ outcome: "approved", decision: "once", value: "hunter2" });
		await retracted(request.requestId);
		// Once grants leave no residue.
		const again = await post(alice, "/vault/use", { entryId, operation: "ssh deploy@prod uptime", waitMs: 200 });
		expect(again.json).toMatchObject({ outcome: "pending" });
		const second = await nextRequest(seen + 1);
		const denied = await h.phone.value({ kind: "vault_answer", requestId: second.requestId, decision: "deny" });
		expect(denied.result).toEqual({ ok: true });
		const collected = await post(alice, "/vault/collect", { requestId: second.requestId, waitMs: 5_000 });
		expect(collected.status).toBe(403);
		expect(collected.json).toMatchObject({ outcome: "refused" });
	});

	it("a window covers its shape across a gateway restart, not another shape, until revoked", async () => {
		const seen = (await requestRows()).length;
		const use = post(alice, "/vault/use", { entryId, operation: "ssh deploy@prod ls", waitMs: 10_000 });
		const request = await nextRequest(seen);
		await h.phone.value({ kind: "vault_answer", requestId: request.requestId, decision: "window" });
		expect((await use).json).toMatchObject({ outcome: "approved", decision: "window" });

		await h.restartGateway();
		const reattached = attachFakeSession(h.gateway, {
			team: alice.team,
			conversationId: alice.conversationId,
			sessionToken: alice.sessionToken,
		});
		sessions.push(reattached);
		await reattached.ready();
		const covered = await post(reattached, "/vault/use", { entryId, operation: "ssh deploy@prod df", waitMs: 200 });
		expect(covered.json).toEqual({ outcome: "approved", decision: "window", value: "hunter2" });
		expect((await requestRows()).length).toBe(seen + 1);

		const other = await post(reattached, "/vault/use", { entryId, operation: "curl https://x", waitMs: 200 });
		expect(other.json).toMatchObject({ outcome: "pending" });

		const grants = await h.phone.value({ kind: "vault_grants" });
		const grant = (
			grants.result as { grants: Array<{ grantId: string; tier: string; shape?: string }> }
		).grants.find((g) => g.shape === "ssh deploy@prod");
		expect(grant).toMatchObject({ tier: "window", shape: "ssh deploy@prod" });
		expect((await h.phone.value({ kind: "vault_revoke", grantId: grant?.grantId ?? "" })).result).toEqual({
			revoked: true,
		});
		const revoked = await post(reattached, "/vault/use", { entryId, operation: "ssh deploy@prod df", waitMs: 200 });
		expect(revoked.json).toMatchObject({ outcome: "pending" });
	});

	it("a capture creates an entry the phone lists as the gateway's, with a notice", async () => {
		const caller = attachFakeSession(h.gateway, {
			team: alice.team,
			conversationId: alice.conversationId,
			sessionToken: alice.sessionToken,
		});
		sessions.push(caller);
		await caller.ready();
		const captured = await post(caller, "/vault/capture", { publicTitle: "Minted token", value: "s3cr3t\n" });
		expect(captured.status).toBe(200);
		const listed = VaultListResultSchema.parse(await h.phone.send({ kind: "vault_list" }));
		const entry = listed.entries.find((e) => e.clear.id === captured.json.id);
		expect(entry?.clear).toMatchObject({ createdBy: "gateway", revision: 1 });
		// Trim one trailing newline.
		expect(
			h.phone.openText(entry?.sealed.value as never, vaultAadKind(VAULT_VALUE_KIND, String(captured.json.id))),
		).toBe("s3cr3t");
		await h.waitFor(
			async () =>
				h.phone
					.entries(await h.phone.inboxRead())
					.find((row) => row.kind === "notice" && row.title === "Vault entry captured"),
			"the capture notice",
		);
	});

	it("the helper asks with its own token: a title equal to the shape picks the entry, else the owner types", async () => {
		const gatewayPost = (path: string, headers: Record<string, string>, body: Record<string, unknown>) =>
			h.gateway.router(
				new Request(`http://gateway.test${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
				}),
			);
		expect((await gatewayPost("/vault/helper-token", {}, {})).status).toBe(401);
		// A withdraw of a request the caller did not open answers false.
		expect(await (await post(alice, "/vault/withdraw", { requestId: "nothing-open" })).json).toEqual({
			withdrawn: false,
		});
		const minted = await gatewayPost("/vault/helper-token", { "x-host-token": h.set.tokens.host }, {});
		expect(minted.status).toBe(200);
		const { token, tokenId } = (await minted.json()) as { token: string; tokenId: string };
		const askpass = async (cmdline: string, waitMs: number) =>
			(await gatewayPost("/vault/askpass", { "x-vault-helper-token": token }, { cmdline, waitMs })).json();
		expect((await gatewayPost("/vault/askpass", {}, { cmdline: "sudo apt install foo" })).status).toBe(401);

		// No matching title: typed request, collected by the helper after the wait ran out.
		const seen = (await requestRows()).length;
		const typed = await askpass("sudo apt install foo", 200);
		expect(typed).toMatchObject({ outcome: "pending" });
		const request = await nextRequest(seen);
		expect(request).toMatchObject({ kind: "typed", shape: "sudo apt", requestId: typed.requestId });
		// A helper has no session, so its row is keyed to the console's own conversation.
		const row = h.phone
			.entries(await h.phone.inboxRead())
			.find((entry) => entry.kind === "plugin_action" && entry.payload?.requestId === request.requestId);
		expect(row?.session_id?.startsWith("conv.")).toBe(true);
		const value = h.phone.seal("t0ps3cret", vaultAadKind(VAULT_TYPED_KIND, request.requestId));
		const answered = await h.phone.value({
			kind: "vault_answer",
			requestId: request.requestId,
			decision: "once",
			value,
		});
		expect(answered.result).toEqual({ ok: true });
		// A session cannot collect the helper's request, and the helper cannot search.
		expect((await post(alice, "/vault/collect", { requestId: request.requestId, waitMs: 100 })).status).toBe(403);
		expect((await gatewayPost("/vault/search", { "x-vault-helper-token": token }, {})).status).toBe(404);
		const collected = await gatewayPost(
			"/vault/collect",
			{ "x-vault-helper-token": token },
			{ requestId: request.requestId, waitMs: 5_000 },
		);
		expect(await collected.json()).toEqual({ outcome: "approved", decision: "once", value: "t0ps3cret" });

		const id = "prod-ssh";
		await h.phone.send({
			kind: "vault_put",
			put: {
				id,
				expectedRevision: 0,
				sealed: {
					publicTitle: h.phone.seal("ssh deploy@prod", vaultAadKind(VAULT_PUBLIC_TITLE_KIND, id)),
					value: h.phone.seal("k3y", vaultAadKind(VAULT_VALUE_KIND, id)),
				},
			},
		});
		const entryRoad = askpass("ssh deploy@prod -v", 10_000);
		const second = await nextRequest(seen + 1);
		expect(second).toMatchObject({ kind: "entry", entryId: id, shape: "ssh deploy@prod" });
		await h.phone.value({ kind: "vault_answer", requestId: second.requestId, decision: "session" });
		// A helper's session tap is a window: every process on the host shares its token.
		expect(await entryRoad).toEqual({ outcome: "approved", decision: "window", value: "k3y" });
		expect(await askpass("ssh deploy@prod uptime", 200)).toEqual({
			outcome: "approved",
			decision: "window",
			value: "k3y",
		});
		expect((await requestRows()).length).toBe(seen + 2);
		// Revoking the token ends its grants with it.
		const listed = (await h.phone.value({ kind: "vault_grants" })).result as {
			grants: Array<{ sessionTarget: string }>;
		};
		expect(listed.grants.some((grant) => grant.sessionTarget === `helper.${tokenId}`)).toBe(true);
		expect((await h.phone.value({ kind: "vault_revoke", grantId: tokenId })).result).toEqual({ revoked: true });
		const after = (await h.phone.value({ kind: "vault_grants" })).result as {
			grants: Array<{ sessionTarget: string }>;
		};
		expect(after.grants.some((grant) => grant.sessionTarget === `helper.${tokenId}`)).toBe(false);
		expect(
			(await gatewayPost("/vault/askpass", { "x-vault-helper-token": token }, { cmdline: "ssh deploy@prod" }))
				.status,
		).toBe(404);
		const revived = await gatewayPost("/vault/helper-token", { "x-host-token": h.set.tokens.host }, {});
		const fresh = ((await revived.json()) as { token: string }).token;
		const askpassFresh = async (cmdline: string, waitMs: number) =>
			(await gatewayPost("/vault/askpass", { "x-vault-helper-token": fresh }, { cmdline, waitMs })).json();

		// Duplicate titles require typed input.
		const shadow = attachFakeSession(h.gateway, {
			team: alice.team,
			conversationId: alice.conversationId,
			sessionToken: alice.sessionToken,
		});
		sessions.push(shadow);
		await shadow.ready();
		const planted = await post(shadow, "/vault/capture", { publicTitle: "ssh deploy@prod", value: "planted" });
		expect(planted.status).toBe(200);
		expect(await askpassFresh("ssh deploy@prod uptime", 200)).toMatchObject({ outcome: "pending" });
		expect((await nextRequest(seen + 2)).kind).toBe("typed");
	});

	it("the helper binary's port holds for the phone without a tty, and withdraws when the tty wins", async () => {
		const minted = await h.gateway.router(
			new Request("http://gateway.test/vault/helper-token", {
				method: "POST",
				headers: { "content-type": "application/json", "x-host-token": h.set.tokens.host },
				body: "{}",
			}),
		);
		expect(minted.status).toBe(200);
		const { token } = (await minted.json()) as { token: string };
		const gateway = createGatewayPort({
			baseUrl: "http://gateway.test",
			token,
			fetch: (url, init) => h.gateway.router(new Request(url, init)),
		});
		const seen = (await requestRows()).length;
		const held = runAskpass(
			{ cmdline: "sudo apt install foo", prompt: "x" },
			{ gateway, tty: null, now: Date.now },
		);
		const request = await nextRequest(seen);
		await h.phone.value({
			kind: "vault_answer",
			requestId: request.requestId,
			decision: "once",
			value: h.phone.seal("fr0m-ph0ne", vaultAadKind(VAULT_TYPED_KIND, request.requestId)),
		});
		expect(await held).toEqual({ kind: "value", value: "fr0m-ph0ne", from: "phone" });

		let typed: (value: string | null) => void = () => undefined;
		const tty = {
			readSecret: () =>
				new Promise<string | null>((resolve) => {
					typed = resolve;
				}),
		};
		const raced = runAskpass({ cmdline: "sudo apt install bar", prompt: "x" }, { gateway, tty, now: Date.now });
		const second = await nextRequest(seen + 1);
		typed("fr0m-tty");
		expect(await raced).toEqual({ kind: "value", value: "fr0m-tty", from: "tty" });
		await retracted(second.requestId);
		// The withdrawn request refuses the phone's late answer.
		const late = await h.phone.value({
			kind: "vault_answer",
			requestId: second.requestId,
			decision: "once",
			value: h.phone.seal("late", vaultAadKind(VAULT_TYPED_KIND, second.requestId)),
		});
		expect(late.result).toMatchObject({ ok: false });
	});
});
