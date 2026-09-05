import { z } from "zod";
import type { BlobReference } from "../../shared/blob-reference.js";
import { type BoardActor, mayTake, mayWrite } from "../../shared/board-authority.js";
import { applyCascade } from "../../shared/board-cascade.js";
import { observationsFor } from "../../shared/board-observations.js";
import { isValidRank } from "../../shared/board-rank.js";
import {
	BOARD_TRASH_TTL_MS,
	MAX_ENTRIES_PER_OWNER,
	orphanedParents,
	promoteOrphans,
	prunableSubtrees,
} from "../../shared/board-structure.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import {
	type BoardActorState,
	BoardOpParamsSchema,
	type BoardStoredEntry,
	type BoardWrite,
	BoardWriteSchema,
} from "../../shared/schemasBoardState.js";
import type { InboxAddress, InboxRow } from "../../shared/schemasInbox.js";
import { BOARD_OUTCOME_APPLIED, OP_OUTCOME_ACCEPTED } from "../../shared/wire-vocabulary.js";
import type { InboxService } from "../inbox/inboxService.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import type { GatewayRegistration, OwnerServiceHooks } from "../ownerServiceHooks.js";

type RefHeld = {
	has(domainId: string, blobId: string): boolean;
	applyRefs?(domainId: string, sets: readonly { ref: BlobReference; blobIds: readonly string[] }[]): void;
	[key: string]: unknown;
};
type Deps = {
	registry: OwnerStoreRegistry;
	inbox: Pick<InboxService, "appendRouterRow" | "hasSession">;
	referenceHeld: RefHeld;
	deliver?: (domainId: string, address: InboxAddress, row: InboxRow) => void;
	pokeOwner?: (domainId: string, revision: number) => void;
	now?: () => number;
};
type Board = { revision: number; entries: Map<string, BoardEntry> };
type BoardReplay = {
	hash: string;
	createdAt: number;
	outcome: "applied" | "refused";
	revision: number;
	cascaded: { id: string; from: BoardEntry["state"]; to: BoardEntry["state"]; reason: string }[];
	refusal?: string;
};
const BOARD_OP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BoardSessionEndParamsSchema = z.object({
	sessionId: z.string().min(1),
	disposition: z.enum(["release", "cancel"]),
});
/** Caller-minted ids require a count cap. */
const MAX_BOARD_OPS_PER_OWNER = 5000;
const key = (s: { domainId: string; gatewayId: string; sessionId: string }) =>
	`${s.domainId}/${s.gatewayId}/${s.sessionId}`;
const parseKey = (value: string) => {
	const [domainId, gatewayId, ...rest] = value.split("/");
	return { domainId, gatewayId, sessionId: rest.join("/") };
};
const actor = (a: BoardActorState): BoardActor =>
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
		// Preserve sealed fields. The Router never opens them.
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
	const write = (domainId: string, input: BoardWrite, writer: BoardActorState, opId?: string, at = now()) => {
		const store = deps.registry.for(domainId);
		const before = load(domainId);
		const answerBefore = () => [...before.entries.values()].map(stored);
		const a = actor(writer);
		const replayId = opId ? `${a.kind}:${a.kind === "owner" ? "owner" : a.sessionId}:${opId}` : undefined;
		// Replay hashes operation identity.
		const hash = sha256Hex(canonicalJson(input.ops.map((op) => [op.kind, op.id])));
		const replay = replayId ? store.get("board.op", replayId) : null;
		if (replay) {
			const recorded = replay.clear as unknown as BoardReplay;
			if (recorded.hash !== hash)
				return {
					outcome: "refused" as const,
					revision: before.revision,
					entries: answerBefore(),
					cascaded: [],
					refusal: "operation_id_reused",
				};
			return {
				outcome: recorded.outcome,
				revision: recorded.revision,
				entries: answerBefore(),
				cascaded: recorded.cascaded,
				...(recorded.refusal ? { refusal: recorded.refusal } : {}),
			};
		}
		if (input.expectedRevision !== before.revision)
			return { outcome: "conflict" as const, revision: before.revision, entries: answerBefore(), cascaded: [] };
		const next = copy(before);
		const touched = new Set<string>();
		// Apply references after commit.
		const removedIds = new Set(input.ops.filter((op) => op.kind === "remove").map((op) => op.id));
		const refuse = (reason: string) => ({
			outcome: "refused" as const,
			revision: before.revision,
			entries: answerBefore(),
			cascaded: [],
			refusal: reason,
		});
		const rememberRefusal = (reason: string): ReturnType<typeof refuse> => {
			const result = refuse(reason);
			if (replayId)
				store.put("board.op", replayId, null, {
					clear: {
						hash,
						createdAt: now(),
						outcome: result.outcome,
						revision: result.revision,
						cascaded: [],
						refusal: reason,
					},
				});
			return result;
		};
		const replaceAttachments = (e: BoardEntry, attachments: NonNullable<BoardEntry["attachments"]>) => {
			e.attachments = attachments;
		};
		for (const op of input.ops) {
			const e = next.entries.get(op.id);
			if (op.kind === "upsert") {
				if (!e && next.entries.size >= MAX_ENTRIES_PER_OWNER) return rememberRefusal("board_full");
				const denied = e ? mayWrite(e, a) : null;
				if (denied) return rememberRefusal(denied);
				if (op.parent) {
					const parent = next.entries.get(op.parent);
					if (!parent) return rememberRefusal("parent_missing");
					const parentDenied = mayWrite(parent, a);
					if (parentDenied) return rememberRefusal(parentDenied);
				}
				if (!isValidRank(op.rank)) return rememberRefusal("bad_rank");
				// Only owners assign holders.
				if (op.session) {
					if (
						op.session.domainId !== domainId ||
						!deps.inbox.hasSession(domainId, op.session.gatewayId, op.session.sessionId)
					)
						return rememberRefusal("session_missing");
					const takeDenied = e
						? mayTake(e, a, key(op.session))
						: a.kind === "owner" || a.sessionId === key(op.session)
							? undefined
							: "held";
					if (takeDenied) return rememberRefusal(takeDenied);
				}
				if (op.attachments && !attachmentsHeld(domainId, op.attachments))
					return rememberRefusal("attachment_missing");
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
						...(op.attachments
							? {
									names: Object.fromEntries(
										op.attachments.flatMap(({ blobId }) => {
											const name =
												op.names?.[blobId] ??
												(e as Versioned | undefined)?.sealed?.names?.[blobId];
											return name ? [[blobId, name]] : [];
										}),
									),
								}
							: op.names
								? { names: op.names }
								: (e as Versioned | undefined)?.sealed?.names
									? { names: (e as Versioned).sealed?.names }
									: {}),
					},
				} as BoardEntry;
				if (op.attachments)
					replaceAttachments(entry, op.attachments as unknown as NonNullable<BoardEntry["attachments"]>);
				next.entries.set(op.id, entry);
				touched.add(op.id);
			} else if (op.kind === "remove") {
				if (!e) return rememberRefusal("entry_missing");
				const denied = mayWrite(e, a);
				if (denied) return rememberRefusal(denied);
				const liveChildren = [...next.entries.values()].filter(
					(child) => child.parent === op.id && child.trashedAt === undefined,
				);
				if (liveChildren.some((child) => !removedIds.has(child.id))) return rememberRefusal("would_orphan");
				next.entries.delete(op.id);
				touched.add(op.id);
			} else if (op.kind === "set_session") {
				if (!e) return rememberRefusal("entry_missing");
				const next = op.session ? key(op.session) : undefined;
				if (
					op.session &&
					(op.session.domainId !== domainId ||
						!deps.inbox.hasSession(domainId, op.session.gatewayId, op.session.sessionId))
				)
					return rememberRefusal("session_missing");
				const denied = mayTake(e, a, next);
				if (denied) return rememberRefusal(denied);
				if (next === undefined) delete e.sessionId;
				else e.sessionId = next;
				touched.add(op.id);
			} else {
				if (!e) return rememberRefusal("entry_missing");
				const denied = mayWrite(e, a);
				if (denied) return rememberRefusal(denied);
				if (op.kind === "set_state") e.state = op.state;
				else if (op.kind === "set_parent") {
					if (!isValidRank(op.rank)) return rememberRefusal("bad_rank");
					if (op.parent) {
						const parent = next.entries.get(op.parent);
						if (!parent) return rememberRefusal("parent_missing");
						const parentDenied = mayWrite(parent, a);
						if (parentDenied) return rememberRefusal(parentDenied);
					}
					e.parent = op.parent;
					e.rank = op.rank;
				} else if (op.kind === "set_rank") {
					if (!isValidRank(op.rank)) return rememberRefusal("bad_rank");
					e.rank = op.rank;
				} else if (op.kind === "set_attachments") {
					if (!attachmentsHeld(domainId, op.attachments)) return rememberRefusal("attachment_missing");
					replaceAttachments(e, op.attachments as unknown as NonNullable<BoardEntry["attachments"]>);
				} else if (op.kind === "trash") e.trashedAt = at;
				else delete e.trashedAt;
				touched.add(op.id);
			}
		}
		const parentsBefore = new Map([...next.entries].map(([id, e]) => [id, e.parent]));
		promoteOrphans(next.entries);
		for (const [id, e] of next.entries) if (parentsBefore.get(id) !== e.parent) touched.add(id);
		// Removed parents and promoted children stay touched.
		for (const id of touched) {
			let cur: string | undefined = id;
			const seen = new Set<string>();
			while (cur) {
				if (seen.has(cur)) return rememberRefusal("cycle");
				seen.add(cur);
				cur = next.entries.get(cur)?.parent;
			}
		}
		// Authority gates writes. Cascade follows touched entries.
		const cascaded = applyCascade(next.entries, [...touched], orphanedParents(before, next, touched));
		for (const c of cascaded) touched.add(c.id);
		next.revision++;
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
			if (replayId)
				tx.put("board.op", replayId, null, {
					clear: {
						hash,
						createdAt: now(),
						outcome: BOARD_OUTCOME_APPLIED,
						revision: next.revision,
						cascaded: cascaded.map(({ id, from, to, reason }) => ({ id, from, to, reason })),
					},
				});
		});
		if (result.kind === "conflict")
			return { outcome: "conflict" as const, revision: before.revision, entries: answerBefore(), cascaded: [] };
		// Durability uncertainty still applied.
		if (result.kind !== "ok" && result.kind !== "durability_uncertain")
			return rememberRefusal("durability_failure");
		const refSets = [...touched].map((id) => ({
			ref: { kind: "entry" as const, entryId: id },
			blobIds: next.entries.get(id)?.attachments?.map((attachment) => attachment.blobId) ?? [],
		}));
		if (deps.referenceHeld.applyRefs) deps.referenceHeld.applyRefs(domainId, refSets);
		for (const o of observationsFor(before, next, touched, a)) {
			const s = parseKey(o.sessionKey);
			if (!deps.inbox.hasSession(domainId, s.gatewayId, s.sessionId)) continue;
			const address: InboxAddress = { kind: "session", domainId, gatewayId: s.gatewayId, sessionId: s.sessionId };
			// One row per party, entry, revision.
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
			else if (appended.outcome !== OP_OUTCOME_ACCEPTED)
				console.warn(`[board] observation for ${o.sessionKey} not written: ${appended.outcome}`);
		}
		deps.pokeOwner?.(domainId, next.revision);
		return {
			outcome: BOARD_OUTCOME_APPLIED,
			revision: next.revision,
			entries: [...next.entries.values()].map(stored),
			cascaded: cascaded.map(({ id, from, to, reason }) => ({ id, from, to, reason })),
		};
	};
	const sessionEnded = (domainId: string, sessionKey: string, disposition: "release" | "cancel", at = now()) => {
		for (let attempt = 0; attempt < 4; attempt++) {
			const before = load(domainId);
			const ending = [...before.entries.values()].filter((e) => e.sessionId === sessionKey);
			if (ending.length === 0)
				return {
					outcome: "refused" as const,
					revision: before.revision,
					entries: [],
					cascaded: [],
					refusal: "session_missing",
				};
			const next = new Map([...before.entries].map(([id, e]) => [id, structuredClone(e)]));
			if (disposition === "cancel")
				for (const e of ending)
					if (e.trashedAt === undefined && e.state !== "done" && e.state !== "cancelled")
						next.get(e.id)!.state = "cancelled";
			const finished = prunableSubtrees(
				next,
				(e) => e.sessionId === sessionKey && (e.state === "done" || e.state === "cancelled"),
			);
			const ops: BoardWrite["ops"] = [];
			for (const e of ending)
				if (next.get(e.id)!.state !== e.state)
					ops.push({ kind: "set_state", id: e.id, state: next.get(e.id)!.state });
			for (const id of finished) ops.push({ kind: "trash", id });
			for (const e of ending) ops.push({ kind: "set_session", id: e.id });
			const result = write(
				domainId,
				{ expectedRevision: before.revision, ops },
				{ kind: "owner" },
				undefined,
				at,
			);
			if (result.outcome !== "conflict") return result;
		}
		const current = load(domainId);
		return {
			outcome: "conflict" as const,
			revision: current.revision,
			entries: [...current.entries.values()].map(stored),
			cascaded: [],
		};
	};
	const sweepTrash = (domainId: string, at = now()) => {
		const store = deps.registry.for(domainId);
		const b = load(domainId);
		const dead = [...b.entries.values()].filter(
			(e) => e.trashedAt !== undefined && at - e.trashedAt > BOARD_TRASH_TTL_MS,
		);
		// Remove only dead subtrees.
		const doomed = new Set(dead.map((e) => e.id));
		const removable = dead.filter((e) =>
			[...b.entries.values()].every((child) => child.parent !== e.id || doomed.has(child.id)),
		);
		let removed = 0;
		if (removable.length) {
			const result = write(
				domainId,
				{ expectedRevision: b.revision, ops: removable.map((e) => ({ kind: "remove", id: e.id })) },
				{ kind: "owner" },
			);
			removed = result.outcome === BOARD_OUTCOME_APPLIED ? removable.length : 0;
		}
		const records = store.list("board.op");
		const expired = records.filter((record) => at - Number(record.clear.createdAt) > BOARD_OP_TTL_MS);
		// Age and cap bound caller-minted ids.
		const surplus = records
			.filter((record) => !expired.includes(record))
			.sort((x, y) => Number(x.clear.createdAt) - Number(y.clear.createdAt))
			.slice(0, Math.max(0, records.length - expired.length - MAX_BOARD_OPS_PER_OWNER));
		const prunable = [...expired, ...surplus];
		if (prunable.length)
			store.batch((tx) => {
				for (const record of prunable) tx.del("board.op", record.id, record.version);
			});
		return removed;
	};
	const register = (hooks: OwnerServiceHooks) => {
		// OwnerOp id is the idempotency key.
		hooks.ownerOp("board_write", (op, value) =>
			write(op.domainId, value.write ?? BoardWriteSchema.parse(value), { kind: "owner" }, op.opId),
		);
		hooks.ownerOp("board_read", (op) => read(op.domainId));
		// Gateways act only for registered sessions.
		hooks.gatewayFrame("board_op", (reg: GatewayRegistration, params) => {
			const p = BoardOpParamsSchema.parse(params);
			if (!deps.inbox.hasSession(reg.domainId, reg.gatewayId, p.sessionId)) throw new OwnerOpRefused("session");
			return write(
				reg.domainId,
				p.write,
				{
					kind: "session",
					session: { domainId: reg.domainId, gatewayId: reg.gatewayId, sessionId: p.sessionId },
				},
				p.opId,
			);
		});
		hooks.gatewayFrame("board_session_end", (reg: GatewayRegistration, params) => {
			const p = BoardSessionEndParamsSchema.parse(params);
			return sessionEnded(
				reg.domainId,
				key({ domainId: reg.domainId, gatewayId: reg.gatewayId, sessionId: p.sessionId }),
				p.disposition,
			);
		});
		hooks.gatewayFrame("board_read", (reg: GatewayRegistration) => {
			try {
				return read(reg.domainId);
			} catch (error) {
				if (error instanceof OwnerQuarantined) return { outcome: "durability_uncertain" as const };
				throw error;
			}
		});
	};
	return { read, write, sessionEnded, sweepTrash, register };
}
