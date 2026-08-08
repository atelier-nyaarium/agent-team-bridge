import crypto from "node:crypto";

////////////////////////////////
//  Functions & Helpers

export function randomId(): string {
	return crypto.randomBytes(3).toString("hex");
}

/** The session binding secret. Unlike the 6-hex id (a display/address segment that only needs to be
 * unique within its spawn), this is guessing-resistant: it is the only thing standing between a
 * neighbouring container and this session's name. */
export function randomBindToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

export function bindingTokensEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}
