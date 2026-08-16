import crypto from "node:crypto";

////////////////////////////////
//  Functions & Helpers

/** A stable, collision-resistant id for a raw signing public key (base64): the full
 * SHA-256 hex. Keys an owner's shared console inbox and the owner segment of a channel
 * SessionId. Lowercase hex (no `:` or `/`) so it is safe inside a SessionId segment,
 * and full-width (not the truncated display `fingerprint`) so two distinct owners
 * cannot collide onto one inbox. Switchboard-only: the Router never keys a console inbox, so
 * this stays out of the shared crypto core. */
export function ownerKeyId(signPubB64: string): string {
	return crypto.createHash("sha256").update(Buffer.from(signPubB64, "base64")).digest("hex");
}
