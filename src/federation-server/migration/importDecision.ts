// Whether an export may be applied, decided before anything is written.
//
// Offline only, and never into a live process. The Router keeps its identity, its enrollment state
// and its TLS files across an import: a Router started without them mints a fresh identity, which
// would break every pin the fleet holds.

/** What a completed import recorded beside the owner directories. */
export interface ImportMarker {
	digest: string;
	epoch: number;
	gatewayId: string;
	/** Per section, so a re-run can answer the same numbers rather than recounting a written tree. */
	counts: Record<string, number>;
}

export type ImportVerdict =
	| { kind: "apply" }
	/** Already applied, byte for byte. Answers the recorded counts rather than importing again. */
	| { kind: "noop"; marker: ImportMarker }
	/** Two different exports claim one epoch. The recorded one is named so an operator can tell
	 * which snapshot the Router is actually holding. */
	| { kind: "refused"; reason: "epoch_conflict"; recorded: ImportMarker };

/**
 * A marker per (gateway, epoch), so one Router can take a late export from a gateway that was
 * offline during the cut without it colliding with the gateways already imported.
 */
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
