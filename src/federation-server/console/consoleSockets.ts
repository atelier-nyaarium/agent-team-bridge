////////////////////////////////
//  Console sockets
//
//  The first consumer the owner inbox has ever had. Rows accumulated there until now because
//  nothing read them, so this is what makes an owner-addressed row mean anything.
//
//  A push here is an OPTIMIZATION, never the delivery guarantee. The cursor in the consumer
//  registry is the durable part: a phone that was not connected reads from its cursor on hello and
//  misses nothing, so an owner row is never marked waking the way a session row is.

import {
	CONSOLE_HELLO_DEADLINE_MS,
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
	/** The one OwnerOp routine. A hello is verified by it and by nothing else. */
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
	advanceCursor: (
		domainId: string,
		signerSignPub: string,
		cursor: number,
		cursorEpoch: number,
	) => { outcome: "ok" } | { outcome: "cursor_stale"; floor: number; dropped: number };
	/** The lowest seq still held, so a phone below it can show the gap rather than skip it. */
	ownerFloor: (domainId: string) => number;
	/** Plane versions the Router holds, so a phone skips what it already has. */
	planeVersions?: (domainId: string, signerSignPub: string) => Record<string, number>;
}

/** What a verified hello establishes, and what every later frame is checked against. */
interface Bound {
	domainId: string;
	signerSignPub: string;
	incarnation: number;
	cursorEpoch: number;
}

/** The answer a hello handler hands back through the intake. */
export interface ConsoleHelloAnswer {
	domainId: string;
	signerSignPub: string;
}

export function createConsoleSockets(deps: ConsoleSocketsDeps) {
	const bound = new Map<ConsoleSocket, Bound>();
	const pending = new Map<ConsoleSocket, ReturnType<typeof setTimeout>>();
	// Monotonic per consumer, so a reconnect's frames are told apart from the socket it replaced.
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
			// A socket already gone needs no closing.
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

	/** Everything the consumer has not acked, oldest first, in bounded frames. The cursor is the last
	 * seq it acked, so the read starts ABOVE it or the acked row comes back. */
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

	async function hello(socket: ConsoleSocket, ownerOp: unknown): Promise<void> {
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
		const consumer = deps.registerConsumer(identity.domainId, identity.signerSignPub, incarnation);
		const timer = pending.get(socket);
		if (timer) clearTimeout(timer);
		pending.delete(socket);
		// One socket per consumer: the older one is retired rather than left racing the new cursor.
		for (const [other, at] of bound) {
			if (at.domainId === identity.domainId && at.signerSignPub === identity.signerSignPub)
				refuse(other, "superseded");
		}
		const at: Bound = { ...identity, incarnation, cursorEpoch: consumer.cursorEpoch };
		bound.set(socket, at);
		send(socket, {
			type: "welcome",
			incarnation,
			cursor: consumer.cursor,
			cursorEpoch: consumer.cursorEpoch,
			floor: deps.ownerFloor(identity.domainId),
			versions: deps.planeVersions?.(identity.domainId, identity.signerSignPub) ?? {},
		});
		drain(socket, at, consumer.cursor);
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
			// A second hello on a bound socket is a client bug, not a re-auth.
			if (at) refuse(socket, "already_bound");
			else await hello(socket, frame.data.ownerOp);
			return;
		}
		// Stale means a frame from the socket this one replaced; it is dropped, never acted on.
		if (!at || frame.data.incarnation !== at.incarnation) return;
		if (frame.data.type === "ping") {
			send(socket, { type: "pong", incarnation: at.incarnation });
			return;
		}
		const advanced = deps.advanceCursor(at.domainId, at.signerSignPub, frame.data.cursor, frame.data.cursorEpoch);
		if (advanced.outcome !== "ok") {
			refuse(socket, "cursor_stale", { floor: advanced.floor, dropped: advanced.dropped });
			return;
		}
		drain(socket, at, frame.data.cursor);
	}

	/** Best effort by design: an unreached console reads from its cursor on the next hello. */
	function pushOwnerRow(domainId: string, signerSignPub: string | null, row: InboxRow): void {
		for (const [socket, at] of bound) {
			if (at.domainId !== domainId) continue;
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

	/** A revoked console keeps no socket. */
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
