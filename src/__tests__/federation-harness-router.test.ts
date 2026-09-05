import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrollCommitment, enrollSas, verifyEnrollCommitment } from "../shared/cross-domain-sas.js";
import { generateIdentity, type Identity, seal, unseal } from "../shared/crypto.js";
import { signRosterRequest, signTrustPendingRequest } from "../shared/federation-proofs.js";
import {
	signDeleteDomain,
	signFirstRoot,
	signProvisionTenant,
	signRemoveTenant,
	signSetDisplayName,
} from "../shared/federation-tenants.js";
import { ROUTER_PATHS } from "../shared/wire-vocabulary.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const b64 = (bytes = 12) => randomBytes(bytes).toString("base64");

interface RosterMember {
	ownerSignPub: string;
	displayName: string;
	online: boolean;
}

describe("the Router's own surfaces", () => {
	let h: FederationHarness;
	let bob: DomainPeer;
	const admin = () => h.set.domain.owner;
	const roster = async (): Promise<RosterMember[]> => {
		const signer = h.set.console.identity;
		const proofAt = h.now();
		const nonce = b64();
		const answer = await h.phone.console({
			roster: {
				signerSignPub: signer.sign.pub,
				proofAt,
				nonce,
				proof: signRosterRequest(signer.sign.pub, proofAt, nonce, signer.sign.priv),
			},
		});
		return (answer.body as { members?: RosterMember[] }).members ?? [];
	};
	const provision = (domainId: string, displayName: string, nonce = b64()) =>
		h.phone.enroll({
			kind: "provision_tenant",
			provision: signProvisionTenant(
				{ domainId, displayName, issuedAt: h.now(), nonce },
				admin().sign.priv,
				admin().sign.pub,
			),
		});
	const firstRoot = (domainId: string, owner: Identity, nonce: string) =>
		h.phone.console({
			firstRoot: signFirstRoot(
				{ domainId, ownerSignPub: owner.sign.pub, ownerBoxPub: owner.box.pub, nonce, issuedAt: h.now() },
				owner.sign.priv,
			),
		});

	beforeAll(async () => {
		h = await startFederationHarness();
		bob = await h.addDomain({ domainId: "bob", gatewayId: "desk" });
	}, 60_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	describe("tenant lifecycle", () => {
		const dave = generateIdentity();
		let invite = "";

		it("provisions a tenant the admin signed, and refuses the same signed op again, even after a restart", async () => {
			const nonce = b64();
			const first = await provision("dave", "Dave", nonce);
			expect(first.ok).toBe(true);
			invite = (first as { nonce?: string }).nonce ?? "";
			expect(invite).not.toBe("");
			expect((await provision("dave", "Dave", nonce)).ok).toBe(false);
			await h.restartRouter();
			expect((await provision("dave", "Dave", nonce)).ok).toBe(false);
		});

		it("refuses a provision signed by someone other than the admin", async () => {
			const stranger = generateIdentity();
			const forged = await h.phone.enroll({
				kind: "provision_tenant",
				provision: signProvisionTenant(
					{ domainId: "mallory", displayName: "Mallory", issuedAt: h.now(), nonce: b64() },
					stranger.sign.priv,
					stranger.sign.pub,
				),
			});
			expect(forged.ok).toBe(false);
		});

		it("roots the tenant once at the invited key, idempotently, and opaquely refuses everyone else", async () => {
			const wrongNonce = await firstRoot("dave", dave, b64(18));
			const noSuchDomain = await firstRoot("nobody", dave, invite);
			expect(wrongNonce.status).toBe(400);
			expect(noSuchDomain.body).toEqual(wrongNonce.body);

			expect((await firstRoot("dave", dave, invite)).status).toBe(200);
			expect((await firstRoot("dave", dave, invite)).status).toBe(200);
			const other = generateIdentity();
			const taken = await firstRoot("dave", other, invite);
			expect(taken.status).toBe(400);
			expect(taken.body).toEqual(wrongNonce.body);
			expect((await provision("dave", "Dave again")).ok).toBe(false);
			expect((await roster()).some((member) => member.ownerSignPub === dave.sign.pub)).toBe(true);
		});

		it("renames only under the rooted owner's key, once per nonce, and shows the name on the roster", async () => {
			const rename = (owner: Identity, displayName: string, nonce = b64(), domainId = "dave") =>
				h.phone.enroll({
					kind: "set_display_name",
					rename: signSetDisplayName(
						{ domainId, displayName, issuedAt: h.now(), nonce },
						owner.sign.priv,
						owner.sign.pub,
					),
				});
			expect((await rename(generateIdentity(), "Not Dave")).ok).toBe(false);
			const nonce = b64();
			expect((await rename(dave, "David", nonce)).ok).toBe(true);
			expect((await rename(dave, "Davey", nonce)).ok).toBe(false);
			const member = (await roster()).find((candidate) => candidate.ownerSignPub === dave.sign.pub);
			expect(member?.displayName).toBe("David");

			expect((await provision("frank", "Frank")).ok).toBe(true);
			expect((await rename(generateIdentity(), "Francis", b64(), "frank")).ok).toBe(false);
		});

		it("drops a pending tenant on removal, so its invite roots nothing", async () => {
			const staged = await provision("erin", "Erin");
			const erinInvite = (staged as { nonce?: string }).nonce ?? "";
			const removed = await h.phone.enroll({
				kind: "remove_tenant",
				removal: signRemoveTenant(
					{ domainId: "erin", issuedAt: h.now(), nonce: b64() },
					admin().sign.priv,
					admin().sign.pub,
				),
			});
			expect(removed.ok).toBe(true);
			expect((await firstRoot("erin", generateIdentity(), erinInvite)).status).toBe(400);
		});

		it("lets a rooted owner delete its own Domain and nobody else", async () => {
			const deletion = (owner: Identity) =>
				h.phone.enroll({
					kind: "delete_domain",
					deletion: signDeleteDomain(
						{ domainId: "dave", issuedAt: h.now(), nonce: b64() },
						owner.sign.priv,
						owner.sign.pub,
					),
				});
			expect((await deletion(generateIdentity())).ok).toBe(false);
			expect((await deletion(dave)).ok).toBe(true);
			expect((await roster()).some((member) => member.ownerSignPub === dave.sign.pub)).toBe(false);
		});
	});

	describe("device approval", () => {
		const approvalId = b64(16);
		const nonce = b64(18);
		const fresh = generateIdentity();
		const publicPost = (body: Record<string, unknown>) =>
			h.router.server.handle(
				new Request(`https://router.test${ROUTER_PATHS.deviceApproval}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		const held = (op: Record<string, unknown>) => h.phone.console({ consoleApproval: op });

		it("brokers a join to the held device and the sealed reply back to the fresh one", async () => {
			expect((await held({ step: "arm", approvalId, nonce })).body).toMatchObject({ ok: true });
			const joined = await publicPost({
				step: "join",
				approvalId,
				nonce,
				newSignPub: fresh.sign.pub,
				newBoxPub: fresh.box.pub,
				device: "Fresh phone",
			});
			expect(await joined.json()).toMatchObject({ ok: true });
			const polled = (await held({ step: "poll", approvalId })).body as { join?: { newSignPub: string } };
			expect(polled.join?.newSignPub).toBe(fresh.sign.pub);

			const sealed = seal(
				Buffer.from(JSON.stringify({ token: "sealed-transport" })),
				fresh.box.pub,
				admin().sign.priv,
			);
			expect((await held({ step: "approve", approvalId, sealed })).body).toMatchObject({ ok: true });
			const fetched = (await (await publicPost({ step: "fetch", approvalId, nonce })).json()) as {
				sealed?: typeof sealed;
			};
			expect(fetched.sealed).toBeDefined();
			const opened = JSON.parse(
				unseal(fetched.sealed as typeof sealed, fresh.box.priv, admin().sign.pub).toString("utf8"),
			);
			expect(opened).toEqual({ token: "sealed-transport" });
		});

		it("answers a wrong nonce and an unknown window alike, and keeps join and fetch off the token surface", async () => {
			const wrongNonce = await (await publicPost({ step: "fetch", approvalId, nonce: b64(18) })).json();
			const unknown = await (await publicPost({ step: "fetch", approvalId: b64(16), nonce })).json();
			expect(wrongNonce).toEqual(unknown);
			expect((await held({ step: "fetch", approvalId, nonce })).status).toBe(400);
			expect((await publicPost({ step: "poll", approvalId })).status).toBe(404);
		});

		it("cancels the window, after which nothing polls or fetches", async () => {
			expect((await held({ step: "cancel", approvalId })).body).toMatchObject({ ok: true });
			expect((await held({ step: "poll", approvalId })).body).toMatchObject({ ok: false });
			expect(await (await publicPost({ step: "fetch", approvalId, nonce })).json()).toMatchObject({ ok: false });
		});
	});

	describe("trust rendezvous", () => {
		const rendezvousId = b64(16);
		const party = (peer: DomainPeer) => ({
			ownerSignPub: peer.set.domain.owner.sign.pub,
			ownerBoxPub: peer.set.domain.owner.box.pub,
			domainId: peer.set.domain.id,
		});
		const salts = { initiator: b64(), target: b64() };
		const trust = (peer: DomainPeer, op: Record<string, unknown>) => peer.phone.console({ trustHandshake: op });
		const pending = async (peer: DomainPeer) => {
			const owner = peer.set.domain.owner;
			const proofAt = h.now();
			const nonce = b64();
			const answer = await peer.phone.console({
				trustPending: {
					signerSignPub: owner.sign.pub,
					proofAt,
					nonce,
					proof: signTrustPendingRequest(owner.sign.pub, proofAt, nonce, owner.sign.priv),
				},
			});
			return (
				(answer.body as { pending?: Array<{ initiatorOwnerSignPub: string; rendezvousId: string }> }).pending ??
				[]
			);
		};

		it("arms toward a target only that owner can discover, then completes commit and reveal on both sides", async () => {
			const armed = await trust(h, {
				step: "arm",
				rendezvousId,
				initiatorOwnerSignPub: party(h).ownerSignPub,
				targetOwnerSignPub: party(bob).ownerSignPub,
				commitment: enrollCommitment(party(h), "ADMIN", salts.initiator),
			});
			expect(armed.body).toMatchObject({ ok: true });
			expect(await pending(bob)).toEqual([{ initiatorOwnerSignPub: party(h).ownerSignPub, rendezvousId }]);
			expect(await pending(h)).toEqual([]);

			const stranger = await trust(bob, {
				step: "join",
				rendezvousId,
				joinerOwnerSignPub: generateIdentity().sign.pub,
				commitment: enrollCommitment(party(bob), "ENROLLEE", salts.target),
			});
			expect(stranger.body).toMatchObject({ ok: false });
			const joined = (
				await trust(bob, {
					step: "join",
					rendezvousId,
					joinerOwnerSignPub: party(bob).ownerSignPub,
					commitment: enrollCommitment(party(bob), "ENROLLEE", salts.target),
				})
			).body as { ok: boolean; peerCommitment?: string };
			expect(joined.peerCommitment).toBe(enrollCommitment(party(h), "ADMIN", salts.initiator));

			const revealedByInitiator = (
				await trust(h, {
					step: "reveal",
					rendezvousId,
					side: "INITIATOR",
					reveal: { ...party(h), salt: salts.initiator },
				})
			).body as { peerReveal?: { ownerSignPub: string; ownerBoxPub: string; domainId: string; salt: string } };
			expect(revealedByInitiator.peerReveal).toBeUndefined();
			const revealedByTarget = (
				await trust(bob, {
					step: "reveal",
					rendezvousId,
					side: "TARGET",
					reveal: { ...party(bob), salt: salts.target },
				})
			).body as { peerReveal?: { ownerSignPub: string; ownerBoxPub: string; domainId: string; salt: string } };
			const seenByTarget = revealedByTarget.peerReveal;
			if (!seenByTarget) throw new Error("the target never saw the initiator's reveal");
			expect(verifyEnrollCommitment(joined.peerCommitment ?? "", seenByTarget, "ADMIN", seenByTarget.salt)).toBe(
				true,
			);
			const seenByInitiator = (
				(
					await trust(h, {
						step: "reveal",
						rendezvousId,
						side: "INITIATOR",
						reveal: { ...party(h), salt: salts.initiator },
					})
				).body as { peerReveal?: { ownerSignPub: string; ownerBoxPub: string; domainId: string; salt: string } }
			).peerReveal;
			if (!seenByInitiator) throw new Error("the initiator never saw the target's reveal");
			expect(enrollSas(seenByTarget, party(bob), rendezvousId)).toBe(
				enrollSas(party(h), seenByInitiator, rendezvousId),
			);
			expect(await pending(bob)).toEqual([]);
		});

		it("refuses a replayed discovery proof and forgets a cancelled rendezvous", async () => {
			const owner = bob.set.domain.owner;
			const proofAt = h.now();
			const nonce = b64();
			const query = {
				trustPending: {
					signerSignPub: owner.sign.pub,
					proofAt,
					nonce,
					proof: signTrustPendingRequest(owner.sign.pub, proofAt, nonce, owner.sign.priv),
				},
			};
			const secondId = b64(16);
			await trust(h, {
				step: "arm",
				rendezvousId: secondId,
				initiatorOwnerSignPub: party(h).ownerSignPub,
				targetOwnerSignPub: party(bob).ownerSignPub,
				commitment: enrollCommitment(party(h), "ADMIN", b64()),
			});
			expect((await bob.phone.console(query)).body).toMatchObject({ pending: [{ rendezvousId: secondId }] });
			expect((await bob.phone.console(query)).body).toMatchObject({ pending: [] });

			expect((await trust(h, { step: "cancel", rendezvousId: secondId })).body).toMatchObject({ ok: true });
			expect(await pending(bob)).toEqual([]);
			const late = await trust(bob, {
				step: "join",
				rendezvousId: secondId,
				joinerOwnerSignPub: party(bob).ownerSignPub,
				commitment: enrollCommitment(party(bob), "ENROLLEE", b64()),
			});
			expect(late.body).toMatchObject({ ok: false });
		});
	});
});
