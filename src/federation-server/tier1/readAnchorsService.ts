import { mintEpoch } from "../../shared/epoch.js";
import { MAX_TEAMS_PER_OWNER, mergeReadAnchor, type ReadAnchorEntry } from "../../shared/read-anchor-rules.js";
import { foldWriteResult } from "../../shared/write-result.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { StateRecord } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

export interface ReadAnchorsServiceDeps {
	registry: OwnerStoreRegistry;
}

// Keep version outside team namespace.
const VERSION_ID = "readAnchor.version";
const anchorId = (team: string): string => `readAnchor:${team}`;
const write = (result: Parameters<typeof foldWriteResult>[0]) => foldWriteResult(result);

export function createReadAnchorsService(deps: ReadAnchorsServiceDeps) {
	const ensureVersion = (domainId: string): StateRecord | { outcome: ReturnType<typeof write>["outcome"] } => {
		const store = deps.registry.for(domainId);
		const current = store.get("readAnchor", VERSION_ID);
		if (current) return current;
		const result = write(
			store.put("readAnchor", VERSION_ID, null, {
				clear: { epoch: mintEpoch(), version: 0 },
			}),
		);
		if (!result.applied) return { outcome: result.outcome } as never;
		return store.get("readAnchor", VERSION_ID) as StateRecord;
	};

	const read = (domainId: string) => {
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
		if ("outcome" in version) return version as never;
		return {
			version: { epoch: Number(version.clear.epoch), version: Number(version.clear.version) },
			anchors: store
				.list("readAnchor")
				.filter((record) => record.id !== VERSION_ID)
				.map((record) => ({ team: record.id.slice("readAnchor:".length), ...record.clear }))
				.sort((a, b) => a.team.localeCompare(b.team)),
		};
	};

	const reportResult = (domainId: string, team: string, entry: ReadAnchorEntry) => {
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
		if ("outcome" in version) return version as never;
		const currentRecords = store.list("readAnchor").filter((record) => record.id !== VERSION_ID);
		const state: Record<string, Record<string, ReadAnchorEntry>> = {
			[domainId]: Object.fromEntries(
				currentRecords.map((record) => [
					record.id.slice("readAnchor:".length),
					record.clear as unknown as ReadAnchorEntry,
				]),
			),
		};
		const merged = mergeReadAnchor(state, domainId, team, entry);
		if (!merged.advanced) {
			if (!state[domainId][team] && currentRecords.length >= MAX_TEAMS_PER_OWNER)
				throw new OwnerOpRefused("read-anchor team limit");
			return { advanced: false, outcome: "accepted" as const };
		}
		const current = store.get("readAnchor", anchorId(team));
		const nextVersion = Number(version.clear.version) + 1;
		const result = store.batch((tx) => {
			tx.put("readAnchor", anchorId(team), current?.version ?? null, {
				clear: merged.state[domainId][team] as unknown as Record<string, unknown>,
			});
			tx.put("readAnchor", VERSION_ID, version.version, {
				clear: { epoch: version.clear.epoch, version: nextVersion },
			});
		});
		const folded = write(result);
		if (!folded.applied) return { advanced: false, outcome: folded.outcome };
		return { advanced: true, outcome: folded.outcome };
	};
	const report = (domainId: string, team: string, entry: ReadAnchorEntry): boolean =>
		reportResult(domainId, team, entry).advanced;

	return {
		report,
		read,
		register(hooks: OwnerServiceHooks): void {
			hooks.ownerOp("report_read", async (op, value) => {
				// Router stamps time; epochs use equality, never ordering.
				const at = deps.registry.now();
				return reportResult(op.domainId, value.team, { ...value, at });
			});
			hooks.ownerOp("read_anchors_read", async (op) => read(op.domainId));
		},
	};
}
