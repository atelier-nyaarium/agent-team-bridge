// The Router's leaf is self-signed, so its fingerprint IS its identity, and the check has to happen
// on the TLS socket BEFORE the upgrade request is written: that request carries the WS bearer, so a
// check run after the handshake authenticates nothing it could still protect.

import crypto from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";

////////////////////////////////
//  Interfaces & Types

/** Three-valued on purpose. A certificate that could not be READ is not a WRONG certificate, and
 * collapsing the two turned a runtime upgrade into a fleet-wide "cert mismatch" that named the one
 * thing which was fine. `pending` is the same distinction one step earlier: the socket was never
 * handed over, so nothing was verified either way. */
export type PinVerdict = "match" | "mismatch" | "unreadable" | "pending";

export interface PinnedDial {
	/** Handed to ws, which uses it instead of opening its own TLS socket. */
	createConnection: (options: net.NetConnectOpts) => net.Socket;
	verdict: () => PinVerdict;
}

////////////////////////////////
//  Functions & Helpers

export function fingerprintOf(raw: Buffer): string {
	return crypto.createHash("sha256").update(raw).digest("hex");
}

export function classifyLeaf(raw: Buffer | undefined, expectedFp: string): Exclude<PinVerdict, "pending"> {
	if (!raw?.length) return "unreadable";
	return fingerprintOf(raw) === expectedFp.trim().toLowerCase() ? "match" : "mismatch";
}

/** Why a verdict refuses, in words the reader can act on. */
export function pinRefusal(verdict: PinVerdict): string {
	switch (verdict) {
		case "mismatch":
			return "router cert fingerprint mismatch";
		case "unreadable":
			return "the router certificate could not be read (not a mismatch, no answer)";
		default:
			return "this runtime never handed over the TLS socket, so nothing was pinned (bun 1.4+ or node is required)";
	}
}

/**
 * The ws package itself, not bun's substitute for it.
 *
 * Bun rewrites the bare `ws` specifier to its own WebSocket, which exposes no peer certificate and
 * ignores `createConnection`, so a pin written against the npm package silently does nothing there.
 * The package's exports map hides its internals from a subpath import, hence the resolved file path.
 */
/**
 * The directory a module URL sits in, as a real filesystem path.
 *
 * `new URL(url).pathname` is NOT one, and using it here cost a Windows gateway its Router link: it
 * keeps the leading slash before a drive letter (`/B:/switchboard`), so every `path.join` off it
 * builds `\B:\switchboard\...`, which opens nothing, and the walk below runs to the root and throws.
 * It is not Windows-only either - `pathname` stays percent-encoded, so a repo checked out to a path
 * containing a space resolves `my%20projects` and fails the same way on Linux.
 *
 * Exported so the derivation is testable on any platform; the RESOLUTION it feeds is only provable
 * on the shipping runtime, which is what `scripts/check-pinning-runtime.ts` is for.
 */
export function moduleDir(moduleUrl: string): string {
	return path.dirname(fileURLToPath(moduleUrl));
}

export function realWebSocket(): typeof WebSocket {
	const require_ = createRequire(import.meta.url);
	let dir = moduleDir(import.meta.url);
	for (;;) {
		const candidate = path.join(dir, "node_modules", "ws", "lib", "websocket.js");
		try {
			return require_(candidate) as typeof WebSocket;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error("the ws package could not be resolved for TLS pinning");
		dir = parent;
	}
}

/**
 * A TLS socket that authenticates the Router by fingerprint and destroys itself if it cannot.
 *
 * Chain verification is off because a self-signed leaf has no chain and its subject names one CN
 * that no dialled address matches. The fingerprint compare replaces both, and runs first: the
 * listener is attached before the socket is returned, so ws writes nothing until it has passed.
 */
export function pinnedDial(host: string, port: number, expectedFp: string): PinnedDial {
	let verdict: PinVerdict = "pending";
	return {
		verdict: () => verdict,
		createConnection(options) {
			const socket = tls.connect({
				...options,
				host,
				port,
				rejectUnauthorized: false,
				// SNI is a hostname field; handing it an IP literal throws.
				servername: net.isIP(host) === 0 ? host : undefined,
			});
			socket.once("secureConnect", () => {
				verdict = classifyLeaf(socket.getPeerCertificate?.(true)?.raw, expectedFp);
				if (verdict !== "match") socket.destroy(new Error(pinRefusal(verdict)));
			});
			return socket;
		},
	};
}
