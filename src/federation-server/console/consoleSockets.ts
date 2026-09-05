// Cursor guarantees delivery. Push is optimization.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import {
	CONSOLE_HELLO_DEADLINE_MS,
	CONSOLE_PLANES_ONLY,
	CONSOLE_ROWS_PER_FRAME,
	ConsoleSocketInboundSchema,
	type ConsoleSocketOutbound,
} from "../../shared/schemasConsoleSocket.js";
import type { InboxRow } from "../../shared/schemasInbox.js";
import { CONSOLE_REASON_CURSOR_STALE } from "../../shared/wire-vocabulary.js";
import { readRouterMigrationWindow } from "../migration/leaseService.js";

export interface ConsoleSocket {
	send(data: string): void;
	close(): void;
}

export interface ConsoleSocketsDeps {
	/** OwnerOp alone verifies hello. */
	handleOwnerOp: (raw: unknown) => Promise<unknown>;
	registerConsumer: (
		domainId: string,
		signerSignPub: string,
		incarnation: number,
	) => { cursor: number; cursorEpoch: number };
	readOwner: (
		domainId: string,
		signerSignPub: string,
		fromSeq: number,
		limit: number,
		cursorEpoch?: number,
	) =>
		| InboxRow[]
		| { outcome: typeof CONSOLE_REASON_CURSOR_STALE; floor: number; dropped: number }
		| { outcome: "durability_uncertain" };
	readOwnerKeyRows: (
		domainId: string,
		ownerSignPub: string,
		sinceMs: number,
	) => InboxRow[] | { outcome: "durability_uncertain" };
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	/** The registry's clock, stamped on key-row reads. */
	seenAt: () => number;
	advanceCursor: (
		domainId: string,
		signerSignPub: string,
		cursor: number,
		cursorEpoch: number,
	) => { outcome: "ok" } | { outcome: typeof CONSOLE_REASON_CURSOR_STALE; floor: number; dropped: number };
	/** Lowest retained sequence. */
	ownerFloor: (domainId: string) => number;
	/** Current plane versions. */
	planeVersions?: (domainId: string, signerSignPub: string) => Record<string, number>;
	readPlane?: (domainId: string, signerSignPub: string, name: string) => unknown;
	admittedConsoleSigners?: (domainId: string) => string[];
}

/** Verified frame identity. */
interface Bound {
	domainId: string;
	signerSignPub: string;
	incarnation: number;
	cursorEpoch: number;
	/** Plane delivery only. */
	planesOnly: boolean;
}

export interface ConsoleHelloAnswer {
	domainId: string;
	signerSignPub: string;
}

export function createConsoleSockets(deps: ConsoleSocketsDeps) {
	const now = () => deps.seenAt();
	const bound = new Map<ConsoleSocket, Bound>();
	const pending = new Map<ConsoleSocket, TimerHandle>();
	// Distinguishes reconnects from replaced sockets.
	const incarnations = new Map<string, number>();

	const send = (socket: ConsoleSocket, frame: ConsoleSocketOutbound): void => {
		try {
			socket.send(JSON.stringify(frame));
		} catch {
			drop(socket);
		}
	};

	const refuse = (socket: ConsoleSocket, reason: string, extra?: { floor: number; dropped: number }): void => {
		send(socket, { type: "refused", reason, ...(extra ?? {}) });
		drop(socket);
		try {
			socket.close();
		} catch {
			// Closing an absent socket is harmless.
		}
	};

	function drop(socket: ConsoleSocket): void {
		const timer = pending.get(socket);
		if (timer) deps.ambient.clearTimer(timer);
		pending.delete(socket);
		bound.delete(socket);
	}

	function open(socket: ConsoleSocket): void {
		const timer = deps.ambient.setTimer(() => refuse(socket, "no_hello"), CONSOLE_HELLO_DEADLINE_MS);
		pending.set(socket, timer);
	}

	function drain(socket: ConsoleSocket, at: Bound, cursor: number): void {
		const rows = deps.readOwner(at.domainId, at.signerSignPub, cursor + 1, CONSOLE_ROWS_PER_FRAME, at.cursorEpoch);
		if (!Array.isArray(rows) && rows.outcome === "durability_uncertain") {
			send(socket, { type: "refused", reason: "durability_uncertain" });
			return;
		}
		if (!Array.isArray(rows)) {
			refuse(socket, CONSOLE_REASON_CURSOR_STALE, { floor: rows.floor, dropped: rows.dropped });
			return;
		}
		if (rows.length === 0) return;
		send(socket, {
			type: "inbox_rows",
			incarnation: at.incarnation,
			rows,
			cursor: rows[rows.length - 1].seq,
		});
	}

	async function hello(socket: ConsoleSocket, ownerOp: unknown, planesOnly: boolean): Promise<void> {
		const answer = (await deps.handleOwnerOp(ownerOp)) as
			| { outcome?: string; reason?: string; hello?: ConsoleHelloAnswer }
			| undefined;
		const identity = answer?.hello;
		if (!identity) {
			refuse(socket, answer?.reason ?? "not admitted");
			return;
		}
		const admitted = new Set(deps.admittedConsoleSigners?.(identity.domainId) ?? [identity.signerSignPub]);
		for (const key of incarnations.keys()) {
			if (key.startsWith(`${identity.domainId}/`) && !admitted.has(key.slice(identity.domainId.length + 1)))
				incarnations.delete(key);
		}
		const key = `${identity.domainId}/${identity.signerSignPub}`;
		const incarnation = (incarnations.get(key) ?? 0) + 1;
		incarnations.set(key, incarnation);
		// Planes-only consoles must not pin compaction.
		const consumer = planesOnly
			? { cursor: 0, cursorEpoch: 0 }
			: deps.registerConsumer(identity.domainId, identity.signerSignPub, incarnation);
		const timer = pending.get(socket);
		if (timer) deps.ambient.clearTimer(timer);
		pending.delete(socket);
		// One socket per consumer.
		for (const [other, at] of bound) {
			if (at.domainId === identity.domainId && at.signerSignPub === identity.signerSignPub)
				refuse(other, "superseded");
		}
		const at: Bound = { ...identity, incarnation, cursorEpoch: consumer.cursorEpoch, planesOnly };
		bound.set(socket, at);
		send(socket, {
			type: "welcome",
			incarnation,
			cursor: consumer.cursor,
			cursorEpoch: consumer.cursorEpoch,
			floor: deps.ownerFloor(identity.domainId),
			versions: Object.fromEntries(
				readPlanes(identity.domainId, identity.signerSignPub, {}).map(({ name, version }) => [name, version]),
			),
			migrationEpoch: readRouterMigrationWindow().epoch ?? 0,
		});
		if (!planesOnly) drain(socket, at, consumer.cursor);
		if (planesOnly) {
			const rows = deps.readOwnerKeyRows(identity.domainId, identity.signerSignPub, now() - 24 * 60 * 60 * 1000);
			if (!Array.isArray(rows)) {
				send(socket, { type: "refused", reason: "durability_uncertain" });
				return;
			}
			for (let from = 0; from < rows.length; from += CONSOLE_ROWS_PER_FRAME) {
				const batch = rows.slice(from, from + CONSOLE_ROWS_PER_FRAME);
				send(socket, {
					type: "inbox_rows",
					incarnation: at.incarnation,
					rows: batch,
					cursor: batch[batch.length - 1].seq,
				});
			}
		}
	}

	async function message(socket: ConsoleSocket, data: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			refuse(socket, "malformed");
			return;
		}
		const frame = ConsoleSocketInboundSchema.safeParse(parsed);
		if (!frame.success) {
			refuse(socket, "malformed");
			return;
		}
		const at = bound.get(socket);
		if (frame.data.type === "hello") {
			// Bound sockets cannot re-authenticate.
			if (at) refuse(socket, "already_bound");
			else await hello(socket, frame.data.ownerOp, frame.data.mode === CONSOLE_PLANES_ONLY);
			return;
		}
		// Stale frames are dropped.
		if (!at || frame.data.incarnation !== at.incarnation) return;
		if (frame.data.type === "ping") {
			send(socket, { type: "pong", incarnation: at.incarnation });
			return;
		}
		// Planes-only consoles cannot advance cursors.
		if (at.planesOnly) {
			refuse(socket, "planes_only");
			return;
		}
		const advanced = deps.advanceCursor(at.domainId, at.signerSignPub, frame.data.cursor, frame.data.cursorEpoch);
		if (advanced.outcome !== "ok") {
			refuse(socket, CONSOLE_REASON_CURSOR_STALE, { floor: advanced.floor, dropped: advanced.dropped });
			return;
		}
		at.cursorEpoch = frame.data.cursorEpoch;
		drain(socket, at, frame.data.cursor);
	}

	/** Push is best effort. Hello drains the cursor. */
	function pushOwnerRow(domainId: string, signerSignPub: string | null, row: InboxRow): void {
		for (const [socket, at] of bound) {
			if (at.domainId !== domainId) continue;
			if (at.planesOnly && row.envelope.kind !== "key_request" && row.envelope.kind !== "key_grant") continue;
			if (signerSignPub !== null && at.signerSignPub !== signerSignPub) continue;
			send(socket, { type: "inbox_rows", incarnation: at.incarnation, rows: [row], cursor: row.seq });
		}
	}

	function pushPlane(domainId: string, name: string, version: number, payload: unknown): void {
		for (const [socket, at] of bound) {
			if (at.domainId !== domainId) continue;
			send(socket, { type: "plane", incarnation: at.incarnation, name, version, payload });
		}
	}

	function readPlanes(domainId: string, signerSignPub: string, known: Record<string, number>) {
		const versions = deps.planeVersions?.(domainId, signerSignPub) ?? {};
		return Object.entries(versions)
			.filter(([name, version]) => version > (known[name] ?? 0))
			.map(([name, version]) => ({ name, version, payload: deps.readPlane?.(domainId, signerSignPub, name) }));
	}

	/** Revoked consoles keep no socket. */
	function forget(domainId: string, signerSignPub: string): void {
		for (const [socket, at] of bound) {
			if (at.domainId === domainId && at.signerSignPub === signerSignPub) refuse(socket, "revoked");
		}
		incarnations.delete(`${domainId}/${signerSignPub}`);
	}

	return {
		open,
		message,
		close: drop,
		pushOwnerRow,
		pushPlane,
		readPlanes,
		forget,
		get boundCount() {
			return bound.size;
		},
	};
}

export type ConsoleSockets = ReturnType<typeof createConsoleSockets>;
