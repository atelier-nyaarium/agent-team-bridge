import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardService } from "../federation-server/board/boardService.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { generateIdentity } from "../shared/crypto.js";
import type { InboxAddress, InboxRow } from "../shared/schemasInbox.js";

const roots: string[] = [];
const envelope = (kind: "board.title" | "board.body" | "board.name" = "board.title") => ({
	v: 1 as const,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.alloc(16).toString("base64"),
	kind,
});
const make = (sessionExists = true) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-board-"));
	roots.push(dataDir);
	const owners = new Map([
		["a", generateIdentity().sign.pub],
		["b", generateIdentity().sign.pub],
	]);
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (domainId) => owners.get(domainId) ?? null,
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: () => 100,
	});
	const rows: Array<{ address: InboxAddress; row: InboxRow }> = [];
	const delivered: Array<{ address: InboxAddress; row: InboxRow }> = [];
	const references = new Set<string>();
	const referenceCalls: Array<{ action: "hold" | "release"; blobId: string; entryId: string }> = [];
	const service = createBoardService({
		registry,
		inbox: {
			hasSession: () => sessionExists,
			appendRouterRow: (input) => {
				const row = {
					envelope: {
						origin: { kind: "router" as const, domainId: input.address.domainId },
						opKey: input.opKey,
						epoch: "clear" as const,
						kind: input.kind,
						contentRefs: input.contentRefs ?? [],
					},
					producerSig: "",
					body: input.body,
				} as InboxRow;
				rows.push({ address: input.address, row });
				return { outcome: "accepted" as const, opKey: input.opKey, row };
			},
		},
		deliver: (domainId, address, row) => delivered.push({ address: { ...address, domainId }, row }),
		referenceHeld: {
			has: (_domainId, blobId) => blobId !== "missing" && references.has(blobId),
			hold: (domainId, blobId, entryId) => {
				references.add(blobId);
				referenceCalls.push({ action: "hold", blobId, entryId });
			},
			release: (_domainId, blobId, entryId) => {
				references.delete(blobId);
				referenceCalls.push({ action: "release", blobId, entryId });
			},
		},
	});
	return { service, registry, rows, delivered, references, referenceCalls };
};
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
	kind: "upsert" as const,
	id,
	state: "open" as const,
	rank: "A",
	title: envelope(),
	...extra,
});

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("router board service", () => {
	it("persists owner writes and rejects stale revisions", () => {
		const { service, registry } = make();
		const first = service.write("a", { expectedRevision: 0, actor: { kind: "owner" }, ops: [entry("one")] });
		expect(first.outcome).toBe("applied");
		expect(first.revision).toBe(1);
		expect(service.write("a", { expectedRevision: 0, actor: { kind: "owner" }, ops: [entry("two")] }).outcome).toBe(
			"conflict",
		);
		registry.close();
	});

	it("allows a session to write its held entry", () => {
		const { service, registry } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
		});
		const result = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
			ops: [{ kind: "set_state", id: "one", state: "done" }],
		});
		expect(result.outcome).toBe("applied");
		registry.close();
	});

	it("keeps Domains isolated", () => {
		const { service, registry } = make();
		service.write("a", { expectedRevision: 0, actor: { kind: "owner" }, ops: [entry("one")] });
		expect(service.read("b").entries).toHaveLength(0);
		registry.close();
	});

	it("refuses a session write to another session's entry and parent cycles", () => {
		const { service, registry } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
		});
		expect(
			service.write("a", {
				expectedRevision: 1,
				actor: { kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "other" } },
				ops: [{ kind: "set_state", id: "one", state: "done" }],
			}).outcome,
		).toBe("refused");
		const cycle = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [
				{ ...entry("two"), parent: "one" },
				{ kind: "set_parent", id: "one", parent: "two", rank: "B" },
			],
		});
		expect(cycle.outcome).toBe("refused");
		registry.close();
	});

	it("cascades the parent when its last child finishes", () => {
		const { service, registry } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("parent"), entry("child", { parent: "parent", rank: "B" })],
		});
		const result = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [{ kind: "set_state", id: "child", state: "done" }],
		});
		expect(result.cascaded).toEqual([{ id: "parent", from: "open", to: "done", reason: "children_finished" }]);
		registry.close();
	});

	it("records sealed pre and post observations for another holder only", () => {
		const { service, registry, rows } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
		});
		rows.length = 0;
		const result = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [{ kind: "set_state", id: "one", state: "done" }],
		});
		expect(result.outcome).toBe("applied");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.address).toEqual({ kind: "session", domainId: "a", gatewayId: "g", sessionId: "s" });
		expect(rows[0]?.row.body).toMatchObject({ identity: "one" });
		expect((rows[0]?.row.body as { pre: { sealed: unknown } }).pre.sealed).toEqual({ title: envelope() });
		expect((rows[0]?.row.body as { post: { sealed: unknown } }).post.sealed).toEqual({ title: envelope() });
		rows.length = 0;
		const self = service.write("a", {
			expectedRevision: 2,
			actor: { kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
			ops: [{ kind: "set_state", id: "one", state: "in_progress" }],
		});
		expect(self.outcome).toBe("applied");
		expect(rows).toHaveLength(0);
		registry.close();
	});

	it("round-trips every sealed upsert field through read", () => {
		const { service, registry } = make();
		const title = envelope();
		const body = envelope("board.body");
		const names = { alice: envelope("board.name"), bob: envelope("board.name") };
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { title, body, names })],
		});
		expect(service.read("a").entries[0]?.sealed).toEqual({ title, body, names });
		registry.close();
	});

	it("requires held attachments and replaces their entry references", () => {
		const { service, registry, references, referenceCalls } = make();
		references.add("old");
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { attachments: [{ blobId: "old", size: 1, mime: "text/plain", blobGateway: "g" }] })],
		});
		const refused = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [
				{
					kind: "set_attachments",
					id: "one",
					attachments: [{ blobId: "missing", size: 1, mime: "text/plain", blobGateway: "g" }],
				},
			],
		});
		expect(refused.outcome).toBe("refused");
		references.add("new");
		const applied = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [
				{
					kind: "set_attachments",
					id: "one",
					attachments: [{ blobId: "new", size: 2, mime: "text/plain", blobGateway: "g" }],
				},
			],
		});
		expect(applied.outcome).toBe("applied");
		expect(referenceCalls.slice(-2)).toEqual([
			{ action: "release", blobId: "old", entryId: "one" },
			{ action: "hold", blobId: "new", entryId: "one" },
		]);
		registry.close();
	});

	it("does not move references for a refused write", () => {
		const { service, registry, references, referenceCalls } = make();
		references.add("blob");
		const result = service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [
				entry("one", { attachments: [{ blobId: "blob", size: 1, mime: "text/plain", blobGateway: "g" }] }),
				{ kind: "remove", id: "missing" },
			],
		});
		expect(result.outcome).toBe("refused");
		expect(referenceCalls).toEqual([]);
		expect(references.has("blob")).toBe(true);
		registry.close();
	});

	it("holds every attachment on an applied upsert", () => {
		const { service, registry, references, referenceCalls } = make();
		references.add("one");
		references.add("two");
		const result = service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [
				entry("one", {
					attachments: [
						{ blobId: "one", size: 1, mime: "text/plain", blobGateway: "g" },
						{ blobId: "two", size: 2, mime: "text/plain", blobGateway: "g" },
					],
				}),
			],
		});
		expect(result.outcome).toBe("applied");
		expect(referenceCalls).toEqual([
			{ action: "hold", blobId: "one", entryId: "one" },
			{ action: "hold", blobId: "two", entryId: "one" },
		]);
		registry.close();
	});

	it("refuses set_parent under a parent the session cannot write", () => {
		const { service, registry } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [
				entry("parent", { session: { domainId: "a", gatewayId: "g", sessionId: "other" } }),
				entry("child", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } }),
			],
		});
		const result = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
			ops: [{ kind: "set_parent", id: "child", parent: "parent", rank: "A" }],
		});
		expect(result.outcome).toBe("refused");
		registry.close();
	});

	it("removes a parent and promotes its children", () => {
		const { service, registry } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("parent"), entry("child", { parent: "parent", rank: "B" })],
		});
		const result = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [{ kind: "remove", id: "parent" }],
		});
		expect(result.outcome).toBe("applied");
		const child = service.read("a").entries.find((stored) => stored.clear.id === "child");
		expect(child?.clear.parent).toBeUndefined();
		expect(child?.clear.version).toBe(2);
		registry.close();
	});

	it("observes one row for each of two parties", () => {
		const { service, registry, rows } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "first" } })],
		});
		rows.length = 0;
		service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "second" } })],
		});
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map(({ row }) => row.envelope.opKey.opId)).size).toBe(2);
		registry.close();
	});

	it("delivers every accepted observation row", () => {
		const { service, registry, rows, delivered } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
		});
		expect(delivered).toHaveLength(rows.length);
		expect(delivered[0]?.row.envelope.opKey).toEqual(rows[0]?.row.envelope.opKey);
		registry.close();
	});

	it("sweeps expired trash and releases its blobs", () => {
		const { service, registry, references, referenceCalls } = make();
		references.add("blob");
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { attachments: [{ blobId: "blob", size: 1, mime: "text/plain", blobGateway: "g" }] })],
		});
		const trashed = service.write("a", {
			expectedRevision: 1,
			actor: { kind: "owner" },
			ops: [{ kind: "trash", id: "one" }],
		});
		expect(trashed.outcome).toBe("applied");
		expect(service.sweepTrash("a", 100 + 30 * 24 * 60 * 60 * 1000 + 1)).toBe(1);
		expect(service.read("a").entries).toHaveLength(0);
		expect(referenceCalls.at(-1)).toEqual({ action: "release", blobId: "blob", entryId: "one" });
		registry.close();
	});

	it("uses registration and frame session identity for board operations", async () => {
		const { service, registry } = make();
		service.write("a", {
			expectedRevision: 0,
			actor: { kind: "owner" },
			ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
		});
		let handler: ((reg: unknown, params: Record<string, unknown>) => unknown) | undefined;
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (_name, registered) => {
				handler = registered as typeof handler;
			},
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => false,
			gatewayIncarnation: () => null,
			connectedGateways: () => [],
		});
		const result = await handler?.(
			{ domainId: "a", gatewayId: "g", signPub: "pub", incarnation: 1 },
			{
				incarnation: 1,
				sessionId: "other",
				write: {
					expectedRevision: 1,
					actor: { kind: "owner" },
					ops: [{ kind: "set_state", id: "one", state: "done" }],
				},
			},
		);
		expect((result as { outcome: string }).outcome).toBe("refused");
		registry.close();
	});

	it("refuses board_op for an unknown session", async () => {
		const { service, registry } = make(false);
		let handler: ((reg: unknown, params: Record<string, unknown>) => unknown) | undefined;
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (_name, registered) => {
				handler = registered as typeof handler;
			},
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => false,
			gatewayIncarnation: () => null,
			connectedGateways: () => [],
		});
		expect(() =>
			handler?.(
				{ domainId: "a", gatewayId: "g", signPub: "pub", incarnation: 1 },
				{
					incarnation: 1,
					sessionId: "unknown",
					write: { expectedRevision: 0, actor: { kind: "owner" }, ops: [entry("one")] },
				},
			),
		).toThrow();
		registry.close();
	});
});
