// Real Router, real gateway graph, real pinned client; the host and the sessions are fake sockets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { RouterServer } from "../federation-server/routerServer.js";
import { loadRouterTls } from "../federation-server/routerTls.js";
import { composeGateway, type GatewayGraph } from "../gateway/composeGateway.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { attachFakeHost, type FakeHost, type FakeHostOptions } from "./fakeHost.js";
import { type IdentitySet, loadIdentitySet, seedGateway, seedRouter } from "./identitySet.js";
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
	const set = loadIdentitySet();
	const now = options.now ?? Date.now;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "federation-harness-"));
	const routerDir = path.join(root, "router");
	const gatewayDir = path.join(root, "gateway");
	const federationDir = path.join(gatewayDir, "federation");
	try {
		const store = await seedRouter(routerDir, set);
		const tls = loadRouterTls(routerDir);
		const server = new RouterServer({
			port: 0,
			dataDir: routerDir,
			consoleToken: set.tokens.console,
			federationToken: set.tokens.federation,
			store,
			tls,
			now,
		});
		await server.start();
		const port = server.listeningPort;
		if (port === null) throw new Error("router did not bind");

		seedGateway(
			federationDir,
			set,
			{ routerUrl: `https://127.0.0.1:${port}`, routerCertFp: tls.certFp },
			{ contentKey: options.seedContentKey },
		);

		const compose = (): GatewayGraph =>
			composeGateway({
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
				},
				now,
				allowFixtureIdentity: true,
			});
		const registered = (graph: GatewayGraph) =>
			waitFor(() => graph.federation()?.routerClient.isRegistered() || undefined, "gateway registration", 15_000);
		const attachHost = (graph: GatewayGraph): FakeHost =>
			attachFakeHost(graph, {
				token: set.tokens.host,
				projects: [{ team: "fixture-app", projectPath: path.join(root, "fixture-app") }],
				...options.host,
			});

		let gateway = compose();
		await registered(gateway);
		let host = attachHost(gateway);
		const phone = createPhoneDriver({ set, handle: (request) => server.handle(request), now });

		const harness: FederationHarness = {
			root,
			set,
			now,
			router: { server, port, certFp: tls.certFp, store, dataDir: routerDir },
			get gateway() {
				return gateway;
			},
			get host() {
				return host;
			},
			phone,
			waitFor,
			restartGateway: async () => {
				host.close();
				await gateway.close();
				gateway = compose();
				await registered(gateway);
				host = attachHost(gateway);
			},
			close: async () => {
				host.close();
				await gateway.close();
				await server.stop();
				fs.rmSync(root, { recursive: true, force: true });
			},
		};
		return harness;
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
