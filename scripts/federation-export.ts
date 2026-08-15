import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const CONSOLE_SECRET = "console-bridge-app-token";
const CONSOLE_KEY = "CONSOLE_BRIDGE_TOKEN";
const IMAGE = "switchboard-federation-federation:latest";

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

/**
 * Write the state file, falling back to the container when the Router already root-owns the dir.
 * A re-export is the normal path after a failed cutover, and by then the host cannot write here.
 */
async function writeState(dataDir: string, blob: string): Promise<void> {
	const target = path.join(dataDir, DATA_KEY);
	mkdirSync(dataDir, { recursive: true });
	try {
		writeFileSync(target, blob, { mode: 0o600 });
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
	}

	if (!(await $`docker image inspect ${IMAGE}`.quiet().nothrow()).exitCode) {
		const staging = mkdtempSync(path.join(tmpdir(), "federation-export-"));
		try {
			writeFileSync(path.join(staging, DATA_KEY), blob, { mode: 0o600 });
			const script = `cp /in/${DATA_KEY} /data/${DATA_KEY} && chmod 600 /data/${DATA_KEY}`;
			const mounts = [`${staging}:/in:ro`, `${path.resolve(dataDir)}:/data`];
			const copy = await $`docker run --rm -v ${mounts[0]} -v ${mounts[1]} --entrypoint sh ${IMAGE} -c ${script}`
				.nothrow()
				.quiet();
			if (!copy.exitCode) return;
			console.error(copy.stderr.toString().trim());
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	throw new Error(
		`cannot write ${target} - it is owned by the Router. Run ./start-federation.sh once, or sudo rm it.`,
	);
}

/**
 * Carry the console app token across. It lives in its OWN Secret, not in the federation state, so
 * a state-only export leaves the Router minting a fresh one and every already-provisioned console
 * is turned away with a 401 it reports as "sign-in rejected".
 */
async function importConsoleToken(args: Args): Promise<"written" | "unchanged" | "absent"> {
	const extra = kubectlArgs(args);
	const read = await $`kubectl --kubeconfig=${args.kubeconfig} ${extra} -n ${NAMESPACE} \
		get secret ${CONSOLE_SECRET} -o jsonpath=${`{.data.${CONSOLE_KEY}}`}`
		.quiet()
		.nothrow();
	const encoded = read.exitCode ? "" : read.stdout.toString().trim();
	if (!encoded) return "absent";
	const token = Buffer.from(encoded, "base64").toString("utf8").trim();
	if (!token) return "absent";

	const envPath = path.resolve(".env");
	const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
	const rows = current.split("\n");
	const line = `${CONSOLE_KEY}=${token}`;
	if (rows.includes(line)) return "unchanged";

	// Never clobber an existing backup: the one worth keeping is the pre-cutover file, and a
	// second run would otherwise overwrite it with the already-migrated one.
	const backup = `${envPath}.bak-preRouter`;
	if (current && !existsSync(backup)) writeFileSync(backup, current, { mode: 0o600 });

	const kept = rows.filter((row) => !row.startsWith(`${CONSOLE_KEY}=`));
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	writeFileSync(envPath, `${[...kept, line].join("\n")}\n`, { mode: 0o600 });
	return "written";
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

await writeState(args.dataDir, first.blob);
const consoleToken = await importConsoleToken(args);

console.log(`Wrote ${path.join(args.dataDir, DATA_KEY)}`);
console.log(`  identity ${state.identity.sign.pub}`);
console.log(`  ${domains.length} domain(s), ${rooted} rooted`);
console.log(
	consoleToken === "absent"
		? `  WARNING: no ${CONSOLE_SECRET} in the cluster - set ${CONSOLE_KEY} in .env by hand or every console gets a 401`
		: `  ${CONSOLE_KEY} ${consoleToken === "written" ? "imported into .env" : "already matches the cluster"}`,
);
console.log("");
console.log("The identity is IMPORTED, never re-minted: enrolled devices resolve this Router by it.");
console.log("Next: ./start-federation.sh, then repoint the gateway's transport.json and restart it.");
console.log("Until the Router accepts its first mutation, repointing back to the cluster is still clean.");
