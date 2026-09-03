export type LeaseState = "active" | "offline" | "retired" | "excluded";

export interface MigrationLease {
	state: LeaseState;
	epoch: number;
	/** Exported and imported epoch. */
	completedEpoch?: number;
}

export function leaseKey(domainId: string, gatewayId: string): string {
	return `migration:${domainId}/${gatewayId}`;
}

export function isComplete(lease: MigrationLease, migrationEpoch: number): boolean {
	return lease.completedEpoch === migrationEpoch;
}

/** Only active leases block authority. */
export function authorityReady(leases: Iterable<MigrationLease>, migrationEpoch: number): boolean {
	const active = [...leases].filter((lease) => lease.state === "active");
	return active.every((lease) => isComplete(lease, migrationEpoch));
}

/** Incomplete or unknown leases stay fenced. */
export function fenceOnReconnect(lease: MigrationLease | undefined, migrationEpoch: number): boolean {
	if (!lease) return true;
	if (lease.state === "retired" || lease.state === "excluded") return true;
	return !isComplete(lease, migrationEpoch);
}
