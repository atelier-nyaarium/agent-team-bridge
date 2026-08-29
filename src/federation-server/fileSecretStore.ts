import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sweepAtomicTemps, writeFileAtomic } from "../shared/atomic-write.js";
import { generateIdentity, type Identity } from "../shared/crypto.js";
import { type CasBase, type CasMutation, MAX_WRITE_RETRIES, type WriteOutcome } from "./casEngine.js";
import { DELETE_SLICE, type DomainMutation, type SecretMutation } from "./casMutation.js";
import {
	type EnrollmentState,
	type EnrollmentStore,
	FEDERATION_SECRET_SCHEMA,
	type FederationSecret,
	migrateSecret,
	type SeenAdminNonce,
} from "./federationSecret.js";
import { ConflictError, type SecretIO } from "./secretIO.js";

////////////////////////////////
//  File IO

function versionOf(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(file: string, value: string): void {
	writeFileAtomic(file, value, { mode: 0o600, fsyncFile: true, fsyncDirectory: true });
}

class FileSecretIO implements SecretIO {
	public constructor(private readonly file: string) {}

	public async read(): Promise<{ value: FederationSecret; resourceVersion: string | null } | null> {
		sweepAtomicTemps(path.dirname(this.file));
		let serialized: string;
		try {
			serialized = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		return { value: JSON.parse(serialized) as FederationSecret, resourceVersion: versionOf(serialized) };
	}

	public async write(value: FederationSecret, resourceVersion: string | null): Promise<void> {
		const current = await this.read();
		if ((current?.resourceVersion ?? null) !== resourceVersion) {
			throw new ConflictError("federation file changed during write");
		}
		writeAtomic(this.file, JSON.stringify(value));
	}
}

////////////////////////////////
//  Class

export class FileSecretStore {
	private domains: Record<string, EnrollmentState> = {};
	private seenAdminNonces: SeenAdminNonce[] = [];
	private identity: Identity | null = null;
	private resourceVersion: string | null = null;
	private writeChain: Promise<void> = Promise.resolve();
	private pendingWrites = new Map<string, Promise<WriteOutcome>>();
	private readonly io: SecretIO;

	public constructor(dataDir: string, io?: SecretIO) {
		this.io = io ?? new FileSecretIO(path.join(dataDir, "federation.json"));
	}

	public async init(): Promise<Identity> {
		const existing = await this.io.read();
		if (existing) {
			const migrated = migrateSecret(existing.value);
			this.identity = migrated.identity;
			this.domains = migrated.enrollment;
			this.seenAdminNonces = migrated.seenAdminNonces ?? [];
			this.resourceVersion = existing.resourceVersion;
			return this.identity;
		}
		this.identity = generateIdentity();
		this.domains = {};
		this.seenAdminNonces = [];
		await this.io.write(
			{ schema: FEDERATION_SECRET_SCHEMA, identity: this.identity, enrollment: {}, seenAdminNonces: [] },
			null,
		);
		return this.identity;
	}

	public get persistedIdentity(): Identity {
		if (!this.identity) throw new Error("federation store not initialized");
		return this.identity;
	}

	public domainStore(domainId: string): EnrollmentStore {
		return { load: () => this.loadDomain(domainId), save: (state) => this.saveDomain(domainId, state) };
	}

	public loadDomain(domainId: string): EnrollmentState | null {
		return this.domains[domainId] ?? null;
	}

	public listDomains(): Array<{ domainId: string; state: EnrollmentState }> {
		return Object.entries(this.domains).map(([domainId, state]) => ({ domainId, state }));
	}

	public saveDomain(domainId: string, state: EnrollmentState): void {
		if (!this.identity) return;
		const next = structuredClone(state);
		const outcome = this.writeChain
			.then(() => this.persistDomain(domainId, next))
			.then<WriteOutcome>(() => ({ ok: true }))
			.catch(
				(error): WriteOutcome => ({
					ok: false,
					error: error instanceof Error ? error : new Error(String(error)),
				}),
			);
		this.writeChain = outcome.then(() => undefined);
		this.pendingWrites.set(domainId, outcome);
	}

	public async flushDomain(domainId: string): Promise<void> {
		const pending = this.pendingWrites.get(domainId);
		if (!pending) return;
		const result = await pending;
		if (!result.ok) throw result.error;
	}

	public adminDomainId(): string | null {
		const adminDomains = Object.entries(this.domains)
			.filter(([, state]) => state.isAdminDomain)
			.map(([domainId]) => domainId);
		if (adminDomains.length > 1) {
			console.warn(`[FileSecretStore] ambiguous admin domains: ${adminDomains.sort().join(", ")}`);
			return null;
		}
		return adminDomains[0] ?? null;
	}

	public loadSeenAdminNonces(): SeenAdminNonce[] {
		return this.seenAdminNonces.map((entry) => ({ ...entry }));
	}

	public async mutateDomain<T>(
		domainId: string,
		mutator: (current: EnrollmentState | null) => DomainMutation<T>,
	): Promise<T> {
		if (!this.identity) throw new Error("federation store not initialized");
		const run = this.writeChain.then(() => this.runMutateDomain(domainId, mutator));
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	public async mutateSecret<T>(
		mutator: (current: {
			enrollment: Record<string, EnrollmentState>;
			seenAdminNonces: SeenAdminNonce[];
		}) => SecretMutation<T>,
	): Promise<T> {
		if (!this.identity) throw new Error("federation store not initialized");
		const run = this.writeChain.then(() => this.runMutateSecret(mutator));
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async runCas<T>(mutator: (base: CasBase) => CasMutation<T>, label: string): Promise<T> {
		if (!this.identity) throw new Error("federation store not initialized");
		for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
			const fresh = await this.io.read();
			const base = fresh ? migrateSecret(fresh.value) : { identity: this.identity, enrollment: {} };
			const rv = fresh ? fresh.resourceVersion : this.resourceVersion;
			const decision = mutator({
				enrollment: structuredClone(base.enrollment),
				seenAdminNonces: (base.seenAdminNonces ?? []).map((entry) => ({ ...entry })),
				identity: base.identity ?? this.identity,
			});
			if (!decision.commit) {
				this.identity = base.identity ?? this.identity;
				this.domains = base.enrollment;
				this.seenAdminNonces = base.seenAdminNonces ?? [];
				this.resourceVersion = rv;
				return decision.value;
			}
			const enrollment = structuredClone(decision.enrollment);
			const seenAdminNonces = decision.seenAdminNonces.map((entry) => ({ ...entry }));
			try {
				await this.io.write(
					{
						schema: FEDERATION_SECRET_SCHEMA,
						identity: base.identity ?? this.identity,
						enrollment,
						seenAdminNonces,
					},
					rv,
				);
			} catch (error) {
				if (error instanceof ConflictError && attempt < MAX_WRITE_RETRIES - 1) continue;
				throw error;
			}
			this.identity = base.identity ?? this.identity;
			this.domains = enrollment;
			this.seenAdminNonces = seenAdminNonces;
			this.resourceVersion = null;
			return decision.value;
		}
		throw new ConflictError(`exhausted write retries for ${label}`);
	}

	private persistDomain(domainId: string, state: EnrollmentState): Promise<void> {
		return this.runCas((base) => {
			const next = structuredClone(state);
			if (base.enrollment[domainId]?.isAdminDomain && next.isAdminDomain === undefined) next.isAdminDomain = true;
			return {
				commit: true,
				enrollment: { ...base.enrollment, [domainId]: next },
				seenAdminNonces: base.seenAdminNonces,
				value: undefined,
			};
		}, `domain "${domainId}"`);
	}

	private runMutateDomain<T>(
		domainId: string,
		mutator: (current: EnrollmentState | null) => DomainMutation<T>,
	): Promise<T> {
		return this.runCas((base) => {
			const decision = mutator(base.enrollment[domainId] ?? null);
			if (!decision.commit) return { commit: false, value: decision.value };
			const enrollment = { ...base.enrollment };
			if (decision.next === DELETE_SLICE) delete enrollment[domainId];
			else enrollment[domainId] = structuredClone(decision.next);
			return { commit: true, enrollment, seenAdminNonces: base.seenAdminNonces, value: decision.value };
		}, `domain "${domainId}"`);
	}

	private runMutateSecret<T>(
		mutator: (current: {
			enrollment: Record<string, EnrollmentState>;
			seenAdminNonces: SeenAdminNonce[];
		}) => SecretMutation<T>,
	): Promise<T> {
		return this.runCas((base) => {
			const decision = mutator({ enrollment: base.enrollment, seenAdminNonces: base.seenAdminNonces });
			if (!decision.commit) return { commit: false, value: decision.value };
			return {
				commit: true,
				enrollment: decision.enrollment,
				seenAdminNonces: decision.seenAdminNonces,
				value: decision.value,
			};
		}, "the federation file");
	}
}
