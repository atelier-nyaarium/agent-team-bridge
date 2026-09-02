export type JournalOp =
	| {
			op: "put";
			kind: string;
			id: string;
			version: number;
			record: { clear: Record<string, unknown>; sealed?: Record<string, unknown> };
	  }
	| { op: "del"; kind: string; id: string; version: number }
	| { op: "append"; address: string; row: Record<string, unknown>; rowSeq: number }
	| { op: "remove"; address: string; seq: number }
	| { op: "retire"; address: string; uptoSeq: number };

/** Replay applies each batch atomically. */
export type JournalLine = {
	seq: number;
	gen: number;
	ops: JournalOp[];
};
