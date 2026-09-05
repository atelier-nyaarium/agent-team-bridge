import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Clock } from "../../shared/ambient.js";
import { fenced } from "../../shared/migration-fence.js";
import { CrossDomainShareTargetSchema } from "../../shared/schemas.js";
import {
	all as allShares,
	type CrossDomainShareTarget,
	dropDomain as dropShareDomain,
	isSharedTo as isShareSharedTo,
	type ShareRecord,
	type ShareState,
	share as shareRule,
	sharesFor as sharesForRule,
	sweep as sweepShares,
	touch as touchShares,
	unshare as unshareRule,
} from "../../shared/share-rules.js";

export type { ShareRecord } from "../../shared/share-rules.js";

const ShareRecordSchema = z.object({
	sessionTarget: z.string().min(1),
	target: CrossDomainShareTargetSchema,
	lastSeenAt: z.number().int(),
});
const CrossDomainShareFileSchema = z.object({ shares: z.array(ShareRecordSchema) });
type CrossDomainShareFile = ShareState;

export type ShareChangeReason = { kind: "domain"; domainId: string } | { kind: "sweep" };

export const XDOMAIN_SHARE_FILE = "cross-domain-share-state.json";

export class CrossDomainShareState {
	private file: string;
	private state: CrossDomainShareFile;
	private readonly onChange?: (reason: ShareChangeReason) => void;

	constructor(
		dataDir: string,
		onChange: ((reason: ShareChangeReason) => void) | undefined,
		private readonly ambient: Clock,
	) {
		this.file = path.join(dataDir, XDOMAIN_SHARE_FILE);
		this.state = this.read();
		this.onChange = onChange;
	}

	private read(): CrossDomainShareFile {
		try {
			const parsed = CrossDomainShareFileSchema.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
			if (parsed.success) return parsed.data;
		} catch {
			// Unreadable state starts empty.
		}
		return { shares: [] };
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
	}

	share(sessionTarget: string, target: CrossDomainShareTarget): void {
		if (fenced()) return;
		this.state = shareRule(this.state, sessionTarget, target, this.ambient.now());
		this.persist();
		this.onChange?.(target.kind === "domain" ? { kind: "domain", domainId: target.domainId } : { kind: "sweep" });
	}

	unshare(sessionTarget: string, target: CrossDomainShareTarget): boolean {
		if (fenced()) return false;
		const result = unshareRule(this.state, sessionTarget, target);
		this.state = result.state;
		const removed = result.removed;
		if (removed) {
			this.persist();
			this.onChange?.(
				target.kind === "domain" ? { kind: "domain", domainId: target.domainId } : { kind: "sweep" },
			);
		}
		return removed;
	}

	isSharedTo(sessionTarget: string, toDomainId: string, isLinked: (domainId: string) => boolean): boolean {
		return isShareSharedTo(this.state, sessionTarget, toDomainId, isLinked);
	}

	sharesFor(toDomainId: string, isLinked: (domainId: string) => boolean): string[] {
		return sharesForRule(this.state, toDomainId, isLinked);
	}

	touch(sessionTarget: string): void {
		if (fenced()) return;
		const before = this.state.shares;
		this.state = touchShares(this.state, sessionTarget, this.ambient.now());
		const changed = this.state.shares.some((s, i) => s.lastSeenAt !== before[i]?.lastSeenAt);
		if (changed) this.persist();
	}

	dropDomain(toDomainId: string): number {
		if (fenced()) return 0;
		const result = dropShareDomain(this.state, toDomainId);
		this.state = result.state;
		const removed = result.removed;
		if (removed > 0) {
			this.persist();
			this.onChange?.({ kind: "domain", domainId: toDomainId });
		}
		return removed;
	}

	all(): ShareRecord[] {
		return allShares(this.state);
	}

	sweep(now: number, ttlMs: number, isLive: (sessionTarget: string) => boolean): number {
		if (fenced()) return 0;
		const result = sweepShares(this.state, now, ttlMs, isLive);
		this.state = result.state;
		const removed = result.removed;
		if (removed > 0) {
			this.persist();
			this.onChange?.({ kind: "sweep" });
		}
		return removed;
	}
}
