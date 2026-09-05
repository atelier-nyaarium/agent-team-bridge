// Sole vault seal/open boundary; approvals gate values.

import {
	VAULT_GATEWAYS_KIND,
	VAULT_PRIVATE_DESCRIPTION_KIND,
	VAULT_PRIVATE_TITLE_KIND,
	VAULT_PUBLIC_DESCRIPTION_KIND,
	VAULT_PUBLIC_TITLE_KIND,
	VAULT_TYPED_KIND,
	VAULT_VALUE_KIND,
	type VaultFieldKind,
	vaultAadKind,
} from "../../shared/content-envelope.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import {
	type VaultEntrySealed,
	type VaultFieldName,
	VaultListResultSchema,
	type VaultStoredEntry,
	VaultWriteResultSchema,
} from "../../shared/schemasVault.js";
import { foldVersionedList } from "../../shared/versioned-list.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";

export interface VaultEntryView {
	id: string;
	revision: number;
	createdBy: VaultStoredEntry["clear"]["createdBy"];
	createdAt: number;
	updatedAt: number;
	publicTitle: string | null;
	publicDescription: string | null;
	privateTitle: string | null;
	privateDescription: string | null;
	allowlist: VaultAllowlist;
	hasValue: boolean;
}

/** Unreadable allowlists deny access. */
export type VaultAllowlist = { kind: "everyone" } | { kind: "gateways"; ids: string[] } | { kind: "unreadable" };

export interface VaultClientDeps {
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
	domainId: string;
	gatewayId: string;
	ownerSignPub: () => string | null;
	keys: Pick<ContentKeyStore, "seal" | "open">;
}

export type VaultRefresh = { kind: "ok"; revision: number } | { kind: "unavailable"; error: string };
export type VaultCreateAnswer =
	| { kind: "applied" }
	| { kind: "refused"; refusal: string }
	| { kind: "unavailable"; error: string };

const FIELD_KINDS: Record<Exclude<VaultFieldName, "value">, VaultFieldKind> = {
	publicTitle: VAULT_PUBLIC_TITLE_KIND,
	publicDescription: VAULT_PUBLIC_DESCRIPTION_KIND,
	privateTitle: VAULT_PRIVATE_TITLE_KIND,
	privateDescription: VAULT_PRIVATE_DESCRIPTION_KIND,
	gateways: VAULT_GATEWAYS_KIND,
};

export function createVaultClient(deps: VaultClientDeps) {
	let held: { revision: number; entries: Map<string, VaultStoredEntry> } | null = null;

	const sealText = (text: string, kind: VaultFieldKind, entryId: string): ContentEnvelope | null => {
		const ownerSignPub = deps.ownerSignPub();
		if (!ownerSignPub) return null;
		const sealed = deps.keys.seal(Buffer.from(text, "utf8"), {
			domainId: deps.domainId,
			ownerSignPub,
			kind: vaultAadKind(kind, entryId),
		});
		return sealed.kind === "ok" ? sealed.envelope : null;
	};

	const openText = (envelope: ContentEnvelope, kind: VaultFieldKind, entryId: string): string | null => {
		const ownerSignPub = deps.ownerSignPub();
		if (!ownerSignPub) return null;
		const opened = deps.keys.open(envelope, {
			domainId: deps.domainId,
			ownerSignPub,
			epoch: envelope.epoch,
			kind: vaultAadKind(kind, entryId),
		});
		return opened.kind === "ok" ? opened.plaintext.toString("utf8") : null;
	};

	/** The shared fold decides; a restart lists from zero. */
	async function refresh(): Promise<VaultRefresh> {
		const answer = await deps.call("vault_read", held ? { sinceRevision: held.revision } : {});
		if (answer.error) return { kind: "unavailable", error: answer.error };
		if ((answer.result as { outcome?: unknown } | undefined)?.outcome === "durability_uncertain")
			return { kind: "unavailable", error: "vault durability is uncertain" };
		const parsed = VaultListResultSchema.safeParse(answer.result);
		if (!parsed.success) return { kind: "unavailable", error: "malformed vault_read answer" };
		const fold = foldVersionedList(
			{ revision: held?.revision ?? 0, entries: [...(held?.entries.values() ?? [])] },
			parsed.data,
			{ id: (entry) => entry.clear.id, revision: (entry) => entry.clear.revision },
		);
		if (fold.kind === "restart") {
			held = null;
			return refresh();
		}
		if (fold.kind === "ignore") return { kind: "ok", revision: held?.revision ?? 0 };
		held = { revision: fold.revision, entries: new Map(fold.entries.map((entry) => [entry.clear.id, entry])) };
		return { kind: "ok", revision: fold.revision };
	}

	const live = (): VaultStoredEntry[] =>
		[...(held?.entries.values() ?? [])].filter((entry) => !entry.clear.tombstone);

	const stored = (id: string): VaultStoredEntry | undefined => {
		const entry = held?.entries.get(id);
		return entry && !entry.clear.tombstone ? entry : undefined;
	};

	/** Views exclude vault values. */
	function view(entry: VaultStoredEntry): VaultEntryView {
		const open = (name: Exclude<VaultFieldName, "value">): string | null => {
			const envelope = entry.sealed[name];
			return envelope ? openText(envelope, FIELD_KINDS[name], entry.clear.id) : null;
		};
		return {
			id: entry.clear.id,
			revision: entry.clear.revision,
			createdBy: entry.clear.createdBy,
			createdAt: entry.clear.createdAt,
			updatedAt: entry.clear.updatedAt,
			publicTitle: open("publicTitle"),
			publicDescription: open("publicDescription"),
			privateTitle: open("privateTitle"),
			privateDescription: open("privateDescription"),
			allowlist: allowlistOf(entry),
			hasValue: entry.sealed.value !== undefined,
		};
	}

	function allowlistOf(entry: VaultStoredEntry): VaultAllowlist {
		if (!entry.sealed.gateways) return { kind: "everyone" };
		const text = openText(entry.sealed.gateways, VAULT_GATEWAYS_KIND, entry.clear.id);
		if (text === null) return { kind: "unreadable" };
		try {
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) return { kind: "unreadable" };
			return { kind: "gateways", ids: parsed };
		} catch {
			return { kind: "unreadable" };
		}
	}

	const allowedHere = (entry: VaultEntryView): boolean =>
		entry.allowlist.kind === "everyone" ||
		(entry.allowlist.kind === "gateways" && entry.allowlist.ids.includes(deps.gatewayId));

	const openValue = (entry: VaultStoredEntry): string | null =>
		entry.sealed.value ? openText(entry.sealed.value, VAULT_VALUE_KIND, entry.clear.id) : null;

	/** Typed values bind to requests. */
	const openTyped = (envelope: ContentEnvelope, requestId: string): string | null =>
		openText(envelope, VAULT_TYPED_KIND, requestId);

	/** Gateway writes fresh entries only. */
	async function create(input: {
		id: string;
		publicTitle: string;
		publicDescription?: string;
		value: string;
	}): Promise<VaultCreateAnswer> {
		const publicTitle = sealText(input.publicTitle, VAULT_PUBLIC_TITLE_KIND, input.id);
		const value = sealText(input.value, VAULT_VALUE_KIND, input.id);
		const publicDescription =
			input.publicDescription === undefined
				? undefined
				: sealText(input.publicDescription, VAULT_PUBLIC_DESCRIPTION_KIND, input.id);
		if (!publicTitle || !value || (input.publicDescription !== undefined && !publicDescription))
			return { kind: "unavailable", error: "no content key for this Domain" };
		const sealed: VaultEntrySealed = { publicTitle, value, ...(publicDescription ? { publicDescription } : {}) };
		const answer = await deps.call("vault_create", { put: { id: input.id, expectedRevision: 0, sealed } });
		if (answer.error) return { kind: "unavailable", error: answer.error };
		const parsed = VaultWriteResultSchema.safeParse(answer.result);
		if (!parsed.success) return { kind: "unavailable", error: "malformed vault_create answer" };
		if (parsed.data.outcome === "applied") return { kind: "applied" };
		return { kind: "refused", refusal: parsed.data.refusal ?? "exists" };
	}

	return { refresh, live, stored, view, allowedHere, openValue, openTyped, create };
}

export type VaultClient = ReturnType<typeof createVaultClient>;
