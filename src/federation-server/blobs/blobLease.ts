import crypto from "node:crypto";

export const BLOB_LEASE_MS = 10 * 60 * 1000;

export interface BlobLease {
	id: string;
	generation: number;
	expiresAt: number;
	expectedSize?: number;
}

export interface LeaseRecord extends BlobLease {
	lastRenewedAt: number;
}

export function newLease(
	generation: number,
	now: number,
	expiresAt = now + BLOB_LEASE_MS,
	expectedSize?: number,
): LeaseRecord {
	return { id: crypto.randomUUID(), generation, expiresAt, lastRenewedAt: now, expectedSize };
}

export function leaseMatches(
	record: LeaseRecord | undefined,
	lease: Pick<BlobLease, "id" | "generation">,
	now: number,
): boolean {
	return (
		record !== undefined &&
		record.id === lease.id &&
		record.generation === lease.generation &&
		record.expiresAt > now
	);
}
