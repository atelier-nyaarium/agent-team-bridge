import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { createBoardService } from "../federation-server/board/boardService.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { type BlobReference, formatBlobReference } from "../shared/blob-reference.js";
import { blobIdFor } from "../shared/blob-store.js";
import { BOARD_BODY_KIND, BOARD_NAME_KIND, BOARD_TITLE_KIND, type BoardTextKind } from "../shared/content-envelope.js";
import { generateIdentity } from "../shared/crypto.js";
import type { InboxAddress, InboxRow } from "../shared/schemasInbox.js";
import { sealBlobChunk } from "../shared/sealed-blob.js";

const roots: string[] = [];
const envelope = (kind: BoardTextKind = BOARD_TITLE_KIND) => ({
	v: 1 as const,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.alloc(16).toString("base64"),
	kind,
});
type ReferenceHeld = {
	has(domainId: string, blobId: string): boolean;
	applyRefs(domainId: string, sets: readonly { ref: BlobReference; blobIds: readonly string[] }[]): void;
};
const make = (sessionExists = true, referenceHeld?: ReferenceHeld, useRealInbox = false) => {
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
	const router = generateIdentity();
	const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
	const rows: Array<{ address: InboxAddress; row: InboxRow }> = [];
	const delivered: Array<{ address: InboxAddress; row: InboxRow }> = [];
	const references = new Set<string>();
	const memberships = new Map<string, Set<string>>();
	const service = createBoardService({
		registry,
		inbox: {
			hasSession: (domainId, gatewayId, sessionId) =>
				useRealInbox ? inbox.hasSession(domainId, gatewayId, sessionId) : sessionExists,
			appendRouterRow: (input) => {
				if (useRealInbox) {
					const result = inbox.appendRouterRow(input);
					if (result.row) rows.push({ address: input.address, row: result.row });
					return result;
				}
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
		referenceHeld: referenceHeld ?? {
			has: (_domainId, blobId) => blobId !== "missing" && references.has(blobId),
			applyRefs: (_domainId, sets) => {
				const desired = new Map<string, Set<string>>();
				for (const set of sets) desired.set(formatBlobReference(set.ref), new Set(set.blobIds));
				const affected = new Set<string>(desired.values().flatMap((blobIds) => [...blobIds]));
				for (const [blobId, refs] of memberships) {
					if ([...desired.keys()].some((entryId) => refs.has(entryId))) affected.add(blobId);
				}
				for (const blobId of affected) {
					const refs = memberships.get(blobId) ?? new Set<string>();
					for (const entryId of desired.keys()) refs.delete(entryId);
					for (const [entryId, blobIds] of desired) if (blobIds.has(blobId)) refs.add(entryId);
					if (refs.size === 0) {
						memberships.delete(blobId);
						references.delete(blobId);
					} else {
						memberships.set(blobId, refs);
						references.add(blobId);
					}
				}
			},
		},
	});
	return { service, registry, rows, delivered, references, inbox };
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
		const first = service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		expect(first.outcome).toBe("applied");
		expect(first.revision).toBe(1);
		expect(service.write("a", { expectedRevision: 0, ops: [entry("two")] }, { kind: "owner" }).outcome).toBe(
			"conflict",
		);
		registry.close();
	});

	it("replays an applied write once per session actor", () => {
		const { service, registry } = make();
		const write = { expectedRevision: 0, ops: [entry("one")] };
		const first = service.write("a", write, { kind: "owner" }, "op-1");
		const second = service.write("a", write, { kind: "owner" }, "op-1");
		expect(second).toMatchObject({ outcome: "applied", revision: first.revision });
		expect(service.read("a").revision).toBe(1);
		registry.close();
	});

	it("replays a refusal and leaves conflicts retryable", () => {
		const { service, registry } = make();
		const refused = { expectedRevision: 0, ops: [{ kind: "remove" as const, id: "missing" }] };
		const firstRefusal = service.write("a", refused, { kind: "owner" }, "op-refused");
		const secondRefusal = service.write("a", refused, { kind: "owner" }, "op-refused");
		expect(secondRefusal).toMatchObject(firstRefusal);
		service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		const conflict = service.write(
			"a",
			{ expectedRevision: 0, ops: [entry("two")] },
			{ kind: "owner" },
			"op-conflict",
		);
		expect(conflict.outcome).toBe("conflict");
		const retry = service.write(
			"a",
			{ expectedRevision: 1, ops: [entry("two")] },
			{ kind: "owner" },
			"op-conflict",
		);
		expect(retry.outcome).toBe("applied");
		registry.close();
	});

	it("rejects a different write under a settled operation id", () => {
		const { service, registry } = make();
		service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" }, "op-1");
		const result = service.write(
			"a",
			{ expectedRevision: 1, ops: [{ kind: "set_state", id: "one", state: "done" }] },
			{ kind: "owner" },
			"op-1",
		);
		expect(result).toMatchObject({ outcome: "refused", refusal: "operation_id_reused" });
		expect(service.read("a").entries[0]?.clear.state).toBe("open");
		registry.close();
	});

	it("keeps attachment bytes when membership overlaps", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-board-held-"));
		roots.push(root);
		const held = new ReferenceHeldStore({ dataDir: root });
		const wrap: ReferenceHeld = {
			has: (domainId, blobId) => held.has(domainId, blobId),
			applyRefs: (domainId, sets) => held.applyRefs(domainId, sets),
		};
		const { service, registry } = make(true, wrap);
		const bytesA = Buffer.from("A");
		const bytesB = Buffer.from("B");
		const blobA = blobIdFor(bytesA);
		const blobB = blobIdFor(bytesB);
		held.applyRefs("a", [{ ref: { kind: "entry", entryId: "one" }, blobIds: [blobA, blobB] }]);
		for (const [blobId, bytes] of [
			[blobA, bytesA],
			[blobB, bytesB],
		] as const) {
			const ciphertext = sealBlobChunk(
				bytes,
				Buffer.alloc(32, 1),
				{ domainId: "a", ownerSignPub: "owner", epoch: 1, blobId },
				0,
				true,
			);
			const digest = `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`;
			const lease = held.begin("a", blobId, bytes.length, ciphertext.length, digest, 1);
			if (lease.kind !== "lease") throw new Error("expected lease");
			held.commitChunk("a", blobId, lease.lease, 0, ciphertext, true);
		}
		const attachment = (blobId: string) => ({ blobId, size: 1, mime: "text/plain", blobGateway: "g" });
		service.write(
			"a",
			{ expectedRevision: 0, ops: [entry("one", { attachments: [attachment(blobA)] })] },
			{ kind: "owner" },
		);
		service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "set_attachments", id: "one", attachments: [attachment(blobA), attachment(blobB)] }],
			},
			{ kind: "owner" },
		);
		expect(held.has("a", blobA)).toBe(true);
		registry.close();
	});

	it("keeps attachment bytes when one blob moves between entries in a single write", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-board-move-"));
		roots.push(root);
		const held = new ReferenceHeldStore({ dataDir: root });
		const wrap: ReferenceHeld = {
			has: (domainId, blobId) => held.has(domainId, blobId),
			applyRefs: (domainId, sets) => held.applyRefs(domainId, sets),
		};
		const { service, registry } = make(true, wrap);
		const bytes = Buffer.from("moved");
		const blob = blobIdFor(bytes);
		held.applyRefs("a", [{ ref: { kind: "entry", entryId: "one" }, blobIds: [blob] }]);
		const ciphertext = sealBlobChunk(
			bytes,
			Buffer.alloc(32, 1),
			{ domainId: "a", ownerSignPub: "owner", epoch: 1, blobId: blob },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`;
		const lease = held.begin("a", blob, bytes.length, ciphertext.length, digest, 1);
		if (lease.kind !== "lease") throw new Error("expected lease");
		held.commitChunk("a", blob, lease.lease, 0, ciphertext, true);
		const attachment = { blobId: blob, size: bytes.length, mime: "text/plain", blobGateway: "g" };
		service.write(
			"a",
			{ expectedRevision: 0, ops: [entry("one", { attachments: [attachment] }), entry("two")] },
			{ kind: "owner" },
		);

		service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{ kind: "set_attachments", id: "one", attachments: [] },
					{ kind: "set_attachments", id: "two", attachments: [attachment] },
				],
			},
			{ kind: "owner" },
		);

		expect(held.has("a", blob)).toBe(true);
		registry.close();
	});

	it.each([
		"durability_failure",
		"quarantined",
	])("refuses storage outcome %s without reporting a conflict", (kind) => {
		const { service, registry } = make();
		const store = registry.for("a");
		vi.spyOn(store, "batch").mockReturnValue({ kind } as never);
		const result = service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		expect(result).toMatchObject({ outcome: "refused", refusal: "durability_failure" });
		registry.close();
	});

	it("answers applied when only the fsync was in doubt, since the batch was already applied", () => {
		const { service, registry } = make();
		const store = registry.for("a");
		vi.spyOn(store, "batch").mockReturnValue({ kind: "durability_uncertain" } as never);
		const result = service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		expect(result).toMatchObject({ outcome: "applied" });
		registry.close();
	});

	it("allows a session to write its held entry", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "set_state", id: "one", state: "done" }],
			},
			{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
		);
		expect(result.outcome).toBe("applied");
		registry.close();
	});

	it("allows a session to claim an unheld entry", () => {
		const { service, registry } = make();
		service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "set_session", id: "one", session: { domainId: "a", gatewayId: "g", sessionId: "s" } }],
			},
			{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
		);
		expect(result.outcome).toBe("applied");
		expect(service.read("a").entries[0]?.clear.session).toEqual({ domainId: "a", gatewayId: "g", sessionId: "s" });
		registry.close();
	});

	it("allows a session to release its entry to the backlog", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{ expectedRevision: 1, ops: [{ kind: "set_session", id: "one" }] },
			{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
		);
		expect(result.outcome).toBe("applied");
		expect(service.read("a").entries[0]?.clear.session).toBeUndefined();
		registry.close();
	});

	it("refuses a session claim on another session's entry", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "held" } })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{ kind: "set_session", id: "one", session: { domainId: "a", gatewayId: "g", sessionId: "other" } },
				],
			},
			{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "other" } },
		);
		expect(result).toMatchObject({ outcome: "refused", refusal: "held" });
		registry.close();
	});

	it("refuses invalid ranks on rank and parent updates", () => {
		const { service, registry } = make();
		service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		expect(
			service.write(
				"a",
				{ expectedRevision: 1, ops: [{ kind: "set_rank", id: "one", rank: "0" }] },
				{ kind: "owner" },
			),
		).toMatchObject({ outcome: "refused", refusal: "bad_rank" });
		expect(
			service.write(
				"a",
				{ expectedRevision: 1, ops: [{ kind: "set_parent", id: "one", parent: undefined, rank: "!" }] },
				{ kind: "owner" },
			),
		).toMatchObject({ outcome: "refused", refusal: "bad_rank" });
		registry.close();
	});

	it("refuses assignments to missing sessions", () => {
		const { service, registry } = make(false);
		const assigned = { domainId: "a", gatewayId: "g", sessionId: "missing" };
		expect(
			service.write("a", { expectedRevision: 0, ops: [entry("one", { session: assigned })] }, { kind: "owner" }),
		).toMatchObject({
			outcome: "refused",
			refusal: "session_missing",
		});
		service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		expect(
			service.write(
				"a",
				{ expectedRevision: 1, ops: [{ kind: "set_session", id: "one", session: assigned }] },
				{ kind: "owner" },
			),
		).toMatchObject({ outcome: "refused", refusal: "session_missing" });
		registry.close();
	});

	it("allows the owner to reassign an entry", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "first" } })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{ kind: "set_session", id: "one", session: { domainId: "a", gatewayId: "g", sessionId: "second" } },
				],
			},
			{ kind: "owner" },
		);
		expect(result.outcome).toBe("applied");
		expect(service.read("a").entries[0]?.clear.session).toEqual({
			domainId: "a",
			gatewayId: "g",
			sessionId: "second",
		});
		registry.close();
	});

	it("keeps Domains isolated", () => {
		const { service, registry } = make();
		service.write("a", { expectedRevision: 0, ops: [entry("one")] }, { kind: "owner" });
		expect(service.read("b").entries).toHaveLength(0);
		registry.close();
	});

	it("refuses a session write to another session's entry and parent cycles", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		expect(
			service.write(
				"a",
				{
					expectedRevision: 1,
					ops: [{ kind: "set_state", id: "one", state: "done" }],
				},
				{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "other" } },
			).outcome,
		).toBe("refused");
		const cycle = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{ ...entry("two"), parent: "one" },
					{ kind: "set_parent", id: "one", parent: "two", rank: "B" },
				],
			},
			{ kind: "owner" },
		);
		expect(cycle.outcome).toBe("refused");
		registry.close();
	});

	it("cascades the parent when its last child finishes", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("parent"), entry("child", { parent: "parent", rank: "B" })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "set_state", id: "child", state: "done" }],
			},
			{ kind: "owner" },
		);
		expect(result.cascaded).toEqual([{ id: "parent", from: "open", to: "done", reason: "children_finished" }]);
		registry.close();
	});

	it("records sealed pre and post observations for another holder only", () => {
		const { service, registry, rows } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		rows.length = 0;
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "set_state", id: "one", state: "done" }],
			},
			{ kind: "owner" },
		);
		expect(result.outcome).toBe("applied");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.address).toEqual({ kind: "session", domainId: "a", gatewayId: "g", sessionId: "s" });
		expect(rows[0]?.row.body).toMatchObject({ identity: "one" });
		expect((rows[0]?.row.body as { pre: { sealed: unknown } }).pre.sealed).toEqual({ title: envelope() });
		expect((rows[0]?.row.body as { post: { sealed: unknown } }).post.sealed).toEqual({ title: envelope() });
		rows.length = 0;
		const self = service.write(
			"a",
			{
				expectedRevision: 2,
				ops: [{ kind: "set_state", id: "one", state: "in_progress" }],
			},
			{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
		);
		expect(self.outcome).toBe("applied");
		expect(rows).toHaveLength(0);
		registry.close();
	});

	it("round-trips every sealed upsert field through read", () => {
		const { service, registry } = make();
		const title = envelope();
		const body = envelope(BOARD_BODY_KIND);
		const names = { alice: envelope(BOARD_NAME_KIND), bob: envelope(BOARD_NAME_KIND) };
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { title, body, names })],
			},
			{ kind: "owner" },
		);
		expect(service.read("a").entries[0]?.sealed).toEqual({ title, body, names });
		registry.close();
	});

	it("keeps names only for blobs retained by an unnamed upsert", () => {
		const { service, registry, references } = make();
		references.add("keep");
		references.add("drop");
		const attachments = (blobId: string) => ({ blobId, size: 1, mime: "text/plain", blobGateway: "g" });
		const names = { keep: envelope(BOARD_NAME_KIND), drop: envelope(BOARD_NAME_KIND) };
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { attachments: [attachments("keep"), attachments("drop")], names })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [entry("one", { title: envelope(), attachments: [attachments("drop")] })],
			},
			{ kind: "owner" },
		);
		expect(result.outcome).toBe("applied");
		expect(service.read("a").entries[0]?.sealed.names).toEqual({ drop: names.drop });
		registry.close();
	});

	it("requires held attachments and replaces their entry references", () => {
		const { service, registry, references } = make();
		references.add("old");
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [
					entry("one", { attachments: [{ blobId: "old", size: 1, mime: "text/plain", blobGateway: "g" }] }),
				],
			},
			{ kind: "owner" },
		);
		const refused = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{
						kind: "set_attachments",
						id: "one",
						attachments: [{ blobId: "missing", size: 1, mime: "text/plain", blobGateway: "g" }],
					},
				],
			},
			{ kind: "owner" },
		);
		expect(refused.outcome).toBe("refused");
		references.add("new");
		const applied = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{
						kind: "set_attachments",
						id: "one",
						attachments: [{ blobId: "new", size: 2, mime: "text/plain", blobGateway: "g" }],
					},
				],
			},
			{ kind: "owner" },
		);
		expect(applied.outcome).toBe("applied");
		expect(references.has("new")).toBe(true);
		expect(references.has("old")).toBe(false);
		registry.close();
	});

	it("does not move references for a refused write", () => {
		const { service, registry, references } = make();
		references.add("blob");
		const result = service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [
					entry("one", { attachments: [{ blobId: "blob", size: 1, mime: "text/plain", blobGateway: "g" }] }),
					{ kind: "remove", id: "missing" },
				],
			},
			{ kind: "owner" },
		);
		expect(result.outcome).toBe("refused");
		expect(references.has("blob")).toBe(true);
		registry.close();
	});

	it("holds every attachment on an applied upsert", () => {
		const { service, registry, references } = make();
		references.add("one");
		references.add("two");
		const result = service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [
					entry("one", {
						attachments: [
							{ blobId: "one", size: 1, mime: "text/plain", blobGateway: "g" },
							{ blobId: "two", size: 2, mime: "text/plain", blobGateway: "g" },
						],
					}),
				],
			},
			{ kind: "owner" },
		);
		expect(result.outcome).toBe("applied");
		expect(references.has("one")).toBe(true);
		expect(references.has("two")).toBe(true);
		registry.close();
	});

	it("refuses set_parent under a parent the session cannot write", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [
					entry("parent", { session: { domainId: "a", gatewayId: "g", sessionId: "other" } }),
					entry("child", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } }),
				],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "set_parent", id: "child", parent: "parent", rank: "A" }],
			},
			{ kind: "session", session: { domainId: "a", gatewayId: "g", sessionId: "s" } },
		);
		expect(result.outcome).toBe("refused");
		registry.close();
	});

	it("refuses removing a parent with live children", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("parent"), entry("child", { parent: "parent", rank: "B" })],
			},
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "remove", id: "parent" }],
			},
			{ kind: "owner" },
		);
		expect(result).toMatchObject({ outcome: "refused", refusal: "would_orphan" });
		registry.close();
	});

	it("removes a parent with its whole subtree", () => {
		const { service, registry } = make();
		service.write(
			"a",
			{ expectedRevision: 0, ops: [entry("parent"), entry("child", { parent: "parent", rank: "B" })] },
			{ kind: "owner" },
		);
		const result = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [
					{ kind: "remove", id: "parent" },
					{ kind: "remove", id: "child" },
				],
			},
			{ kind: "owner" },
		);
		expect(result.outcome).toBe("applied");
		expect(service.read("a").entries).toHaveLength(0);
		registry.close();
	});

	it("observes one row for each of two parties", () => {
		const { service, registry, rows } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "first" } })],
			},
			{ kind: "owner" },
		);
		rows.length = 0;
		service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "second" } })],
			},
			{ kind: "owner" },
		);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map(({ row }) => row.envelope.opKey.opId)).size).toBe(2);
		registry.close();
	});

	it("delivers every accepted observation row", () => {
		const { service, registry, rows, delivered } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		expect(delivered).toHaveLength(rows.length);
		expect(delivered[0]?.row.envelope.opKey).toEqual(rows[0]?.row.envelope.opKey);
		registry.close();
	});

	it("writes observations to a registered sleeping session inbox", () => {
		const { service, registry, inbox } = make(true, undefined, true);
		inbox.upsertSession("a", "g", "s", { kind: "session", label: "sleeping", recordExists: true });
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		const rows = inbox.rows({ kind: "session", domainId: "a", gatewayId: "g", sessionId: "s" }, 1, 10);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.envelope.kind).toBe("board_observation");
		registry.close();
	});

	it("sweeps expired trash and releases its blobs", () => {
		const { service, registry, references } = make();
		references.add("blob");
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [
					entry("one", { attachments: [{ blobId: "blob", size: 1, mime: "text/plain", blobGateway: "g" }] }),
				],
			},
			{ kind: "owner" },
		);
		const trashed = service.write(
			"a",
			{
				expectedRevision: 1,
				ops: [{ kind: "trash", id: "one" }],
			},
			{ kind: "owner" },
		);
		expect(trashed.outcome).toBe("applied");
		expect(service.sweepTrash("a", 100 + 30 * 24 * 60 * 60 * 1000 + 1)).toBe(1);
		expect(service.read("a").entries).toHaveLength(0);
		expect(references.has("blob")).toBe(false);
		registry.close();
	});

	it("uses registration and frame session identity for board operations", async () => {
		const { service, registry } = make();
		service.write(
			"a",
			{
				expectedRevision: 0,
				ops: [entry("one", { session: { domainId: "a", gatewayId: "g", sessionId: "s" } })],
			},
			{ kind: "owner" },
		);
		let handler: ((reg: unknown, params: Record<string, unknown>) => unknown) | undefined;
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name, registered) => {
				if (name === "board_op") handler = registered as typeof handler;
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
			gatewayFrame: (name, registered) => {
				if (name === "board_op") handler = registered as typeof handler;
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
					write: { expectedRevision: 0, ops: [entry("one")] },
				},
			),
		).toThrow();
		registry.close();
	});

	it("returns durability uncertainty for a quarantined board read", () => {
		const { service, registry } = make();
		const store = registry.for("a");
		vi.spyOn(store, "get").mockImplementation(() => {
			throw new OwnerQuarantined({ from: 2, to: 3 });
		});
		let handler: ((reg: unknown, params: Record<string, unknown>) => unknown) | undefined;
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name, registered) => {
				if (name === "board_read") handler = registered as typeof handler;
			},
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => false,
			gatewayIncarnation: () => null,
			connectedGateways: () => [],
		});
		expect(handler?.({ domainId: "a" }, {})).toEqual({ outcome: "durability_uncertain" });
		registry.close();
	});
});
