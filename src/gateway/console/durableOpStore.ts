import type { Clock } from "../../shared/ambient.js";
import { capFifo } from "../../shared/cap-fifo.js";
import { type ConsoleOpResult, MAX_OPS_PER_CONVERSATION } from "../../shared/console-protocol.js";
import type { DurableStore } from "../../shared/durable-store.js";
import { fenced } from "../../shared/migration-fence.js";
import { ConsoleOpResultSchema } from "../../shared/schemas.js";

export type OpRecord<Result = ConsoleOpResult> = { state: "in-flight" } | { state: "complete"; result: Result };

// Keys use clear opIds; sealing changes per attempt.

type Entry<Result> = { record: OpRecord<Result>; expiresAt: number; generation: number };

/** Validates restored results. */
export type ResultValidator<Result> = (candidate: unknown) => candidate is Result;

const DEFAULT_MAX_OPS_PER_CONVERSATION = MAX_OPS_PER_CONVERSATION;

const DEFAULT_MAX_CONVERSATIONS = 500;

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Durable idempotency records. Only markers persist, never requests. */
export class DurableOpStore<Result = ConsoleOpResult> {
	private readonly byConversation = new Map<string, Map<string, Entry<Result>>>();
	private nextGeneration = 1;

	public constructor(
		private readonly durable: DurableStore,
		private readonly ambient: Clock,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly maxOpsPerConversation: number = DEFAULT_MAX_OPS_PER_CONVERSATION,
		private readonly maxConversations: number = DEFAULT_MAX_CONVERSATIONS,
		private readonly validResult: ResultValidator<Result> = isConsoleOpResult as ResultValidator<Result>,
	) {
		this.restore();
	}

	public static withValidator<R>(
		durable: DurableStore,
		ambient: Clock,
		validResult: ResultValidator<R>,
	): DurableOpStore<R> {
		return new DurableOpStore<R>(durable, ambient, undefined, undefined, undefined, validResult);
	}

	private now(): number {
		return this.ambient.now();
	}

	public get(conversationId: string, opId: string): OpRecord<Result> | undefined {
		const entry = this.byConversation.get(conversationId)?.get(opId);
		if (!entry || entry.expiresAt <= this.now()) return undefined;
		return entry.record;
	}

	public get size(): number {
		let total = 0;
		for (const perConv of this.byConversation.values()) total += perConv.size;
		return total;
	}

	public markInFlight(conversationId: string, opId: string): number | null {
		if (fenced()) return null;
		const existing = this.byConversation.get(conversationId)?.get(opId);
		if (existing?.record.state === "in-flight") {
			// Duplicate side effects remain possible.
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)}/${opId} re-executing over an already in-flight record (generation ${existing.generation})`,
			);
		}
		const generation = this.nextGeneration++;
		this.write(conversationId, opId, { state: "in-flight" }, generation);
		return generation;
	}

	/** First successful result wins. */
	public markComplete(conversationId: string, opId: string, result: Result): void {
		if (fenced()) return;
		const existing = this.byConversation.get(conversationId)?.get(opId);
		if (existing?.record.state === "complete") {
			// Duplicate success is observable.
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)}/${opId} discarding a second genuine completion - two concurrent attempts both succeeded; the first result wins`,
			);
			return;
		}
		this.write(conversationId, opId, { state: "complete", result }, existing?.generation ?? this.nextGeneration++);
	}

	/** Clears only the matching generation. */
	public clear(conversationId: string, opId: string, generation: number): boolean {
		if (fenced()) return false;
		const perConv = this.byConversation.get(conversationId);
		const entry = perConv?.get(opId);
		if (!perConv || !entry) return true;
		// Completed operations remain durable.
		if (entry.record.state === "complete") return false;
		if (entry.generation !== generation) {
			// A newer attempt owns this marker.
			console.warn(
				`[durableOpStore] ${conversationId.slice(0, 12)}/${opId} refusing to clear - a newer attempt (generation ${entry.generation}) has since taken over this key (stale generation ${generation})`,
			);
			return false;
		}
		perConv.delete(opId);
		if (perConv.size === 0) this.byConversation.delete(conversationId);
		this.persist();
		return true;
	}

	public sweep(): boolean {
		if (fenced()) return false;
		const t = this.now();
		let removedAny = false;
		for (const [conv, perConv] of this.byConversation) {
			for (const [opId, entry] of perConv) {
				if (entry.expiresAt <= t) {
					perConv.delete(opId);
					removedAny = true;
				}
			}
			if (perConv.size === 0) this.byConversation.delete(conv);
		}
		if (removedAny) this.persist();
		return removedAny;
	}

	/** Drops in-flight markers; complete results survive. */
	// Markers contain no requests, so retries re-execute them.
	public failInFlight(allowFenced = false): number {
		if (fenced() && !allowFenced) return 0;
		let dropped = 0;
		for (const [conv, perConv] of this.byConversation) {
			for (const [opId, entry] of perConv) {
				if (entry.record.state !== "in-flight") continue;
				perConv.delete(opId);
				dropped += 1;
			}
			if (perConv.size === 0) this.byConversation.delete(conv);
		}
		if (dropped > 0) this.persist();
		return dropped;
	}

	private write(conversationId: string, opId: string, record: OpRecord<Result>, generation: number): void {
		const perConv = this.byConversation.get(conversationId) ?? new Map<string, Entry<Result>>();
		this.touchCapped(this.byConversation, conversationId, perConv, this.maxConversations, "conversation");
		this.touchCapped(
			perConv,
			opId,
			{ record, expiresAt: this.now() + this.ttlMs, generation },
			this.maxOpsPerConversation,
			`${conversationId.slice(0, 12)} op`,
		);
		this.persist();
	}

	/** Refreshes recency before capping. */
	private touchCapped<V>(map: Map<string, V>, key: string, value: V, max: number, label: string): void {
		if (map.has(key)) map.delete(key);
		map.set(key, value);
		const before = map.size;
		capFifo(map, max);
		if (map.size < before) {
			console.warn(`[durableOpStore] ${label} cap reached (${max}) - evicted the least-recently-written entry`);
		}
	}

	private persist(): void {
		const snapshot: Array<[string, Array<[string, OpRecord<Result>, number, number]>]> = [];
		for (const [conv, perConv] of this.byConversation) {
			const rows: Array<[string, OpRecord<Result>, number, number]> = [];
			for (const [opId, entry] of perConv) rows.push([opId, entry.record, entry.expiresAt, entry.generation]);
			snapshot.push([conv, rows]);
		}
		this.durable.save(snapshot);
	}

	private restore(): void {
		const raw = this.durable.load();
		if (!Array.isArray(raw)) return;
		const t = this.now();
		let maxGeneration = 0;
		let rejectedConversations = 0;
		let rejectedRows = 0;
		for (const convEntry of raw) {
			if (!Array.isArray(convEntry) || convEntry.length !== 2) {
				rejectedConversations++;
				continue;
			}
			const [conv, rows] = convEntry as [unknown, unknown];
			if (typeof conv !== "string" || !Array.isArray(rows)) {
				rejectedConversations++;
				continue;
			}
			const perConv = new Map<string, Entry<Result>>();
			for (const row of rows) {
				if (!Array.isArray(row) || row.length !== 4) {
					rejectedRows++;
					continue;
				}
				const [opId, record, expiresAt, generation] = row as [unknown, unknown, unknown, unknown];
				if (typeof opId !== "string" || typeof expiresAt !== "number") {
					rejectedRows++;
					continue;
				}
				if (expiresAt <= t) continue;
				if (typeof generation !== "number") {
					rejectedRows++;
					continue;
				}
				if (!isOpRecord(record, this.validResult)) {
					rejectedRows++;
					continue;
				}
				perConv.set(opId, { record, expiresAt, generation });
				if (generation > maxGeneration) maxGeneration = generation;
			}
			// Restore under current caps.
			capFifo(perConv, this.maxOpsPerConversation);
			if (perConv.size > 0) this.byConversation.set(conv, perConv);
		}
		capFifo(this.byConversation, this.maxConversations);
		if (rejectedConversations > 0 || rejectedRows > 0) {
			console.warn(
				`[durableOpStore] restore rejected ${rejectedConversations} malformed conversation(s) and ${rejectedRows} malformed row(s) - a schema change or file corruption may have silently dropped durable completions`,
			);
		}
		// Avoid restored generation collisions.
		this.nextGeneration = maxGeneration + 1;
	}
}

/** Validates restored record shape. */
function isOpRecord<Result>(value: unknown, validResult: ResultValidator<Result>): value is OpRecord<Result> {
	if (typeof value !== "object" || value === null || !("state" in value)) return false;
	if (value.state === "in-flight") return true;
	if (value.state !== "complete") return false;
	return "result" in value && validResult(value.result);
}

export const isConsoleOpResult: ResultValidator<ConsoleOpResult> = (candidate): candidate is ConsoleOpResult =>
	ConsoleOpResultSchema.safeParse(candidate).success;
