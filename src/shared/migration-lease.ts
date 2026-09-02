// Per-gateway migration state, and the two decisions it drives: when the Router may take authority
// for owner state, and whether a gateway reconnecting may write.

/**
 * `active` is migrating now. `offline` was asleep at the cut and has not been heard from.
 * `retired` and `excluded` are deliberately out of the fleet, the difference being whether the
 * operator expects the machine back.
 */
export type LeaseState = "active" | "offline" | "retired" | "excluded";

export interface MigrationLease {
	state: LeaseState;
	epoch: number;
	/** The epoch this gateway has exported AND had imported. Absent until it has. */
	completedEpoch?: number;
}

export function leaseKey(domainId: string, gatewayId: string): string {
	return `migration:${domainId}/${gatewayId}`;
}

export function isComplete(lease: MigrationLease, migrationEpoch: number): boolean {
	return lease.completedEpoch === migrationEpoch;
}

/**
 * Every ACTIVE gateway has finished. An `offline` one does not block: one asleep machine cannot
 * hold the whole fleet, and it is fenced on reconnect instead. `retired` and `excluded` are out of
 * the fleet and never counted.
 */
export function authorityReady(leases: Iterable<MigrationLease>, migrationEpoch: number): boolean {
	const active = [...leases].filter((lease) => lease.state === "active");
	return active.every((lease) => isComplete(lease, migrationEpoch));
}

/**
 * A gateway that has not completed THIS epoch may not write, whatever it believes. This is what
 * stops a machine that slept through the cut waking up and writing to state the Router now owns.
 * An unknown gateway is fenced too: it cannot have completed a migration nobody recorded.
 */
export function fenceOnReconnect(lease: MigrationLease | undefined, migrationEpoch: number): boolean {
	if (!lease) return true;
	if (lease.state === "retired" || lease.state === "excluded") return true;
	return !isComplete(lease, migrationEpoch);
}
