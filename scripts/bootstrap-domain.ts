// Domain bootstrap for the console setup script (provision-console.sh --setup).
//
// The setup script is the SOLE bootstrap authority (no evie-DM, no QR). Running on
// the trusted host with cluster access, it roots the Domain and admits the Switch +
// a Console identity directly, then writes evie's federation Secret. This helper is
// the crypto core: it reuses the real crypto.ts/admission.ts so every signature
// verifies byte-for-byte on the arbiter (Bun) and the Android app (BouncyCastle).
//
// Trust posture: the OWNER root key stays host-side (persisted by the script, reused
// on later --setup runs to admit more devices). Only a CONSOLE identity rides the
// provisioning blob to the app - so the Domain root never leaves the host.
//
// I/O is bun-only (the script already requires bun; no python dependency). Inputs
// arrive as RAW strings on the ENVIRONMENT - never argv, which is world-readable in
// `ps` - and SB_EVIE_FED / SB_OWNER carry private keys:
//   env in:  SB_EVIE_FED   the live evie federation.json text (we extract .identity AND
//                          preserve its existing enrollment admissions/revocations)
//            SB_SW_IDENT   this Switch's federation-identity.json text (sign/box keys)
//            SB_SWITCH_ENV the container's SWITCH_ID env (authoritative id source)
//            SB_SWITCH_HOST the container hostname (fallback id source)
//            SB_OWNER      an existing owner identity to REUSE, or "null" to mint fresh
//   stdout:  { ownerIdentity, ownerSignPub, federationJson, consoleIdentity, switchId,
//             switchSignPub, switchBoxPub }

import { randomBytes } from "node:crypto";
import { type Admission, type SignedAdmission, signAdmission } from "../src/shared/admission.js";
import { generateIdentity, type Identity } from "../src/shared/crypto.js";
import { sanitizeSwitchId } from "../src/shared/host-id.js";

////////////////////////////////
//  Interfaces & Types

interface PriorEnrollment {
	admissions?: SignedAdmission[];
	revocations?: unknown[];
}

////////////////////////////////
//  Functions & Helpers

function nonce(): string {
	return randomBytes(18).toString("base64");
}

function reqEnv(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

/** Owner-sign an admission for a subject's keys. `now` + `nonce` are explicit so the
 * caller owns time/randomness (same contract as admissionFromScan). */
function admit(
	kind: "switch" | "console",
	signPub: string,
	boxPub: string,
	switchId: string | undefined,
	owner: Identity,
	now: number,
): SignedAdmission {
	const admission: Admission = { kind, signPub, boxPub, switchId, issuedAt: now, nonce: nonce() };
	return signAdmission(admission, owner.sign.priv, owner.sign.pub);
}

function main(): void {
	// evie's CURRENT identity - preserved verbatim so the write only ROOTS the Domain,
	// never re-mints evie's keypair (which would change its SAS).
	const evieFed = JSON.parse(reqEnv("SB_EVIE_FED")) as { identity?: Identity; enrollment?: PriorEnrollment };
	const evieIdentity = evieFed.identity;
	if (!evieIdentity?.sign?.pub || !evieIdentity?.box?.pub) {
		throw new Error("evie federation Secret has no usable identity (.identity.sign/.box)");
	}

	const swIdent = JSON.parse(reqEnv("SB_SW_IDENT")) as Identity;
	const switchSignPub = swIdent?.sign?.pub;
	const switchBoxPub = swIdent?.box?.pub;
	if (!switchSignPub || !switchBoxPub) throw new Error("Switch identity is missing sign/box public keys");

	// Resolve the Switch id the SAME way the arbiter does (resolveLocalSwitchId): the
	// SWITCH_ID env override, else the container hostname, run through the REAL
	// sanitizeSwitchId. Read from the container env (never rotatable `docker logs`), so the
	// id stamped on the admission always matches the id the arbiter registers under - a
	// mismatch would store the Switch keys under the wrong id and brick the Console.
	const switchId = sanitizeSwitchId(process.env.SB_SWITCH_ENV || process.env.SB_SWITCH_HOST || "switch");

	const ownerRaw = process.env.SB_OWNER ?? "null";
	const ownerReused = ownerRaw !== "null" && ownerRaw !== "";

	// node clock is unavailable to the model at authoring time but fine at runtime.
	const now = Date.now();

	// Reuse the owner root if the script kept one; otherwise mint it (first setup).
	const owner: Identity = ownerReused ? (JSON.parse(ownerRaw) as Identity) : generateIdentity();
	// The app's Console identity - admitted as kind:"console" so the arbiter trusts its
	// sealed ops. Fresh every run (a re-setup re-issues the console).
	const console_: Identity = generateIdentity();

	const switchAdmission = admit("switch", switchSignPub, switchBoxPub, switchId, owner, now);
	const consoleAdmission = admit("console", console_.sign.pub, console_.box.pub, undefined, owner, now);

	// Merge, do not clobber. When REUSING the owner, keep every OTHER Switch's admission +
	// any owner-enroll records + all revocations (rebuilding the block from scratch would
	// silently de-admit them). Drop this Switch's prior admission (the fresh one supersedes)
	// and any prior kind:console admission (single-console model: a re-run re-provisions the
	// one Console, and snapshot replacement de-admits the old console key). When MINTING a
	// fresh owner, start clean - prior admissions were signed by a different root and would
	// not verify under the new owner key anyway.
	const priorAdmissions = ownerReused ? (evieFed.enrollment?.admissions ?? []) : [];
	const priorRevocations = ownerReused ? (evieFed.enrollment?.revocations ?? []) : [];
	const kept = priorAdmissions.filter((a) => {
		const subject = a?.admission?.signPub;
		const kind = a?.admission?.kind;
		if (kind === "console") return false;
		if (subject === switchSignPub) return false;
		return true;
	});

	const federationJson = {
		identity: evieIdentity,
		enrollment: {
			ownerSignPub: owner.sign.pub,
			ownerBoxPub: owner.box.pub,
			admissions: [...kept, switchAdmission, consoleAdmission],
			revocations: priorRevocations,
		},
	};

	process.stdout.write(
		JSON.stringify({
			ownerIdentity: owner,
			ownerSignPub: owner.sign.pub,
			federationJson,
			consoleIdentity: console_,
			switchId,
			switchSignPub,
			switchBoxPub,
		}),
	);
}

main();
