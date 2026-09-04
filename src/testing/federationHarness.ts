// Real Router, real gateway graph, real pinned client; the host and the sessions are fake sockets.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { RouterServer } from "../federation-server/routerServer.js";
import { loadRouterTls } from "../federation-server/routerTls.js";
import { composeGateway, type GatewayGraph } from "../gateway/composeGateway.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { attachFakeHost, type FakeHost, type FakeHostOptions } from "./fakeHost.js";
import { FixtureWorld } from "./fixtureWorld.js";
import { type IdentitySet, loadIdentitySet, seedRouter } from "./identitySet.js";
import { createPhoneDriver, type PhoneDriver } from "./phoneDriver.js";

////////////////////////////////
//  Interfaces & Types

export interface FederationHarnessOptions {
	now?: () => number;
	wakeTimeoutMs?: number;
	host?: Omit<FakeHostOptions, "token">;
	/** False boots the gateway with an empty keyring, so it must ask the phone for epoch 1. */
	seedContentKey?: boolean;
}

export interface RouterOnlyHarness {
	root: string;
	set: IdentitySet;
	now: () => number;
	router: { server: RouterServer; port: number; certFp: string; store: FileSecretStore; dataDir: string };
	phone: PhoneDriver;
	waitFor<T>(probe: () => Probe<T>, label: string, timeoutMs?: number): Promise<T>;
	composeGateway(options?: { enrollNonce?: string; seedContentKey?: boolean; arming?: boolean }): GatewayGraph;
	close(): Promise<void>;
}

export interface FederationHarness {
	root: string;
	set: IdentitySet;
	now: () => number;
	router: { server: RouterServer; port: number; certFp: string; store: FileSecretStore; dataDir: string };
	gateway: GatewayGraph;
	host: FakeHost;
	phone: PhoneDriver;
	/** Polls until `probe` answers a value; throws with `label` on the deadline. */
	waitFor<T>(probe: () => Probe<T>, label: string, timeoutMs?: number): Promise<T>;
	/** Closes the gateway graph and composes it again over the same directories, host reattached. */
	restartGateway(): Promise<void>;
	/** Replaces the Router while preserving its directory and port. */
	restartRouter(): Promise<void>;
	close(): Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

type Probe<T> = T | undefined | null | false | Promise<T | undefined | null | false>;

export async function waitFor<T>(probe: () => Probe<T>, label: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export async function startFederationHarness(options: FederationHarnessOptions = {}): Promise<FederationHarness> {
	const base = await startRouterOnly({ now: options.now, wakeTimeoutMs: options.wakeTimeoutMs });
	const registered = (graph: GatewayGraph) =>
		waitFor(() => graph.federation()?.routerClient.isRegistered() || undefined, "gateway registration", 15_000);
	const attachHost = (graph: GatewayGraph): FakeHost =>
		attachFakeHost(graph, {
			token: base.set.tokens.host,
			projects: [{ team: "fixture-app", projectPath: path.join(base.root, "fixture-app") }],
			...options.host,
		});
	let gateway: GatewayGraph | undefined;
	try {
		gateway = base.composeGateway({ seedContentKey: options.seedContentKey });
		await registered(gateway);
	} catch (error) {
		await gateway?.close().catch(() => undefined);
		await base.close();
		throw error;
	}
	let currentGateway = gateway;
	let host = attachHost(currentGateway);
	const harness: FederationHarness = {
		...base,
		get gateway() {
			return currentGateway;
		},
		get host() {
			return host;
		},
		waitFor,
		restartGateway: async () => {
			host.close();
			await currentGateway.close();
			currentGateway = base.composeGateway({ seedContentKey: options.seedContentKey });
			await registered(currentGateway);
			host = attachHost(currentGateway);
		},
		restartRouter: async () => {
			await base.router.server.stop();
			const server = new RouterServer({
				port: base.router.port,
				dataDir: base.router.dataDir,
				consoleToken: base.set.tokens.console,
				federationToken: base.set.tokens.federation,
				store: base.router.store,
				tls: loadRouterTls(base.router.dataDir),
				now: base.now,
			});
			try {
				await server.start();
			} catch (error) {
				await server.stop().catch(() => undefined);
				throw error;
			}
			base.router.server = server;
			await registered(currentGateway);
		},
		close: async () => {
			host.close();
			await currentGateway.close();
			await base.close();
		},
	};
	return harness;
}

export async function startRouterOnly(
	options: { now?: () => number; wakeTimeoutMs?: number } = {},
): Promise<RouterOnlyHarness> {
	const set = loadIdentitySet();
	const world = FixtureWorld.from(set);
	const now = options.now ?? Date.now;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "federation-harness-"));
	const routerDir = path.join(root, "router");
	const gatewayDir = path.join(root, "gateway");
	const federationDir = path.join(gatewayDir, "federation");
	try {
		const store = await seedRouter(routerDir, set);
		const tls = loadRouterTls(routerDir);
		const port = await availablePort();
		const server = new RouterServer({
			port,
			dataDir: routerDir,
			consoleToken: set.tokens.console,
			federationToken: set.tokens.federation,
			store,
			tls,
			now,
		});
		await server.start();
		const router = { server, port, certFp: tls.certFp, store, dataDir: routerDir };
		const composeGatewayForHarness = (
			gatewayOptions: { enrollNonce?: string; seedContentKey?: boolean; arming?: boolean } = {},
		): GatewayGraph => {
			if (!gatewayOptions.arming) {
				world.gatewayBootstrap(federationDir, {
					routerUrl: `https://127.0.0.1:${port}`,
					routerCertFp: tls.certFp,
				});
				if (gatewayOptions.seedContentKey === false) fs.rmSync(path.join(federationDir, "content-keys.json"));
			}
			return composeGateway({
				config: {
					dataDir: gatewayDir,
					federationDir,
					logDir: path.join(root, "log"),
					gatewayId: set.gateway.id,
					maxBlobStoreBytes: MAX_BLOB_BYTES * 16,
					wakeTimeoutMs: options.wakeTimeoutMs ?? 10_000,
					enrollTlsPort: 0,
					enrollLanHost: "127.0.0.1",
					hostWsToken: set.tokens.host,
					routerBootstrapUrl: null,
					...(gatewayOptions.enrollNonce ? { enrollNonce: gatewayOptions.enrollNonce } : {}),
				},
				now,
				allowFixtureIdentity: true,
			});
		};
		const phone = createPhoneDriver({ world, handle: (request) => router.server.handle(request), now });
		return {
			root,
			set,
			now,
			router,
			phone,
			waitFor,
			composeGateway: composeGatewayForHarness,
			close: async () => {
				await router.server.stop();
				fs.rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

async function availablePort(): Promise<number> {
	const listener = net.createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => resolve());
	});
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("port probe did not bind");
	const port = address.port;
	await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
	return port;
}
