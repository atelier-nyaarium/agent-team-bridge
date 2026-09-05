// Real Router, gateway graph, and pinned client over fake host and session sockets.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { RouterServer } from "../federation-server/routerServer.js";
import { loadRouterTls } from "../federation-server/routerTls.js";
import { composeGateway, type GatewayGraph } from "../gateway/composeGateway.js";
import type {
	CrossDomainListenResult,
	CrossDomainListenStateResult,
	CrossDomainRequestResult,
} from "../shared/console-protocol.js";
import { signXDomainLink } from "../shared/federation-protocol.js";
import { signXDomainLinkEdge } from "../shared/federation-xdomain-links.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { type FakeAmbient, fakeAmbient } from "./fakeAmbient.js";
import { attachFakeHost, createFakeCodexDaemon, type FakeHost, type FakeHostOptions } from "./fakeHost.js";
import { FixtureWorld } from "./fixtureWorld.js";
import { type IdentitySet, loadIdentitySet, mintIdentitySet, seedDomain, seedRouter } from "./identitySet.js";
import { createPhoneDriver, type PhoneDriver } from "./phoneDriver.js";

////////////////////////////////
//  Interfaces & Types

export interface FederationHarnessOptions {
	now?: () => number;
	/**
	 * "real" (the default) leaves every timer on the process clock, so the persist tick, the presence
	 * watch, the awareness tick, the inbox pump, and the reconciler make progress on their own.
	 * "manual" holds them until `ambient.advance` reaches their deadline.
	 */
	drive?: "real" | "manual";
	wakeTimeoutMs?: number;
	host?: Omit<FakeHostOptions, "token">;
	/** False boots the gateway with an empty keyring, so it must ask the phone for epoch 1. */
	seedContentKey?: boolean;
}

export interface GatewayComposeOptions {
	enrollNonce?: string;
	seedContentKey?: boolean;
	arming?: boolean;
}

export interface RouterOnlyHarness {
	root: string;
	set: IdentitySet;
	world: FixtureWorld;
	now: () => number;
	/** The Router's clock, entropy, and timers. */
	ambient: FakeAmbient;
	/** The ambient a gateway composed over `dir` runs on. */
	ambientFor: (dir: string) => FakeAmbient;
	router: { server: RouterServer; port: number; certFp: string; store: FileSecretStore; dataDir: string };
	phone: PhoneDriver;
	waitFor<T>(probe: () => Probe<T>, label: string, timeoutMs?: number): Promise<T>;
	composeGateway(options?: GatewayComposeOptions): GatewayGraph;
	/** Roots another Domain in the Router and composes its gateway over `dir`. */
	composeGatewayFor(set: IdentitySet, dir: string, options?: GatewayComposeOptions): GatewayGraph;
	/** A phone admitted to `set`'s Domain, over the same Router. */
	phoneFor(set: IdentitySet): PhoneDriver;
	close(): Promise<void>;
}

/** One Domain's live half: its gateway, host daemon, and phone. */
export interface DomainPeer {
	set: IdentitySet;
	world: FixtureWorld;
	federationDir: string;
	/** This peer's gateway clock, entropy, and timers. */
	ambient: FakeAmbient;
	gateway: GatewayGraph;
	host: FakeHost;
	phone: PhoneDriver;
	restartGateway(): Promise<void>;
	/** Reconnects the host daemon; `newDaemon` makes it a fresh process. */
	restartHost(restart?: { newDaemon?: boolean }): void;
	close(): Promise<void>;
}

export interface AddDomainOptions {
	domainId: string;
	gatewayId: string;
	host?: Omit<FakeHostOptions, "token">;
}

export interface LinkResult {
	/** The safety code both owners compared. */
	sas: string;
	pin: string;
	receiver: CrossDomainListenStateResult;
	requester: CrossDomainRequestResult;
}

export interface FederationHarness extends DomainPeer {
	root: string;
	now: () => number;
	/** The Router's own clock, entropy, and timers, apart from the home gateway's. */
	routerAmbient: FakeAmbient;
	router: { server: RouterServer; port: number; certFp: string; store: FileSecretStore; dataDir: string };
	/** Polls until `probe` answers a value; throws with `label` on the deadline. */
	waitFor<T>(probe: () => Probe<T>, label: string, timeoutMs?: number): Promise<T>;
	/** Closes the gateway graph and composes it again over the same directories, host reattached. */
	restartGateway(): Promise<void>;
	/** Replaces the Router while preserving its directory and port. */
	restartRouter(): Promise<void>;
	/** Roots a second Domain with its own gateway, host, and phone; closed with the harness. */
	addDomain(options: AddDomainOptions): Promise<DomainPeer>;
	/** Links two Domains through the Router's handshake and edges, both directions. */
	link(receiver: DomainPeer, requester: DomainPeer): Promise<LinkResult>;
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

const registered = (graph: GatewayGraph) =>
	waitFor(() => graph.faults.routerRegistered() || undefined, "gateway registration", 15_000);

export async function startFederationHarness(options: FederationHarnessOptions = {}): Promise<FederationHarness> {
	const base = await startRouterOnly({
		now: options.now,
		drive: options.drive,
		wakeTimeoutMs: options.wakeTimeoutMs,
	});
	const peers: DomainPeer[] = [];
	let home: DomainPeer;
	try {
		home = await attachDomain(base, base.set, path.join(base.root, "gateway"), {
			host: options.host,
			seedContentKey: options.seedContentKey,
		});
	} catch (error) {
		await base.close();
		throw error;
	}
	const harness: FederationHarness = {
		root: base.root,
		now: base.now,
		router: base.router,
		set: home.set,
		world: home.world,
		federationDir: home.federationDir,
		ambient: home.ambient,
		routerAmbient: base.ambient,
		get gateway() {
			return home.gateway;
		},
		get host() {
			return home.host;
		},
		phone: home.phone,
		waitFor,
		restartGateway: () => home.restartGateway(),
		restartHost: (restart) => home.restartHost(restart),
		restartRouter: async () => {
			await base.router.server.stop();
			// A restart reads the disk, not the old process's memory.
			const store = new FileSecretStore(base.router.dataDir);
			await store.init();
			const server = new RouterServer({
				port: base.router.port,
				dataDir: base.router.dataDir,
				consoleToken: base.set.tokens.console,
				federationToken: base.set.tokens.federation,
				store,
				tls: loadRouterTls(base.router.dataDir),
				ambient: base.ambient,
			});
			try {
				await server.start();
			} catch (error) {
				await server.stop().catch(() => undefined);
				throw error;
			}
			base.router.server = server;
			base.router.store = store;
			await registered(home.gateway);
			for (const peer of peers) await registered(peer.gateway);
		},
		addDomain: async (domainOptions) => {
			const set = mintIdentitySet({
				domainId: domainOptions.domainId,
				gatewayId: domainOptions.gatewayId,
				router: base.set.router.identity,
				// One Router, one app token; each machine its own host token.
				tokens: { ...base.set.tokens, host: `${domainOptions.domainId}-host-token` },
			});
			await seedDomain(base.router.store, set);
			const peer = await attachDomain(base, set, path.join(base.root, "domains", domainOptions.domainId), {
				host: domainOptions.host,
			});
			peers.push(peer);
			return peer;
		},
		link: (receiver, requester) => linkDomains(receiver, requester, base.now),
		close: async () => {
			for (const peer of peers.splice(0)) await peer.close();
			await home.close();
			await base.close();
		},
	};
	return harness;
}

async function attachDomain(
	base: RouterOnlyHarness,
	set: IdentitySet,
	gatewayDir: string,
	options: { host?: Omit<FakeHostOptions, "token">; seedContentKey?: boolean },
): Promise<DomainPeer> {
	const world = FixtureWorld.from(set);
	const federationDir = path.join(gatewayDir, "federation");
	const compose = () => base.composeGatewayFor(set, gatewayDir, { seedContentKey: options.seedContentKey });
	// The daemon process outlives the gateway; only restartHost replaces it.
	let daemon = createFakeCodexDaemon();
	const attachHost = (graph: GatewayGraph): FakeHost =>
		attachFakeHost(graph, {
			token: set.tokens.host,
			projects: [{ team: "fixture-app", projectPath: path.join(base.root, "fixture-app") }],
			...options.host,
			daemon,
		});
	let gateway: GatewayGraph | undefined;
	try {
		gateway = compose();
		await registered(gateway);
	} catch (error) {
		await gateway?.close().catch(() => undefined);
		throw error;
	}
	let currentGateway = gateway;
	let host = attachHost(currentGateway);
	return {
		set,
		world,
		federationDir,
		ambient: base.ambientFor(gatewayDir),
		get gateway() {
			return currentGateway;
		},
		get host() {
			return host;
		},
		phone: base.phoneFor(set),
		restartGateway: async () => {
			host.close();
			await currentGateway.close();
			currentGateway = compose();
			await registered(currentGateway);
			host = attachHost(currentGateway);
		},
		restartHost: (restart = {}) => {
			host.close();
			if (restart.newDaemon) daemon = createFakeCodexDaemon();
			host = attachHost(currentGateway);
		},
		close: async () => {
			host.close();
			await currentGateway.close();
		},
	};
}

/** Listen, pair, confirm, sign both edges. */
async function linkDomains(receiver: DomainPeer, requester: DomainPeer, now: () => number): Promise<LinkResult> {
	const listen = await receiver.phone.value({ kind: "cross_domain_listen" });
	const window = listen.result as CrossDomainListenResult;
	if (typeof window.listeningToken !== "string") throw new Error(`listen refused: ${JSON.stringify(listen.result)}`);
	const pin = randomBytes(9).toString("base64url");
	const requested = await requester.phone.value({
		kind: "cross_domain_request",
		listeningToken: window.listeningToken,
		pin,
		requesterOwnerSignPub: requester.set.domain.owner.sign.pub,
		requesterDomainId: requester.set.domain.id,
		requesterGatewayId: requester.set.gateway.id,
	});
	const pairing = requested.result as CrossDomainRequestResult;
	if (typeof pairing.sas !== "string") throw new Error(`request refused: ${JSON.stringify(requested.result)}`);
	const state = (
		await receiver.phone.value({ kind: "cross_domain_listen_state", listeningToken: window.listeningToken })
	).result as CrossDomainListenStateResult;
	if (!state.pairingArrived) throw new Error(`pairing never reached the receiver: ${JSON.stringify(state)}`);
	const confirm = async (mine: DomainPeer, friend: DomainPeer) => {
		const owner = mine.set.domain.owner;
		const answer = await mine.phone.value({
			kind: "cross_domain_confirm",
			pin,
			mySignedLink: signXDomainLink(
				{
					myOwnerSignPub: owner.sign.pub,
					peerOwnerSignPub: friend.set.domain.owner.sign.pub,
					peerDomainId: friend.set.domain.id,
					peerGatewayId: friend.set.gateway.id,
					peerSignPub: friend.set.gateway.identity.sign.pub,
					peerBoxPub: friend.set.gateway.identity.box.pub,
					issuedAt: now(),
					nonce: randomBytes(12).toString("base64"),
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		});
		if (answer.envelope.outcome !== "accepted" || (answer.result as { kind?: string })?.kind === "refusal")
			throw new Error(`confirm refused: ${JSON.stringify(answer.result)}`);
		const edge = await mine.phone.enroll({
			kind: "submit_xdomain_link",
			edge: signXDomainLinkEdge(
				{
					srcDomainId: mine.set.domain.id,
					dstDomainId: friend.set.domain.id,
					issuedAt: now(),
					nonce: randomBytes(12).toString("base64"),
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		});
		if (!edge.ok) throw new Error(`link edge refused: ${edge.error}`);
	};
	await confirm(receiver, requester);
	await confirm(requester, receiver);
	return { sas: pairing.sas, pin, receiver: state, requester: pairing };
}

export async function startRouterOnly(
	options: { now?: () => number; drive?: "real" | "manual"; wakeTimeoutMs?: number } = {},
): Promise<RouterOnlyHarness> {
	const set = loadIdentitySet();
	const world = FixtureWorld.from(set);
	const drive = options.drive ?? "real";
	const ambient = fakeAmbient({ now: options.now, drive });
	const now = () => ambient.now();
	// Each graph draws its own entropy, so two peers never mint the same nonce.
	const gatewayAmbients = new Map<string, FakeAmbient>();
	const ambientFor = (key: string): FakeAmbient => {
		let held = gatewayAmbients.get(key);
		if (!held) {
			held = fakeAmbient({ now: options.now, drive });
			gatewayAmbients.set(key, held);
		}
		return held;
	};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "federation-harness-"));
	const routerDir = path.join(root, "router");
	const gatewayDir = path.join(root, "gateway");
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
			ambient,
		});
		await server.start();
		const router = { server, port, certFp: tls.certFp, store, dataDir: routerDir };
		const composeGatewayFor = (
			gatewaySet: IdentitySet,
			dir: string,
			gatewayOptions: GatewayComposeOptions = {},
		): GatewayGraph => {
			const federationDir = path.join(dir, "federation");
			const gatewayAmbient = ambientFor(dir);
			if (!gatewayOptions.arming) {
				FixtureWorld.from(gatewaySet).gatewayBootstrap(
					federationDir,
					{ routerUrl: `https://127.0.0.1:${port}`, routerCertFp: tls.certFp },
					undefined,
					gatewayAmbient,
				);
				if (gatewayOptions.seedContentKey === false) fs.rmSync(path.join(federationDir, "content-keys.json"));
			}
			return composeGateway({
				config: {
					dataDir: dir,
					federationDir,
					logDir: path.join(dir, "log"),
					gatewayId: gatewaySet.gateway.id,
					maxBlobStoreBytes: MAX_BLOB_BYTES * 16,
					wakeTimeoutMs: options.wakeTimeoutMs ?? 10_000,
					enrollTlsPort: 0,
					enrollLanHost: "127.0.0.1",
					hostWsToken: gatewaySet.tokens.host,
					routerBootstrapUrl: null,
					...(gatewayOptions.enrollNonce ? { enrollNonce: gatewayOptions.enrollNonce } : {}),
				},
				ambient: gatewayAmbient,
				allowFixtureIdentity: true,
			});
		};
		const phoneFor = (phoneSet: IdentitySet): PhoneDriver =>
			createPhoneDriver({
				world: phoneSet === set ? world : FixtureWorld.from(phoneSet),
				handle: (request) => router.server.handle(request),
				now,
			});
		return {
			root,
			set,
			world,
			now,
			ambient,
			ambientFor,
			router,
			phone: phoneFor(set),
			waitFor,
			composeGateway: (gatewayOptions) => composeGatewayFor(set, gatewayDir, gatewayOptions),
			composeGatewayFor,
			phoneFor,
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
