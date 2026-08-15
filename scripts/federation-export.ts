import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";

////////////////////////////////
//  Constants
//
//  Import the live k8s federation state into the self-hosted Router's data dir. READ-ONLY against
//  the cluster: it reads one Secret and writes locally, so a failed run costs nothing and the old
//  path keeps serving.

const NAMESPACE = "evie-bot";
const SECRET = "evie-federation";
const DATA_KEY = "federation.json";

////////////////////////////////
//  Functions & Helpers

interface Args {
	dataDir: string;
	kubeconfig: string;
	server: string | null;
	tlsServerName: string | null;
	force: boolean;
}

function readArgs(): Args {
	const at = (name: string): string | null => {
		const index = Bun.argv.indexOf(name);
		return index >= 0 ? (Bun.argv[index + 1] ?? null) : null;
	};
	return {
		dataDir: at("--data-dir") ?? path.resolve("volumes/federation-data"),
		kubeconfig: at("--kubeconfig") ?? path.resolve("../evie-bot/kubeconfig.yaml"),
		server: at("--server"),
		tlsServerName: at("--tls-server-name"),
		force: Bun.argv.includes("--force"),
	};
}

function kubectlArgs(args: Args): string[] {
	const extra: string[] = [];
	if (args.server) extra.push(`--server=${args.server}`);
	if (args.tlsServerName) extra.push(`--tls-server-name=${args.tlsServerName}`);
	return extra;
}

/** Read the Secret and its resourceVersion together, so the caller can prove nothing moved. */
async function readSecret(args: Args): Promise<{ blob: string; version: string }> {
	const extra = kubectlArgs(args);
	const raw =
		await $`kubectl --kubeconfig=${args.kubeconfig} ${extra} -n ${NAMESPACE} get secret ${SECRET} -o json`.text();
	const parsed = JSON.parse(raw) as {
		data?: Record<string, string>;
		metadata?: { resourceVersion?: string };
	};
	const encoded = parsed.data?.[DATA_KEY];
	if (!encoded) throw new Error(`secret ${SECRET} carries no ${DATA_KEY}`);
	return {
		blob: Buffer.from(encoded, "base64").toString("utf8"),
		version: parsed.metadata?.resourceVersion ?? "",
	};
}

////////////////////////////////
//  Entry

const args = readArgs();

if (!args.force && existsSync(path.join(args.dataDir, DATA_KEY))) {
	console.error(`ERROR: ${path.join(args.dataDir, DATA_KEY)} already exists - pass --force to overwrite`);
	process.exit(1);
}

const running = await $`docker inspect -f '{{.State.Running}}' switchboard-federation`.quiet().nothrow().text();
if (running.trim() === "true") {
	console.error("ERROR: the Router is running and owns this file. Stop it first.");
	process.exit(1);
}

const first = await readSecret(args);
const state = JSON.parse(first.blob) as {
	identity?: { sign?: { pub?: string } };
	enrollment?: Record<string, { ownerSignPub?: string | null }>;
};

// Re-read after parsing: the export is only coherent if nothing wrote in between, and a moved
// resourceVersion means a live mutation raced this snapshot.
const second = await readSecret(args);
if (second.version !== first.version) {
	console.error(`ERROR: the Secret changed during export (${first.version} -> ${second.version}). Re-run.`);
	process.exit(1);
}

const domains = Object.entries(state.enrollment ?? {});
const rooted = domains.filter(([, slice]) => slice.ownerSignPub != null).length;
if (!state.identity?.sign?.pub) {
	console.error("ERROR: the Secret carries no identity keypair - refusing to write a Router that owns nothing.");
	process.exit(1);
}

mkdirSync(args.dataDir, { recursive: true });
writeFileSync(path.join(args.dataDir, DATA_KEY), first.blob, { mode: 0o600 });

console.log(`Wrote ${path.join(args.dataDir, DATA_KEY)}`);
console.log(`  identity ${state.identity.sign.pub}`);
console.log(`  ${domains.length} domain(s), ${rooted} rooted`);
console.log("");
console.log("The identity is IMPORTED, never re-minted: enrolled devices resolve this Router by it.");
console.log("Next: ./start-federation.sh, then repoint the gateway's transport.json and restart it.");
console.log("Until the Router accepts its first mutation, repointing back to the cluster is still clean.");
