import { describe, expect, it } from "vitest";
import { buildRoster, type RosterDomain } from "../federation-server/roster.js";
import { type Admission, signAdmission, signRevocation } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";

const owner = generateIdentity();
const consoleKey = generateIdentity();
const guestOwner = generateIdentity();
const guestConsole = generateIdentity();

function admission(ownerKey: ReturnType<typeof generateIdentity>, consoleKeyPair: ReturnType<typeof generateIdentity>) {
	const value: Admission = {
		kind: "console",
		signPub: consoleKeyPair.sign.pub,
		boxPub: consoleKeyPair.box.pub,
		issuedAt: 1000,
		nonce: "nonce",
	};
	return signAdmission(value, ownerKey.sign.priv, ownerKey.sign.pub);
}

function domain(
	domainId: string,
	ownerKey: ReturnType<typeof generateIdentity>,
	consoleKeyPair: ReturnType<typeof generateIdentity>,
): RosterDomain {
	return {
		domainId,
		ownerSignPub: ownerKey.sign.pub,
		displayName: domainId,
		admissions: [admission(ownerKey, consoleKeyPair)],
		revocations: [],
	};
}

describe("buildRoster", () => {
	it("returns every rooted domain to an admitted console", () => {
		const result = buildRoster(
			consoleKey.sign.pub,
			[domain("admin", owner, consoleKey), domain("guest", guestOwner, guestConsole)],
			new Set(["guest"]),
		);
		expect(result).toEqual({
			ok: true,
			members: [
				{ ownerSignPub: owner.sign.pub, displayName: "admin", online: false },
				{ ownerSignPub: guestOwner.sign.pub, displayName: "guest", online: true },
			],
		});
	});

	it("opaque-rejects a non-member and excludes pending domains", () => {
		const stranger = generateIdentity();
		const pending: RosterDomain = {
			domainId: "pending",
			ownerSignPub: null,
			displayName: "Pending",
			admissions: [],
			revocations: [],
		};
		const result = buildRoster(stranger.sign.pub, [domain("admin", owner, consoleKey), pending], new Set());
		expect(result.ok).toBe(false);
		expect(String(result.error)).not.toContain("admin");
		const memberResult = buildRoster(consoleKey.sign.pub, [domain("admin", owner, consoleKey), pending], new Set());
		expect(memberResult.ok && memberResult.members?.some((member) => member.displayName === "Pending")).toBe(false);
	});

	it("removes a revoked console from membership", () => {
		const admitted = admission(guestOwner, guestConsole);
		const revocation = signRevocation(
			{ signPub: guestConsole.sign.pub, issuedAt: 2000, nonce: "revoke" },
			guestOwner.sign.priv,
			guestOwner.sign.pub,
		);
		const revoked: RosterDomain = {
			...domain("guest", guestOwner, guestConsole),
			admissions: [admitted],
			revocations: [revocation],
		};
		expect(buildRoster(guestConsole.sign.pub, [revoked], new Set()).ok).toBe(false);
	});
});
