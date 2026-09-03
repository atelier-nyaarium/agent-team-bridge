// Apply imports offline only.

/** Completed import marker. */
export interface ImportMarker {
	digest: string;
	epoch: number;
	gatewayId: string;
	/** Section counts for replay. */
	counts: Record<string, number>;
}

export type ImportVerdict =
	| { kind: "apply" }
	/** Already applied. */
	| { kind: "noop"; marker: ImportMarker }
	/** Epoch conflict. */
	| { kind: "refused"; reason: "epoch_conflict"; recorded: ImportMarker };

/** Marker per gateway and epoch. */
export function markerKey(gatewayId: string, epoch: number): string {
	return `${gatewayId}/${epoch}`;
}

export function decideImport(
	incoming: { digest: string; epoch: number; gatewayId: string },
	recorded: ImportMarker | undefined,
): ImportVerdict {
	if (!recorded) return { kind: "apply" };
	if (recorded.digest === incoming.digest) return { kind: "noop", marker: recorded };
	return { kind: "refused", reason: "epoch_conflict", recorded };
}
