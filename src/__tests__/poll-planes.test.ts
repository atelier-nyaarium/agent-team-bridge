import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../gateway/boardStore.js";
import { buildPollParticipants, type PollPlanesInput } from "../gateway/console/pollPlanes.js";
import { CrossDomainPresenceConsumer } from "../gateway/federation/crossDomainPresence.js";
import { ReadAnchors } from "../gateway/readAnchors.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import type { TeamInfo } from "../shared/types.js";

/**
 * The participant seam's own contract: which planes participate, in what order, and when their
 * reads happen. The end-to-end reply shapes stay covered by console-poll-piggyback.test.ts.
 */
describe("buildPollParticipants", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function makeBoardStore(registry: PlaneRegistry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poll-planes-"));
		dirs.push(dir);
		return new BoardStore(new DurableStore(dir, "task-board"), registry, undefined);
	}

	function makeRegistry(rows: TeamInfo[] = []) {
		const planeRegistry = new PlaneRegistry();
		planeRegistry.registerPlane<TeamInfo[]>({
			name: "presence",
			snapshot: () => rows,
			identityOf: (snapshot) => stableHash(snapshot),
		});
		planeRegistry.registerPlane<string[]>({
			name: "linked-peers",
			snapshot: () => [],
			identityOf: (snapshot) => stableHash(snapshot),
		});
		return planeRegistry;
	}

	function build(overrides: Partial<PollPlanesInput> = {}) {
		return buildPollParticipants({
			op: { kind: "poll" },
			ownerId: "owner-1",
			localGatewayId: "test-host",
			...overrides,
		});
	}

	it("orders participants by settled priority, which is what the caller's find() relies on", () => {
		const planeRegistry = makeRegistry();
		const participants = build({
			op: {
				kind: "poll",
				knownPresenceVersions: [],
				knownCrossDomainPresenceVersions: [],
			},
			planeRegistry,
			readAnchors: new ReadAnchors(planeRegistry, undefined),
			boardStore: makeBoardStore(planeRegistry),
			crossDomainPresenceConsumer: new CrossDomainPresenceConsumer(planeRegistry, undefined, 0),
			domain: () => null,
		});
		expect(participants.map((p) => p.settledAs)).toEqual([
			"presence",
			"crossDomainPresence",
			"linkedPeers",
			"readAnchors",
			"taskBoard",
			"domain",
		]);
	});

	it("gates each opt-in on its own wire field and each source on its own dep", () => {
		// No known-versions fields and no optional deps: only linked-peers participates, since a
		// single optional scalar cannot distinguish a pre-plane console from a cold boot.
		expect(build({ planeRegistry: makeRegistry() }).map((p) => p.settledAs)).toEqual(["linkedPeers"]);
		// No registry at all: only the domain keyring piggyback can participate.
		expect(build({ domain: () => null }).map((p) => p.settledAs)).toEqual(["domain"]);
		expect(build({})).toEqual([]);

		// Presence and cross-Domain presence are opt-ins: the dep alone is not enough, and the
		// wire field alone is not enough.
		const labels = (input: Partial<PollPlanesInput>) => build(input).map((p) => p.settledAs);
		const withConsumer = makeRegistry();
		expect(
			labels({
				planeRegistry: withConsumer,
				crossDomainPresenceConsumer: new CrossDomainPresenceConsumer(withConsumer, undefined, 0),
			}),
		).toEqual(["linkedPeers"]);
		expect(
			labels({
				op: { kind: "poll", knownPresenceVersions: [], knownCrossDomainPresenceVersions: [] },
				planeRegistry: makeRegistry(),
			}),
		).toEqual(["presence", "linkedPeers"]);

		// The per-owner scalar planes key on their dep alone: no wire field required.
		const withAnchors = makeRegistry();
		expect(labels({ planeRegistry: withAnchors, readAnchors: new ReadAnchors(withAnchors, undefined) })).toEqual([
			"linkedPeers",
			"readAnchors",
		]);
		const withBoard = makeRegistry();
		expect(labels({ planeRegistry: withBoard, boardStore: makeBoardStore(withBoard) })).toEqual([
			"linkedPeers",
			"taskBoard",
		]);
	});

	it("the domain piggyback cannot wake a held poll, and every registry plane can", () => {
		const participants = build({
			op: { kind: "poll", knownPresenceVersions: [] },
			planeRegistry: makeRegistry(),
			domain: () => ({ version: "v1", snapshot: { ownerSignPub: "pk", admissions: [], revocations: [] } }),
		});
		const byLabel = new Map(participants.map((p) => [p.settledAs, p]));
		expect(byLabel.get("domain")?.wait).toBeUndefined();
		expect(byLabel.get("presence")?.wait).toBeDefined();
		expect(byLabel.get("linkedPeers")?.wait).toBeDefined();
	});

	it("reads the keyring lazily and once, so a rotation during the hold is still caught", () => {
		let version = "v1";
		let reads = 0;
		const participants = build({
			op: { kind: "poll", knownDomainVersion: "v1" },
			domain: () => {
				reads += 1;
				return { version, snapshot: { ownerSignPub: "pk", admissions: [], revocations: [] } };
			},
		});
		const domain = participants[0];
		// Built pre-hold at v1 (unchanged); the rotation lands while the poll is held open.
		version = "v2";
		expect(domain.changed()).toBe(true);
		expect(domain.emit()).toMatchObject({ domainVersion: "v2" });
		// One read serves both: the settle label and the emission cannot see different keyrings.
		expect(reads).toBe(1);
	});

	it("changed() answers once, so the settle label and the emission cannot disagree", () => {
		const rows: TeamInfo[] = [];
		const planeRegistry = new PlaneRegistry();
		planeRegistry.registerPlane<TeamInfo[]>({
			name: "presence",
			snapshot: () => rows,
			identityOf: (snapshot) => stableHash(snapshot),
		});
		const current = planeRegistry.version("presence");
		const participants = build({
			op: {
				kind: "poll",
				knownPresenceVersions: [
					{ gateway: "test-host", epoch: current?.epoch ?? 0, version: current?.counter ?? 0 },
				],
			},
			planeRegistry,
		});
		const presence = participants[0];
		expect(presence.changed()).toBe(false);
		// A bump landing after the first answer must not flip it mid-assembly.
		rows.push({ gatewayId: "test-host", team: "late", status: "online", kind: "loose", queue_depth: 0 });
		planeRegistry.markDirty("presence");
		expect(presence.changed()).toBe(false);
		expect(presence.emit()).toEqual({});
	});
});
