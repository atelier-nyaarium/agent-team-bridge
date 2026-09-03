// Cursor guarantees delivery. Push is optimization.

import {
	CONSOLE_HELLO_DEADLINE_MS,
	CONSOLE_PLANES_ONLY,
	CONSOLE_ROWS_PER_FRAME,
	ConsoleSocketInboundSchema,
	type ConsoleSocketOutbound,
} from "../../shared/schemasConsoleSocket.js";
import type { InboxRow } from "../../shared/schemasInbox.js";

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
	) => InboxRow[] | { outcome: "cursor_stale"; floor: number; dropped: number };
	readOwnerKeyRows: (domainId: string, ownerSignPub: string, sinceMs: number) => InboxRow[];
	now?: () => number;
	advanceCursor: (
		domainId: string,
		signerSignPub: string,
		cursor: number,
		cursorEpoch: number,
	) => { outcome: "ok" } | { outcome: "cursor_stale"; floor: number; dropped: number };
	/** Lowest retained sequence. */
	ownerFloor: (domainId: string) => number;
	/** Current plane versions. */
	planeVersions?: (domainId: string, signerSignPub: string) => Record<string, number>;
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
	const bound = new Map<ConsoleSocket, Bound>();
	const pending = new Map<ConsoleSocket, ReturnType<typeof setTimeout>>();
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
		if (timer) clearTimeout(timer);
		pending.delete(socket);
		bound.delete(socket);
	}

	function open(socket: ConsoleSocket): void {
		const timer = setTimeout(() => refuse(socket, "no_hello"), CONSOLE_HELLO_DEADLINE_MS);
		timer.unref?.();
		pending.set(socket, timer);
	}

	function drain(socket: ConsoleSocket, at: Bound, cursor: number): void {
		const rows = deps.readOwner(at.domainId, at.signerSignPub, cursor + 1, CONSOLE_ROWS_PER_FRAME, at.cursorEpoch);
		if (!Array.isArray(rows)) {
			refuse(socket, "cursor_stale", { floor: rows.floor, dropped: rows.dropped });
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
		const key = `${identity.domainId}/${identity.signerSignPub}`;
		const incarnation = (incarnations.get(key) ?? 0) + 1;
		incarnations.set(key, incarnation);
		// Planes-only consoles must not pin compaction.
		const consumer = planesOnly
			? { cursor: 0, cursorEpoch: 0 }
			: deps.registerConsumer(identity.domainId, identity.signerSignPub, incarnation);
		const timer = pending.get(socket);
		if (timer) clearTimeout(timer);
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
			versions: deps.planeVersions?.(identity.domainId, identity.signerSignPub) ?? {},
		});
		if (!planesOnly) drain(socket, at, consumer.cursor);
		if (planesOnly) {
			const rows = deps.readOwnerKeyRows(
				identity.domainId,
				identity.signerSignPub,
				(deps.now?.() ?? Date.now()) - 24 * 60 * 60 * 1000,
			);
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
			refuse(socket, "cursor_stale", { floor: advanced.floor, dropped: advanced.dropped });
			return;
		}
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
		forget,
		get boundCount() {
			return bound.size;
		},
	};
}

export type ConsoleSockets = ReturnType<typeof createConsoleSockets>;
