import { MAX_TEAMS_PER_OWNER, mergeReadAnchor, type ReadAnchorEntry } from "../../shared/read-anchor-rules.js";
import { ReadAnchorsReadSchema, ReportReadSchema } from "../../shared/schemasTier1.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { StateRecord, WriteResult } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

export interface ReadAnchorsServiceDeps {
	registry: OwnerStoreRegistry;
}

// Keep versions outside the `readAnchor:<team>` namespace.
const VERSION_ID = "readAnchor.version";
const anchorId = (team: string): string => `readAnchor:${team}`;
const write = (result: WriteResult): void => {
	if (result.kind !== "ok") throw new Error(result.kind === "conflict" ? "conflict" : result.kind);
};

export function createReadAnchorsService(deps: ReadAnchorsServiceDeps) {
	const ensureVersion = (domainId: string): StateRecord => {
		const store = deps.registry.for(domainId);
		const current = store.get("readAnchor", VERSION_ID);
		if (current) return current;
		write(
			store.put("readAnchor", VERSION_ID, null, {
				clear: { epoch: 1 + Math.floor(Math.random() * 0x7ffffffe), version: 0 },
			}),
		);
		return store.get("readAnchor", VERSION_ID) as StateRecord;
	};

	const read = (domainId: string) => {
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
		return {
			version: { epoch: Number(version.clear.epoch), version: Number(version.clear.version) },
			anchors: store
				.list("readAnchor")
				.filter((record) => record.id !== VERSION_ID)
				.map((record) => ({ team: record.id.slice("readAnchor:".length), ...record.clear }))
				.sort((a, b) => a.team.localeCompare(b.team)),
		};
	};

	const report = (domainId: string, team: string, entry: ReadAnchorEntry): boolean => {
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
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
			return false;
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
		write(result);
		return true;
	};

	return {
		report,
		read,
		register(hooks: OwnerServiceHooks): void {
			hooks.ownerOp("report_read", async (op, value) => {
				const parsed = ReportReadSchema.safeParse(value);
				if (!parsed.success) throw new OwnerOpRefused("malformed");
				// Stamped here, never taken from the reporter. It decides every cross-epoch merge, so a
				// device with a fast clock would otherwise pin the anchor against every later report.
				const at = deps.registry.now();
				return { advanced: report(op.domainId, parsed.data.team, { ...parsed.data, at }) };
			});
			hooks.ownerOp("read_anchors_read", async (op, value) => {
				if (!ReadAnchorsReadSchema.safeParse(value).success) throw new OwnerOpRefused("malformed");
				return read(op.domainId);
			});
		},
	};
}
