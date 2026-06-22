import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SignedXDomainLinkSchema } from "../../shared/federation-protocol.js";

////////////////////////////////
//  Schemas

/** A single cross-Domain peer: a Gateway owned by a DIFFERENT owner (a different
 * Domain) that this Gateway has linked with. Keyed by `(friendDomainId,
 * friendGatewayId)` because a gateway id is NOT globally unique across Domains.
 * Carries the friend gateway's keys for the seal plus the owner-signed link that
 * authorized the channel (the friend owner's side, verifiable under
 * `friendOwnerSignPub`). */
const CrossDomainPeerSchema = z.object({
	// The friend's owner root key (base64) - the trust anchor for this peer.
	friendOwnerSignPub: z.string().min(1),
	// The friend's Domain id (slug).
	friendDomainId: z.string().min(1),
	// The friend gateway's id (slug; unique only within its Domain).
	friendGatewayId: z.string().min(1),
	// The friend gateway's raw Ed25519 signing public key (base64).
	friendSignPub: z.string().min(1),
	// The friend gateway's raw X25519 box public key (base64).
	friendBoxPub: z.string().min(1),
	// The friend owner's signed link side (binds the keys above to the friend owner).
	link: SignedXDomainLinkSchema,
});
export type CrossDomainPeer = z.infer<typeof CrossDomainPeerSchema>;

const CrossDomainPeersFileSchema = z.object({
	peers: z.array(CrossDomainPeerSchema),
});
type CrossDomainPeersFile = z.infer<typeof CrossDomainPeersFileSchema>;

////////////////////////////////
//  Class

export const XDOMAIN_PEERS_FILE = "cross-domain-peers.json";

/** The cross-Domain peer set on a Gateway: the Gateways owned by OTHER owners this
 * Gateway has linked with, persisted to the Gateway's volume (tight perms). This is
 * a DISJOINT store from the home allowlist: it is written ONLY by the handshake,
 * never by `allowlist.applySnapshot` or any evie-relayed snapshot, so a home-Domain
 * sync can never wipe it and it can never contaminate intra-Domain resolution. The
 * sealer resolves home peers FIRST (the allowlist), then falls back here, so a home
 * peer's seal path stays byte-for-byte unchanged. */
export class CrossDomainPeers {
	private file: string;
	private state: CrossDomainPeersFile;

	constructor(dataDir: string) {
		this.file = path.join(dataDir, XDOMAIN_PEERS_FILE);
		this.state = this.read();
	}

	private read(): CrossDomainPeersFile {
		try {
			const parsed = CrossDomainPeersFileSchema.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
			if (parsed.success) return parsed.data;
		} catch {
			// Absent / unreadable: start empty.
		}
		return { peers: [] };
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
	}

	/** Add (or replace) a cross-Domain peer. Idempotent on `(friendDomainId,
	 * friendGatewayId)`: a re-link of the same peer replaces the prior entry (newest
	 * keys / link win) rather than accumulating duplicates. Validates the shape before
	 * it is stored. Returns false if the peer is malformed. */
	add(peer: CrossDomainPeer): boolean {
		const parsed = CrossDomainPeerSchema.safeParse(peer);
		if (!parsed.success) return false;
		const p = parsed.data;
		const next = this.state.peers.filter(
			(e) => !(e.friendDomainId === p.friendDomainId && e.friendGatewayId === p.friendGatewayId),
		);
		next.push(p);
		this.state.peers = next;
		this.persist();
		return true;
	}

	/** The peer for a `(friendDomainId, friendGatewayId)` pair, or null. */
	resolveByGateway(friendDomainId: string, friendGatewayId: string): CrossDomainPeer | null {
		return (
			this.state.peers.find(
				(e) => e.friendDomainId === friendDomainId && e.friendGatewayId === friendGatewayId,
			) ?? null
		);
	}

	/** The peer whose friend gateway signing key matches, or null. A by-signPub lookup
	 * for a caller that already holds the peer's static signing key; the relay open path
	 * resolves by `(domainId, gatewayId)` instead, since the cleartext frame names no key. */
	resolveBySignPub(signPub: string): CrossDomainPeer | null {
		return this.state.peers.find((e) => e.friendSignPub === signPub) ?? null;
	}

	/** Drop every peer with this friend gateway id (across any Domain), returning the
	 * number removed. Lifecycle / unlink. */
	remove(friendGatewayId: string): number {
		const before = this.state.peers.length;
		this.state.peers = this.state.peers.filter((e) => e.friendGatewayId !== friendGatewayId);
		const removed = before - this.state.peers.length;
		if (removed > 0) this.persist();
		return removed;
	}

	/** A copy of all cross-Domain peers. */
	all(): CrossDomainPeer[] {
		return [...this.state.peers];
	}
}
