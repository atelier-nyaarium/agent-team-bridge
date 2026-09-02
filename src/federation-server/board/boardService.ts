import { type BoardActor, mayWrite } from "../../shared/board-authority.js";
import { applyCascade } from "../../shared/board-cascade.js";
import { observationsFor } from "../../shared/board-observations.js";
import { isValidRank } from "../../shared/board-rank.js";
import {
	BOARD_TRASH_TTL_MS,
	MAX_ENTRIES_PER_OWNER,
	orphanedParents,
	promoteOrphans,
} from "../../shared/board-structure.js";
import { sha256Hex } from "../../shared/canonical-json.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import {
	BoardOpParamsSchema,
	type BoardStoredEntry,
	type BoardWrite,
	BoardWriteSchema,
} from "../../shared/schemasBoardState.js";
import type { InboxAddress, InboxRow } from "../../shared/schemasInbox.js";
import type { InboxService } from "../inbox/inboxService.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { GatewayRegistration, OwnerServiceHooks } from "../ownerServiceHooks.js";

type RefHeld = {
	has(domainId: string, blobId: string): boolean;
	hold(domainId: string, blobId: string, entryId: string): void;
	release(domainId: string, blobId: string, entryId: string): void;
};
type Deps = {
	registry: OwnerStoreRegistry;
	inbox: Pick<InboxService, "appendRouterRow" | "hasSession">;
	referenceHeld: RefHeld;
	/** Deliver accepted observations or mark them waking. */
	deliver?: (domainId: string, address: InboxAddress, row: InboxRow) => void;
	now?: () => number;
};
type Board = { revision: number; entries: Map<string, BoardEntry> };
type RefChange = { action: "hold" | "release"; blobId: string; entryId: string };
const key = (s: { domainId: string; gatewayId: string; sessionId: string }) =>
	`${s.domainId}/${s.gatewayId}/${s.sessionId}`;
const parseKey = (value: string) => {
	const [domainId, gatewayId, ...rest] = value.split("/");
	return { domainId, gatewayId, sessionId: rest.join("/") };
};
const actor = (a: BoardWrite["actor"]): BoardActor =>
	a.kind === "owner" ? { kind: "owner" } : { kind: "session", sessionId: key(a.session) };
const copy = (b: Board): Board => ({
	revision: b.revision,
	entries: new Map([...b.entries].map(([id, e]) => [id, structuredClone(e)])),
});
type Versioned = BoardEntry & { version?: number; sealed?: BoardStoredEntry["sealed"] };

export function createBoardService(deps: Deps) {
	const now = deps.now ?? (() => deps.registry.now());
	const load = (domainId: string): Board => {
		const store = deps.registry.for(domainId);
		const meta = store.get("board.meta", "board.meta");
		const entries = new Map<string, BoardEntry>();
		for (const record of store.list("board.entry"))
			entries.set(record.clear.id as string, fromStored(record as unknown as BoardStoredEntry, record.version));
		return { revision: Number(meta?.clear.revision ?? 0), entries };
	};
	const stored = (e: BoardEntry): BoardStoredEntry => ({
		clear: {
			id: e.id,
			state: e.state,
			...(e.parent ? { parent: e.parent } : {}),
			rank: e.rank,
			...(e.sessionId ? { session: parseKey(e.sessionId) } : {}),
			...(e.trashedAt === undefined ? {} : { trashedAt: e.trashedAt }),
			...(e.attachments
				? {
						attachments: e.attachments.map(({ blobId, size, mime, blobGateway }) => ({
							blobId,
							size,
							mime,
							blobGateway,
						})),
					}
				: {}),
			version: Number((e as Versioned).version ?? 1),
		},
		// Preserve every sealed field. The Router never opens them.
		sealed: { ...((e as Versioned).sealed as BoardStoredEntry["sealed"]) },
	});
	const fromStored = (r: BoardStoredEntry, version = r.clear.version): BoardEntry =>
		({
			id: r.clear.id,
			state: r.clear.state,
			rank: r.clear.rank,
			...(r.clear.parent ? { parent: r.clear.parent } : {}),
			...(r.clear.session ? { sessionId: key(r.clear.session) } : {}),
			...(r.clear.trashedAt === undefined ? {} : { trashedAt: r.clear.trashedAt }),
			...(r.clear.attachments ? { attachments: r.clear.attachments } : {}),
			title: "",
			version,
			...(r.sealed.title ? { sealed: r.sealed } : {}),
		}) as unknown as BoardEntry;
	const read = (domainId: string) => {
		const b = load(domainId);
		return { revision: b.revision, entries: [...b.entries.values()].map(stored) };
	};
	const attachmentsHeld = (domainId: string, attachments: { blobId: string }[]): boolean =>
		attachments.every((x) => deps.referenceHeld.has(domainId, x.blobId));
	const write = (domainId: string, input: BoardWrite) => {
		const before = load(domainId);
		const answerBefore = () => [...before.entries.values()].map(stored);
		if (input.expectedRevision !== before.revision)
			return { outcome: "conflict" as const, revision: before.revision, entries: answerBefore(), cascaded: [] };
		const next = copy(before);
		const touched = new Set<string>();
		const a = actor(input.actor);
		// Apply reference changes only after the batch succeeds.
		const refChanges: RefChange[] = [];
		const refuse = (reason: string) => ({
			outcome: "refused" as const,
			revision: before.revision,
			entries: answerBefore(),
			cascaded: [],
			refusal: reason,
		});
		const replaceAttachments = (e: BoardEntry, attachments: NonNullable<BoardEntry["attachments"]>) => {
			for (const x of e.attachments ?? [])
				refChanges.push({ action: "release", blobId: x.blobId, entryId: e.id });
			for (const x of attachments) refChanges.push({ action: "hold", blobId: x.blobId, entryId: e.id });
			e.attachments = attachments;
		};
		for (const op of input.ops) {
			const e = next.entries.get(op.id);
			if (op.kind === "upsert") {
				if (!e && next.entries.size >= MAX_ENTRIES_PER_OWNER) return refuse("board_full");
				const denied = e ? mayWrite(e, a) : null;
				if (denied) return refuse(denied);
				if (op.parent) {
					const parent = next.entries.get(op.parent);
					if (!parent) return refuse("parent_missing");
					const parentDenied = mayWrite(parent, a);
					if (parentDenied) return refuse(parentDenied);
				}
				if (!isValidRank(op.rank)) return refuse("bad_rank");
				if (op.attachments && !attachmentsHeld(domainId, op.attachments)) return refuse("attachment_missing");
				const entry = {
					...(e ?? {}),
					id: op.id,
					state: op.state ?? e?.state ?? "open",
					rank: op.rank,
					title: "",
					...(op.parent ? { parent: op.parent } : {}),
					...(op.session ? { sessionId: key(op.session) } : {}),
					...(op.trashedAt === undefined ? {} : { trashedAt: op.trashedAt }),
					sealed: {
						title: op.title,
						...(op.body ? { body: op.body } : {}),
						...(op.names ? { names: op.names } : {}),
					},
				} as BoardEntry;
				if (op.attachments)
					replaceAttachments(entry, op.attachments as unknown as NonNullable<BoardEntry["attachments"]>);
				next.entries.set(op.id, entry);
				touched.add(op.id);
			} else if (op.kind === "remove") {
				if (!e) return refuse("entry_missing");
				const denied = mayWrite(e, a);
				if (denied) return refuse(denied);
				for (const x of e.attachments ?? [])
					refChanges.push({ action: "release", blobId: x.blobId, entryId: e.id });
				next.entries.delete(op.id);
				touched.add(op.id);
			} else {
				if (!e) return refuse("entry_missing");
				const denied = mayWrite(e, a);
				if (denied) return refuse(denied);
				if (op.kind === "set_state") e.state = op.state;
				else if (op.kind === "set_parent") {
					if (op.parent) {
						const parent = next.entries.get(op.parent);
						if (!parent) return refuse("parent_missing");
						const parentDenied = mayWrite(parent, a);
						if (parentDenied) return refuse(parentDenied);
					}
					e.parent = op.parent;
					e.rank = op.rank;
				} else if (op.kind === "set_rank") e.rank = op.rank;
				else if (op.kind === "set_attachments") {
					if (!attachmentsHeld(domainId, op.attachments)) return refuse("attachment_missing");
					replaceAttachments(e, op.attachments as unknown as NonNullable<BoardEntry["attachments"]>);
				} else if (op.kind === "trash") e.trashedAt = now();
				else delete e.trashedAt;
				touched.add(op.id);
			}
		}
		// Removed parents promote their children and count as touched.
		const parentsBefore = new Map([...next.entries].map(([id, e]) => [id, e.parent]));
		promoteOrphans(next.entries);
		for (const [id, e] of next.entries) if (parentsBefore.get(id) !== e.parent) touched.add(id);
		for (const id of touched) {
			let cur: string | undefined = id;
			const seen = new Set<string>();
			while (cur) {
				if (seen.has(cur)) return refuse("cycle");
				seen.add(cur);
				cur = next.entries.get(cur)?.parent;
			}
		}
		const cascaded = applyCascade(next.entries, [...touched], orphanedParents(before, next, touched));
		for (const c of cascaded) touched.add(c.id);
		next.revision++;
		const store = deps.registry.for(domainId);
		const meta = store.get("board.meta", "board.meta");
		for (const id of touched) {
			const e = next.entries.get(id) as Versioned | undefined;
			if (e) e.version = Number(store.get("board.entry", id)?.version ?? 0) + 1;
		}
		const result = store.batch((tx) => {
			for (const id of touched) {
				const old = store.get("board.entry", id);
				const e = next.entries.get(id);
				if (e) tx.put("board.entry", id, old?.version ?? null, stored(e) as never);
				else if (old) tx.del("board.entry", id, old.version);
			}
			tx.put("board.meta", "board.meta", meta?.version ?? null, { clear: { revision: next.revision } });
		});
		if (result.kind !== "ok")
			return { outcome: "conflict" as const, revision: before.revision, entries: answerBefore(), cascaded: [] };
		for (const change of refChanges) {
			if (change.action === "hold") deps.referenceHeld.hold(domainId, change.blobId, change.entryId);
			else deps.referenceHeld.release(domainId, change.blobId, change.entryId);
		}
		for (const o of observationsFor(before, next, touched, a)) {
			const s = parseKey(o.sessionKey);
			if (!deps.inbox.hasSession(domainId, s.gatewayId, s.sessionId)) continue;
			const address: InboxAddress = { kind: "session", domainId, gatewayId: s.gatewayId, sessionId: s.sessionId };
			// Keep one row per party, entry, and revision.
			const appended = deps.inbox.appendRouterRow({
				address,
				kind: "board_observation",
				opKey: {
					conversationId: "board",
					opId: `${next.revision}-${o.identity}-${sha256Hex(o.sessionKey).slice(0, 16)}`,
				},
				body: { identity: o.identity, pre: o.pre ? stored(o.pre) : null, post: o.post ? stored(o.post) : null },
			});
			if (appended.row) deps.deliver?.(domainId, address, appended.row);
			else if (appended.outcome !== "accepted")
				console.warn(`[board] observation for ${o.sessionKey} not written: ${appended.outcome}`);
		}
		return {
			outcome: "applied" as const,
			revision: next.revision,
			entries: [...next.entries.values()].map(stored),
			cascaded: cascaded.map(({ id, from, to, reason }) => ({ id, from, to, reason })),
		};
	};
	const sweepTrash = (domainId: string, at = now()) => {
		const b = load(domainId);
		const dead = [...b.entries.values()].filter(
			(e) => e.trashedAt !== undefined && at - e.trashedAt > BOARD_TRASH_TTL_MS,
		);
		if (!dead.length) return 0;
		const result = write(domainId, {
			expectedRevision: b.revision,
			actor: { kind: "owner" },
			ops: dead.map((e) => ({ kind: "remove", id: e.id })),
		});
		return result.outcome === "applied" ? dead.length : 0;
	};
	const register = (hooks: OwnerServiceHooks) => {
		hooks.ownerOp("board_write", (op, value) =>
			write(op.domainId, { ...BoardWriteSchema.parse(value.write ?? value), actor: { kind: "owner" } }),
		);
		hooks.ownerOp("board_read", (op) => read(op.domainId));
		// A gateway may act only for sessions in its registry.
		hooks.gatewayFrame("board_op", (reg: GatewayRegistration, params) => {
			const p = BoardOpParamsSchema.parse(params);
			if (!deps.inbox.hasSession(reg.domainId, reg.gatewayId, p.sessionId)) throw new OwnerOpRefused("session");
			return write(reg.domainId, {
				...p.write,
				actor: {
					kind: "session",
					session: { domainId: reg.domainId, gatewayId: reg.gatewayId, sessionId: p.sessionId },
				},
			});
		});
	};
	return { read, write, sweepTrash, register };
}
