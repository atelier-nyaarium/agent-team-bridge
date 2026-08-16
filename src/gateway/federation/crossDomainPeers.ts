import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SignedXDomainLinkSchema } from "../../shared/federation-protocol.js";

////////////////////////////////
//  Schemas

/** A Gateway owned by a different owner (a different Domain) that this Gateway has
 * linked with. Keyed by `(friendDomainId, friendGatewayId)` because a gateway id is
 * not globally unique across Domains. The seal trust root is `friendBoxPub` (from the
 * SAS-verified reveal); the link is an audit artifact, signed under this Domain's own
 * owner key since each owner confirms its own side independently. */
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
	// The local owner's signed link, verifiable under this Domain's own owner key.
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

/** The cross-Domain peer set, persisted to the Gateway's volume at 0600. Disjoint from
 * the local allowlist: written only by the handshake, never by `allowlist.applySnapshot`
 * or any Router-relayed snapshot, so a local-Domain sync can never wipe it and it cannot
 * contaminate intra-Domain resolution. The sealer resolves local peers first, then falls
 * back here, so a local peer's seal path is unchanged. */
export class CrossDomainPeers {
	private file: string;
	private state: CrossDomainPeersFile;
	private readonly onChange?: () => void;

	/** `onChange` fires once per genuine mutation (persist() is the one place every mutator below
	 * funnels through) - the single-writer hook the linked-peers plane's markDirty rides, so a
	 * link/unlink/untrust can never forget to announce itself the way a scattered callsite could. */
	constructor(dataDir: string, onChange?: () => void) {
		this.file = path.join(dataDir, XDOMAIN_PEERS_FILE);
		this.state = this.read();
		this.onChange = onChange;
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
		this.onChange?.();
	}

	/** Add or replace a cross-Domain peer. Idempotent on `(friendDomainId,
	 * friendGatewayId)`: a re-link replaces the prior entry (newest keys win) rather than
	 * accumulating duplicates. Returns false if the peer is malformed. */
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

	/** The peer whose friend gateway signing key matches, or null. For a caller that
	 * already holds the static signing key; the relay open path resolves by
	 * `(domainId, gatewayId)` instead, since the cleartext frame names no key. */
	resolveBySignPub(signPub: string): CrossDomainPeer | null {
		return this.state.peers.find((e) => e.friendSignPub === signPub) ?? null;
	}

	/** Drop every peer with this friend gateway id (across any Domain), returning the
	 * number removed. Targeted per-gateway remove; an unlink drops the whole Domain via
	 * removeByDomain. */
	remove(friendGatewayId: string): number {
		const before = this.state.peers.length;
		this.state.peers = this.state.peers.filter((e) => e.friendGatewayId !== friendGatewayId);
		const removed = before - this.state.peers.length;
		if (removed > 0) this.persist();
		return removed;
	}

	/** Drop every peer of a friend Domain, across all its gateways, returning the number
	 * removed. The unlink granularity: forgetting all of a Domain's gateways at once makes
	 * resolveByGateway return null for any of them, so both seal legs refuse. */
	removeByDomain(friendDomainId: string): number {
		const before = this.state.peers.length;
		this.state.peers = this.state.peers.filter((e) => e.friendDomainId !== friendDomainId);
		const removed = before - this.state.peers.length;
		if (removed > 0) this.persist();
		return removed;
	}

	/** Drop every peer owned by a friend owner, across all their Domains and gateways,
	 * returning the count removed plus the distinct friend Domain ids affected. The untrust
	 * granularity (owner-keyed): one owner may run several Domains, and untrusting the person
	 * forgets all of them so the sealer refuses all of them. The returned Domain ids let the
	 * caller drop the per-session shares and settle in-flight jobs for exactly those Domains. */
	removeByOwner(friendOwnerSignPub: string): { removed: number; domains: string[] } {
		const owned = this.state.peers.filter((e) => e.friendOwnerSignPub === friendOwnerSignPub);
		const domains = [...new Set(owned.map((e) => e.friendDomainId))];
		if (owned.length > 0) {
			this.state.peers = this.state.peers.filter((e) => e.friendOwnerSignPub !== friendOwnerSignPub);
			this.persist();
		}
		return { removed: owned.length, domains };
	}

	/** A copy of all cross-Domain peers. */
	all(): CrossDomainPeer[] {
		return [...this.state.peers];
	}
}
