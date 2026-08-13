import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { CrossDomainPresenceConsumer } from "../gateway/federation/crossDomainPresence.js";
import { IntentTracker } from "../gateway/intent.js";
import { ReadAnchors, readAnchorsPlaneName } from "../gateway/readAnchors.js";
import type { WsData } from "../gateway/websocket.js";
import type { CrossDomainPeerEntry } from "../shared/console-protocol.js";
import { DurableStore } from "../shared/durable-store.js";
import type { CrossDomainPresenceSession } from "../shared/federation-protocol.js";
import { PlaneRegistry, stableHash } from "../shared/plane-registry.js";
import type { TeamInfo } from "../shared/types.js";
import { frame, makeHarness, OWNER } from "./helpers/console.js";

describe("poll: focus intent + presence piggyback", () => {
	function teamInfo(overrides: Partial<TeamInfo> & Pick<TeamInfo, "team">): TeamInfo {
		return { gatewayId: "test-host", status: "online", kind: "loose", queue_depth: 0, ...overrides };
	}

	// A minimal REAL presence plane (not a mock): a mutable rows array registered under the same
	// "presence" name consoleHandler.ts's poll case looks for, exercising the actual PlaneRegistry -
	// matching this codebase's convention of testing these small pure-state classes for real (see
	// routes.test.ts / federation.test.ts's own makePresence helpers).
	function makePresencePlane(initialRows: TeamInfo[] = []) {
		let rows = initialRows;
		const planeRegistry = new PlaneRegistry();
		planeRegistry.registerPlane<TeamInfo[]>({
			name: "presence",
			snapshot: () => rows,
			identityOf: (snapshot) => stableHash(snapshot),
		});
		return {
			planeRegistry,
			presence: { snapshot: () => rows },
			setRows: (next: TeamInfo[]) => {
				rows = next;
			},
		};
	}

	it("declares the device's focus intent, ramping its team's daemon-derivation cadence", async () => {
		const intentTracker = new IntentTracker();
		const h = makeHarness({}, { intentTracker });
		await h.handler.handleFrame(frame({ kind: "register" }));
		await h.handler.handleFrame(frame({ kind: "poll", focus: { screen: "board" } }, "p1"));
		expect(intentTracker.cadenceFor("any-team")).toBe(2_000);
	});

	it("a poll with no focus leaves an earlier declaration alone rather than clearing it", async () => {
		const intentTracker = new IntentTracker();
		const h = makeHarness({}, { intentTracker });
		await h.handler.handleFrame(frame({ kind: "register" }));
		await h.handler.handleFrame(frame({ kind: "poll", focus: { screen: "board" } }, "p1"));
		await h.handler.handleFrame(frame({ kind: "poll" }, "p2")); // no focus this time
		expect(intentTracker.cadenceFor("any-team")).toBe(2_000); // still ramped, not reset
	});

	it("a terminal focus ramps only its own team, at the device's configured rate", async () => {
		const intentTracker = new IntentTracker();
		const h = makeHarness({}, { intentTracker });
		await h.handler.handleFrame(frame({ kind: "register" }));
		await h.handler.handleFrame(
			frame({ kind: "poll", focus: { screen: "terminal", terminalTeam: "proj.a", terminalRateMs: 250 } }, "p1"),
		);
		expect(intentTracker.cadenceFor("proj.a")).toBe(250);
		expect(intentTracker.cadenceFor("proj.b")).toBe(60_000); // untouched
	});

	it("an absent knownPresenceVersions (legacy console) never attaches a presence plane", async () => {
		const { planeRegistry, presence } = makePresencePlane([teamInfo({ team: "team-a" })]);
		const h = makeHarness({}, { planeRegistry, presence });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "p1"));
		const result = reply.result as Record<string, unknown>;
		expect(result.presence).toBeUndefined();
		expect(result.presenceVersions).toBeUndefined();
		expect(result.settled).toBe("timeout");
	});

	it("an empty knownPresenceVersions (cold boot) ships the current presence snapshot immediately", async () => {
		const rows = [teamInfo({ team: "team-a" })];
		const { planeRegistry, presence } = makePresencePlane(rows);
		const h = makeHarness({}, { planeRegistry, presence });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(frame({ kind: "poll", knownPresenceVersions: [] }, "p1"));
		const result = reply.result as {
			presence?: TeamInfo[];
			presenceVersions?: { gateway: string; epoch: number; version: number }[];
			settled?: string;
		};
		expect(result.presence).toEqual(rows);
		expect(result.presenceVersions).toHaveLength(1);
		expect(result.presenceVersions?.[0].gateway).toBe("test-host");
		expect(result.settled).toBe("presence");
	});

	it("a matching presented version omits the presence piggyback entirely", async () => {
		const rows = [teamInfo({ team: "team-a" })];
		const { planeRegistry, presence } = makePresencePlane(rows);
		const h = makeHarness({}, { planeRegistry, presence });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll", knownPresenceVersions: [] }, "p1")))
			.result as { presenceVersions: { gateway: string; epoch: number; version: number }[] };

		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownPresenceVersions: first.presenceVersions }, "p2"),
		);
		const result = second.result as Record<string, unknown>;
		expect(result.presence).toBeUndefined();
		expect(result.presenceVersions).toBeUndefined();
		expect(result.settled).toBe("timeout");
	});

	it("a real mutation (markDirty) between polls ships the fresh snapshot on the next poll", async () => {
		const rows = [teamInfo({ team: "team-a" })];
		const { planeRegistry, presence, setRows } = makePresencePlane(rows);
		const h = makeHarness({}, { planeRegistry, presence });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll", knownPresenceVersions: [] }, "p1")))
			.result as { presenceVersions: { gateway: string; epoch: number; version: number }[] };

		setRows([teamInfo({ team: "team-a", status: "verifying" })]);
		planeRegistry.markDirty("presence");

		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownPresenceVersions: first.presenceVersions }, "p2"),
		);
		const result = second.result as { presence?: TeamInfo[]; settled?: string };
		expect(result.presence?.[0].status).toBe("verifying");
		expect(result.settled).toBe("presence");
	});

	it("a held poll wakes early on a presence bump, not the full hold", async () => {
		const rows = [teamInfo({ team: "team-a" })];
		const { planeRegistry, presence, setRows } = makePresencePlane(rows);
		const h = makeHarness({}, { planeRegistry, presence });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll", knownPresenceVersions: [] }, "p1")))
			.result as { presenceVersions: { gateway: string; epoch: number; version: number }[] };

		const held = h.handler.handleFrame(
			frame({ kind: "poll", holdMs: 5_000, knownPresenceVersions: first.presenceVersions }, "p2"),
		);
		await new Promise((r) => setTimeout(r, 20));
		setRows([teamInfo({ team: "team-a", status: "verifying" })]);
		planeRegistry.markDirty("presence");

		const start = Date.now();
		const reply = await held;
		expect(Date.now() - start).toBeLessThan(2_000); // woke on the bump, not the 5s hold
		const result = reply.result as { presence?: TeamInfo[]; settled?: string };
		expect(result.settled).toBe("presence");
		expect(result.presence?.[0].status).toBe("verifying");
	});

	it("mailbox entries win settled priority over a simultaneously-changed presence plane", async () => {
		const { planeRegistry, presence } = makePresencePlane([teamInfo({ team: "team-a" })]);
		const h = makeHarness({}, { planeRegistry, presence });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const peer = h.registry.get("pixel")?.get("conv-pixel") as unknown as ServerWebSocket<WsData>;
		peer.send(JSON.stringify({ type: "response_push", session_id: "s", response: "hi" }));

		// A cold-boot empty array also makes presence "changed", racing the already-filled mailbox.
		const reply = await h.handler.handleFrame(frame({ kind: "poll", knownPresenceVersions: [] }, "p1"));
		const result = reply.result as { entries: unknown[]; settled?: string };
		expect(result.entries).toHaveLength(1);
		expect(result.settled).toBe("mailbox");
	});
});

describe("poll: cross-Domain-presence piggyback", () => {
	function session(team: string): CrossDomainPresenceSession {
		return { team, gatewayId: "friend-gw", status: "online", kind: "devcontainer", queueDepth: 0 };
	}

	it("an absent knownCrossDomainPresenceVersions skips the plane entirely (a console build that predates it)", async () => {
		const planeRegistry = new PlaneRegistry();
		const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, undefined, 0);
		crossDomainPresenceConsumer.land("alice", [session("story")]);
		const h = makeHarness({}, { planeRegistry, crossDomainPresenceConsumer, linkedDomainIds: () => ["alice"] });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "p1"));
		const result = reply.result as Record<string, unknown>;
		expect(result.crossDomainPresence).toBeUndefined();
		expect(result.settled).toBe("timeout");
	});

	it("an EMPTY knownCrossDomainPresenceVersions ships every linked Domain's current content (cold boot)", async () => {
		const planeRegistry = new PlaneRegistry();
		const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, undefined, 0);
		crossDomainPresenceConsumer.land("alice", [session("story")]);
		const h = makeHarness({}, { planeRegistry, crossDomainPresenceConsumer, linkedDomainIds: () => ["alice"] });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(frame({ kind: "poll", knownCrossDomainPresenceVersions: [] }, "p1"));
		const result = reply.result as {
			crossDomainPresence?: Array<{ domainId: string; sessions: unknown[] }>;
			settled?: string;
		};
		expect(result.crossDomainPresence).toEqual([
			expect.objectContaining({ domainId: "alice", sessions: [session("story")] }),
		]);
		expect(result.settled).toBe("crossDomainPresence");
	});

	it("a matching presented version for the ONLY linked Domain omits the piggyback entirely", async () => {
		const planeRegistry = new PlaneRegistry();
		const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, undefined, 0);
		crossDomainPresenceConsumer.land("alice", [session("story")]);
		const h = makeHarness({}, { planeRegistry, crossDomainPresenceConsumer, linkedDomainIds: () => ["alice"] });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll", knownCrossDomainPresenceVersions: [] }, "p1")))
			.result as {
			crossDomainPresence: Array<{ domainId: string; version: { epoch: number; version: number } }>;
		};
		const known = first.crossDomainPresence.map((e) => ({
			domainId: e.domainId,
			epoch: e.version.epoch,
			version: e.version.version,
		}));

		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownCrossDomainPresenceVersions: known }, "p2"),
		);
		const result = second.result as Record<string, unknown>;
		expect(result.crossDomainPresence).toBeUndefined();
		expect(result.settled).toBe("timeout");
	});

	it("a fresh land() for one linked Domain ships only THAT Domain's updated content, not every linked Domain", async () => {
		const planeRegistry = new PlaneRegistry();
		const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, undefined, 0);
		crossDomainPresenceConsumer.land("alice", [session("story")]);
		crossDomainPresenceConsumer.land("bob", [session("app")]);
		const h = makeHarness(
			{},
			{ planeRegistry, crossDomainPresenceConsumer, linkedDomainIds: () => ["alice", "bob"] },
		);
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll", knownCrossDomainPresenceVersions: [] }, "p1")))
			.result as {
			crossDomainPresence: Array<{ domainId: string; version: { epoch: number; version: number } }>;
		};
		const known = first.crossDomainPresence.map((e) => ({
			domainId: e.domainId,
			epoch: e.version.epoch,
			version: e.version.version,
		}));

		crossDomainPresenceConsumer.land("alice", [session("story"), session("app2")]); // only alice changes

		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownCrossDomainPresenceVersions: known }, "p2"),
		);
		const result = second.result as { crossDomainPresence?: Array<{ domainId: string }> };
		expect(result.crossDomainPresence).toHaveLength(1);
		expect(result.crossDomainPresence?.[0].domainId).toBe("alice");
	});

	it("ensures a plane for every currently-linked Domain even before its first land(), so its later first push wakes an already-held poll", async () => {
		const planeRegistry = new PlaneRegistry();
		const crossDomainPresenceConsumer = new CrossDomainPresenceConsumer(planeRegistry, undefined, 0);
		// "carol" is linked but has never pushed anything yet.
		const h = makeHarness({}, { planeRegistry, crossDomainPresenceConsumer, linkedDomainIds: () => ["carol"] });
		await h.handler.handleFrame(frame({ kind: "register" }));

		// First poll: carol's plane is ensured (empty baseline) and, since nothing was known before,
		// ships immediately with empty content - same cold-boot semantics as any other plane.
		const first = (await h.handler.handleFrame(frame({ kind: "poll", knownCrossDomainPresenceVersions: [] }, "p1")))
			.result as {
			crossDomainPresence: Array<{ domainId: string; version: { epoch: number; version: number } }>;
		};
		const known = first.crossDomainPresence.map((e) => ({
			domainId: e.domainId,
			epoch: e.version.epoch,
			version: e.version.version,
		}));

		// Present carol's (still-empty) version and hold - only carol's first REAL push should wake it.
		const held = h.handler.handleFrame(
			frame({ kind: "poll", holdMs: 5_000, knownCrossDomainPresenceVersions: known }, "p2"),
		);
		await new Promise((r) => setTimeout(r, 20));
		crossDomainPresenceConsumer.land("carol", [session("story")]); // carol's first-ever real push

		const start = Date.now();
		const reply = await held;
		expect(Date.now() - start).toBeLessThan(2_000); // woke on the bump, not the 5s hold
		const result = reply.result as { crossDomainPresence?: Array<{ domainId: string }>; settled?: string };
		expect(result.settled).toBe("crossDomainPresence");
		expect(result.crossDomainPresence?.[0]?.domainId).toBe("carol");
	});
});

describe("poll: linked-peers piggyback", () => {
	function peerEntry(
		overrides: Partial<CrossDomainPeerEntry> & Pick<CrossDomainPeerEntry, "domainId">,
	): CrossDomainPeerEntry {
		return { gatewayId: "friend-gw", ownerSignPub: "friend-owner", ...overrides };
	}

	// A minimal REAL "linked-peers" plane (not a mock), mirroring makePresencePlane above - a
	// mutable rows array registered under the same name consoleHandler.ts's poll case looks for.
	function makeLinkedPeersPlane(initialPeers: CrossDomainPeerEntry[] = []) {
		let peers = initialPeers;
		const planeRegistry = new PlaneRegistry();
		planeRegistry.registerPlane<CrossDomainPeerEntry[]>({
			name: "linked-peers",
			snapshot: () => peers,
			identityOf: (snapshot) => stableHash(snapshot),
		});
		return {
			planeRegistry,
			setPeers: (next: CrossDomainPeerEntry[]) => {
				peers = next;
			},
		};
	}

	it("an absent knownLinkedPeersVersion ships the current roster unconditionally (legacy client or this session's cold boot alike)", async () => {
		const { planeRegistry } = makeLinkedPeersPlane([peerEntry({ domainId: "alice" })]);
		const h = makeHarness({}, { planeRegistry });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "p1"));
		const result = reply.result as {
			linkedPeers?: CrossDomainPeerEntry[];
			linkedPeersVersion?: { epoch: number; version: number };
			settled?: string;
		};
		expect(result.linkedPeers).toEqual([peerEntry({ domainId: "alice" })]);
		expect(result.linkedPeersVersion).toBeDefined();
		expect(result.settled).toBe("linkedPeers");
	});

	it("a matching presented version omits the linked-peers piggyback entirely", async () => {
		const { planeRegistry } = makeLinkedPeersPlane([peerEntry({ domainId: "alice" })]);
		const h = makeHarness({}, { planeRegistry });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			linkedPeersVersion: { epoch: number; version: number };
		};

		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownLinkedPeersVersion: first.linkedPeersVersion }, "p2"),
		);
		const result = second.result as Record<string, unknown>;
		expect(result.linkedPeers).toBeUndefined();
		expect(result.linkedPeersVersion).toBeUndefined();
		expect(result.settled).toBe("timeout");
	});

	it("a real mutation (markDirty) between polls ships the fresh roster on the next poll", async () => {
		const { planeRegistry, setPeers } = makeLinkedPeersPlane([peerEntry({ domainId: "alice" })]);
		const h = makeHarness({}, { planeRegistry });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			linkedPeersVersion: { epoch: number; version: number };
		};

		setPeers([peerEntry({ domainId: "alice" }), peerEntry({ domainId: "bob" })]);
		planeRegistry.markDirty("linked-peers");

		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownLinkedPeersVersion: first.linkedPeersVersion }, "p2"),
		);
		const result = second.result as { linkedPeers?: CrossDomainPeerEntry[]; settled?: string };
		expect(result.linkedPeers).toHaveLength(2);
		expect(result.settled).toBe("linkedPeers");
	});

	it("a held poll wakes early on a linked-peers bump, not the full hold", async () => {
		const { planeRegistry, setPeers } = makeLinkedPeersPlane([peerEntry({ domainId: "alice" })]);
		const h = makeHarness({}, { planeRegistry });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			linkedPeersVersion: { epoch: number; version: number };
		};

		const held = h.handler.handleFrame(
			frame({ kind: "poll", holdMs: 5_000, knownLinkedPeersVersion: first.linkedPeersVersion }, "p2"),
		);
		await new Promise((r) => setTimeout(r, 20));
		setPeers([peerEntry({ domainId: "alice" }), peerEntry({ domainId: "bob" })]);
		planeRegistry.markDirty("linked-peers");

		const start = Date.now();
		const reply = await held;
		expect(Date.now() - start).toBeLessThan(2_000); // woke on the bump, not the 5s hold
		const result = reply.result as { linkedPeers?: CrossDomainPeerEntry[]; settled?: string };
		expect(result.settled).toBe("linkedPeers");
		expect(result.linkedPeers).toHaveLength(2);
	});
});

describe("report_read + poll: read-anchors piggyback", () => {
	it("report_read is rejected when read-anchor sync is not wired", async () => {
		const h = makeHarness();
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(
			frame({ kind: "report_read", team: "team-a", epoch: 1, seq: 10 }, "p1"),
		);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not available");
	});

	it("report_read applies a genuine advance and echoes it back as `advanced: true`", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(
			frame({ kind: "report_read", team: "team-a", epoch: 1, seq: 10 }, "p1"),
		);
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ advanced: true });
		expect(readAnchors.snapshot()[OWNER]?.["team-a"]).toEqual({ epoch: 1, seq: 10, at: expect.any(Number) });
	});

	it("report_read with a stale (lower-seq, same-epoch) position echoes `advanced: false` and never regresses the stored anchor", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" }));
		await h.handler.handleFrame(frame({ kind: "report_read", team: "team-a", epoch: 1, seq: 50 }, "p1"));
		const reply = await h.handler.handleFrame(
			frame({ kind: "report_read", team: "team-a", epoch: 1, seq: 30 }, "p2"),
		);
		expect(reply.result).toEqual({ advanced: false });
		expect(readAnchors.snapshot()[OWNER]?.["team-a"].seq).toBe(50);
	});

	it("an absent knownReadAnchorsVersion ships this owner's current anchors unconditionally", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		readAnchors.report(OWNER, "team-a", { epoch: 1, seq: 10, at: 1000 });
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" }));
		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "p1"));
		const result = reply.result as {
			readAnchors?: { team: string; epoch: number; seq: number; at: number }[];
			readAnchorsVersion?: { epoch: number; version: number };
			settled?: string;
		};
		expect(result.readAnchors).toEqual([{ team: "team-a", epoch: 1, seq: 10, at: 1000 }]);
		expect(result.readAnchorsVersion).toBeDefined();
		expect(result.settled).toBe("readAnchors");
	});

	it("a matching presented version omits the read-anchors piggyback entirely", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		readAnchors.report(OWNER, "team-a", { epoch: 1, seq: 10, at: 1000 });
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			readAnchorsVersion: { epoch: number; version: number };
		};
		const second = await h.handler.handleFrame(
			frame({ kind: "poll", knownReadAnchorsVersion: first.readAnchorsVersion }, "p2"),
		);
		const result = second.result as Record<string, unknown>;
		expect(result.readAnchors).toBeUndefined();
		expect(result.readAnchorsVersion).toBeUndefined();
		expect(result.settled).toBe("timeout");
	});

	it("a report_read between two polls from another of the SAME owner's devices ships on the next poll", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			readAnchorsVersion?: { epoch: number; version: number };
		};
		// No knownReadAnchorsVersion was presented, so this plane ships unconditionally - same
		// absent-scalar-ships-current convention as linked-peers, even though nothing was reported yet.
		expect(first.readAnchorsVersion).toBeDefined();

		// A DIFFERENT device of the same owner reports a read position (matching frame()'s default
		// owner, just a different device/conversationId).
		await h.handler.handleFrame(
			frame({ kind: "report_read", team: "team-a", epoch: 1, seq: 5 }, "tablet-op1", "tablet", "conv-tablet"),
		);

		const second = await h.handler.handleFrame(frame({ kind: "poll" }, "p2"));
		const result = second.result as { readAnchors?: { team: string }[]; settled?: string };
		expect(result.readAnchors).toEqual([{ team: "team-a", epoch: 1, seq: 5, at: expect.any(Number) }]);
		expect(result.settled).toBe("readAnchors");
	});

	it("a held poll wakes early on a read-anchors bump, not the full hold", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		readAnchors.report(OWNER, "team-a", { epoch: 1, seq: 10, at: 1000 });
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" }));

		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			readAnchorsVersion: { epoch: number; version: number };
		};

		const held = h.handler.handleFrame(
			frame({ kind: "poll", holdMs: 5_000, knownReadAnchorsVersion: first.readAnchorsVersion }, "p2"),
		);
		await new Promise((r) => setTimeout(r, 20));
		readAnchors.report(OWNER, "team-a", { epoch: 1, seq: 20, at: 2000 });
		planeRegistry.markDirty(readAnchorsPlaneName(OWNER));

		const start = Date.now();
		const reply = await held;
		expect(Date.now() - start).toBeLessThan(2_000); // woke on the bump, not the 5s hold
		const result = reply.result as { readAnchors?: { seq: number }[]; settled?: string };
		expect(result.settled).toBe("readAnchors");
		expect(result.readAnchors?.[0].seq).toBe(20);
	});

	it("one owner's poll never sees a DIFFERENT owner's read-anchors plane", async () => {
		const planeRegistry = new PlaneRegistry();
		const readAnchors = new ReadAnchors(planeRegistry, undefined);
		readAnchors.report("a-different-owner-id", "team-a", { epoch: 1, seq: 999, at: 1000 });
		const h = makeHarness({}, { planeRegistry, readAnchors });
		await h.handler.handleFrame(frame({ kind: "register" })); // registers under the default OWNER
		const reply = await h.handler.handleFrame(frame({ kind: "poll" }, "p1"));
		const result = reply.result as Record<string, unknown>;
		// This owner's own (empty) plane ships - never the other owner's data, and never undefined
		// (absent knownReadAnchorsVersion always ships current truth, per the scalar-plane convention).
		expect(result.readAnchors).toEqual([]);
		expect(result.settled).toBe("readAnchors");
	});
});

describe("poll: task-board piggyback", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function makeBoardStore(registry: PlaneRegistry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poll-board-"));
		dirs.push(dir);
		return new BoardStore(new DurableStore(dir, "task-board"), registry, undefined);
	}

	it("a held poll wakes early on a board write, not the full hold", async () => {
		const planeRegistry = new PlaneRegistry();
		const boardStore = makeBoardStore(planeRegistry);
		const h = makeHarness({}, { planeRegistry, boardStore });
		await h.handler.handleFrame(frame({ kind: "register" }));

		// Same absent-scalar-ships-current convention as read-anchors: the empty board ships.
		const first = (await h.handler.handleFrame(frame({ kind: "poll" }, "p1"))).result as {
			taskBoard?: unknown[];
			taskBoardVersion: { epoch: number; version: number };
			settled?: string;
		};
		expect(first.taskBoard).toEqual([]);
		expect(first.settled).toBe("taskBoard");

		const held = h.handler.handleFrame(
			frame({ kind: "poll", holdMs: 5_000, knownTaskBoardVersion: first.taskBoardVersion }, "p2"),
		);
		await new Promise((r) => setTimeout(r, 20));
		// The store's own coalesced bump (BUMP_WINDOW_MS) is what wakes the poll.
		boardStore.upsert(OWNER, [{ id: "bd_1", title: "hang shelf", state: "open", rank: "m" }], OWNER_ACTOR);

		const start = Date.now();
		const reply = await held;
		expect(Date.now() - start).toBeLessThan(2_000); // woke on the bump, not the 5s hold
		const result = reply.result as { taskBoard?: { id: string }[]; settled?: string };
		expect(result.settled).toBe("taskBoard");
		expect(result.taskBoard?.map((e) => e.id)).toEqual(["bd_1"]);
	});
});
