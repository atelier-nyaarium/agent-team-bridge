export type WriteResultLike =
	| { kind: "ok" }
	| { kind: "conflict" }
	| { kind: "durability_failure" }
	| { kind: "durability_uncertain" }
	| { kind: "quarantined" };

export type WriteOutcome = "accepted" | "conflict" | "durability_failure" | "durability_uncertain";

export interface FoldedWrite {
	/** Applied writes trigger effects. */
	applied: boolean;
	outcome: WriteOutcome;
}

// Preserve applied writes; quarantine is uncertain.
export function foldWriteResult(result: WriteResultLike): FoldedWrite {
	switch (result.kind) {
		case "ok":
			return { applied: true, outcome: "accepted" };
		case "durability_uncertain":
			return { applied: true, outcome: "durability_uncertain" };
		case "conflict":
			return { applied: false, outcome: "conflict" };
		case "durability_failure":
			return { applied: false, outcome: "durability_failure" };
		case "quarantined":
			return { applied: false, outcome: "durability_uncertain" };
		default:
			return assertNever(result);
	}
}

function assertNever(value: never): never {
	throw new Error(`unhandled write result ${JSON.stringify(value)}`);
}
