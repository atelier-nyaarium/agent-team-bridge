import { resolveAdmitted } from "../../shared/admission.js";
import { type KeyReceipt, verifyKeyReceipt } from "../../shared/key-delivery.js";
import { type MigrationExport, MigrationShareSchema } from "../../shared/schemasMigration.js";
import { SHARE_TTL_MS } from "../../shared/share-rules.js";
import type { EnrollmentState } from "../federationSecret.js";

export type MigrationPolicyRefusal = { name: string; reason: string };

export function validateOwners(
	snapshot: MigrationExport,
	enrollment: Record<string, EnrollmentState>,
): MigrationPolicyRefusal[] {
	return snapshot.owners.flatMap((owner) => {
		const domainId = owner.domainId ?? snapshot.domainId;
		const expected = enrollment[domainId]?.ownerSignPub;
		if (!expected || (owner.ownerSignPub ?? expected) !== expected)
			return [{ name: `${domainId}/${owner.ownerSignPub ?? owner.ownerId}`, reason: "owner_unknown" }];
		return [];
	});
}

export function validateShares(
	snapshot: MigrationExport,
	enrollment: Record<string, EnrollmentState>,
	now: number,
): MigrationPolicyRefusal[] {
	return snapshot.shares.flatMap((raw) => {
		const parsed = MigrationShareSchema.safeParse(raw);
		if (!parsed.success) return [{ name: "malformed", reason: "share_invalid" }];
		const share = parsed.data;
		if (now - share.lastSeenAt > SHARE_TTL_MS) return [{ name: share.sessionTarget, reason: "share_expired" }];
		if (share.target.kind === "domain") {
			const targetDomainId = share.target.domainId;
			const target = enrollment[targetDomainId];
			const source = enrollment[snapshot.domainId];
			if (
				!target ||
				!source?.ownerSignPub ||
				!source.linkEdges?.some((edge) => edge.edge.dstDomainId === targetDomainId)
			)
				return [{ name: share.sessionTarget, reason: "share_unlinked" }];
		}
		return [];
	});
}

export function missingKeyReceipts(
	snapshot: MigrationExport,
	enrollment: Record<string, EnrollmentState>,
	read: (domainId: string, id: string) => Record<string, unknown> | null,
): Array<{ member: string; epoch: number }> {
	const epochs = new Set<number>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (
			"v" in value &&
			value.v === 1 &&
			"epoch" in value &&
			typeof value.epoch === "number" &&
			"nonce" in value &&
			"ciphertext" in value
		)
			epochs.add(value.epoch);
		for (const child of Object.values(value)) visit(child);
	};
	visit(snapshot);
	const state = enrollment[snapshot.domainId];
	if (!state?.ownerSignPub) return [];
	const members = state.admissions
		.map((signed) => signed.admission.signPub)
		.filter((signPub) =>
			resolveAdmitted(state.admissions, state.revocations, state.ownerSignPub as string, signPub),
		);
	return [...epochs]
		.sort((a, b) => a - b)
		.flatMap((epoch) =>
			members
				.filter((member) => {
					const raw = read(snapshot.domainId, `${member}/${epoch}`);
					return !isValidReceipt(raw, snapshot.domainId, member, epoch);
				})
				.map((member) => ({ member, epoch })),
		);
}

function isValidReceipt(raw: Record<string, unknown> | null, domainId: string, member: string, epoch: number): boolean {
	if (!raw || raw.v !== 1 || raw.domainId !== domainId || raw.recipientSignPub !== member || raw.epoch !== epoch)
		return false;
	if (typeof raw.at !== "number" || !Number.isInteger(raw.at) || raw.at < 0) return false;
	if (typeof raw.nonce !== "string" || typeof raw.signature !== "string") return false;
	return verifyKeyReceipt(raw as unknown as KeyReceipt);
}
