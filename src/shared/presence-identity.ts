import { stableHash } from "./plane-registry.js";
import type { TeamInfo } from "./types.js";

export type PresenceRow = TeamInfo & {
	working?: boolean;
	needsLogin?: boolean;
	limitBlocked?: boolean;
	limitDetail?: string;
	presenceFresh?: "fresh" | "quiet" | "unreachable";
};

/** Hashes presence rows without the high-churn `lastActive` field. */
export function presenceIdentityOf(rows: PresenceRow[]): string {
	return stableHash(rows.map(({ lastActive: _lastActive, ...rest }) => rest));
}
