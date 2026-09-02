import type { DomainSnapshot } from "../../shared/admission.js";
import { taskBoardPlaneName } from "../../shared/board-structure.js";
import type {
	ConsoleOp,
	ConsolePollResult,
	CrossDomainPeerEntry,
	CrossDomainPresenceEntry,
	ReadAnchorWireEntry,
} from "../../shared/console-protocol.js";
import type { PlaneRegistry, PlaneVersion } from "../../shared/plane-registry.js";
import type { TeamInfo } from "../../shared/types.js";
import type { BoardProjection, BoardStore } from "../boardStore.js";
import { type CrossDomainPresenceConsumer, crossDomainPresencePlaneName } from "../federation/crossDomainPresence.js";
import { type ReadAnchors, readAnchorsPlaneName } from "../readAnchors.js";

////////////////////////////////
//  Interfaces & Types

type PollOp = Extract<ConsoleOp, { kind: "poll" }>;

/** The piggyback slice of the poll reply: every optional field a plane may attach. */
export type PollPiggyback = Partial<
	Pick<
		ConsolePollResult,
		| "domain"
		| "domainVersion"
		| "presence"
		| "presenceVersions"
		| "linkedPeers"
		| "linkedPeersVersion"
		| "readAnchors"
		| "readAnchorsVersion"
		| "taskBoard"
		| "taskBoardVersion"
		| "taskBoardTruncated"
		| "crossDomainPresence"
	>
>;

export type PollSettledCause = Exclude<NonNullable<ConsolePollResult["settled"]>, "mailbox" | "timeout">;

/**
 * One plane's whole poll participation: its hold wake-up, its changed-check, and its wire slice.
 * Built PRE-hold (plane registration and the presented maps must exist before the hold, or a
 * plane's first bump cannot wake it); every read runs lazily POST-hold so a bump during the hold
 * is visible. `changed()` is memoized - the settle label and the emission see one answer.
 */
export interface PollParticipant {
	settledAs: PollSettledCause;
	/** Absent for a participant that cannot wake a held poll (the domain keyring piggyback). */
	wait?: (holdMs: number) => Promise<unknown>;
	changed(): boolean;
	/** The flat wire slice; {} when a changed plane has no version yet (settled still names it). */
	emit(): PollPiggyback;
}

export interface PollPlanesInput {
	op: PollOp;
	ownerId: string;
	localGatewayId: string;
	planeRegistry?: PlaneRegistry;
	presence?: { snapshot(): TeamInfo[] };
	readAnchors?: ReadAnchors;
	boardStore?: BoardStore;
	crossDomainPresenceConsumer?: CrossDomainPresenceConsumer;
	linkedDomainIds?: () => string[];
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
}

////////////////////////////////
//  Functions & Helpers

/** A registry-backed participant: one changedSince answers both the settle label and emission. */
function registryParticipant(args: {
	registry: PlaneRegistry;
	settledAs: PollSettledCause;
	planes: Set<string>;
	presented: Map<string, PlaneVersion>;
	emit: (changedNames: string[]) => PollPiggyback;
}): PollParticipant {
	let changedNames: string[] | undefined;
	const changed = () => {
		changedNames ??= args.registry.changedSince(args.presented, args.planes);
		return changedNames.length > 0;
	};
	return {
		settledAs: args.settledAs,
		wait: (holdMs) => args.registry.waitForBump(args.presented, holdMs, args.planes),
		changed,
		emit: () => (changed() && changedNames ? args.emit(changedNames) : {}),
	};
}

/**
 * The poll's plane participants, in settled-priority order (mailbox outranks all of these and
 * timeout is the fallback; both belong to the caller). Adding a plane here is the WHOLE addition:
 * the hold race, the settle label and the reply slice all derive from this array.
 *
 * A participant exists only when its source is wired and, where the wire field is an opt-in
 * (presence, cross-Domain presence), the console actually sent it - a build that never sends the
 * field gets no participation at all: no hold wake-up and no reply field.
 */
export function buildPollParticipants(input: PollPlanesInput): PollParticipant[] {
	const { op, ownerId, localGatewayId, planeRegistry, domain } = input;
	const participants: PollParticipant[] = [];

	if (planeRegistry && op.knownPresenceVersions) {
		// Only this Gateway's own entry maps to a locally-registered plane; a foreign source is
		// simply absent, which changedSince/waitForBump treat as "unknown, ship current truth".
		const presented = new Map<string, PlaneVersion>();
		const own = op.knownPresenceVersions.find((v) => v.gateway === localGatewayId);
		if (own) presented.set("presence", { epoch: own.epoch, counter: own.version });
		participants.push(
			registryParticipant({
				registry: planeRegistry,
				settledAs: "presence",
				planes: new Set(["presence"]),
				presented,
				emit: () => {
					const version = planeRegistry.version("presence");
					if (!version) return {};
					return {
						presence: input.presence?.snapshot() ?? [],
						presenceVersions: [{ gateway: localGatewayId, epoch: version.epoch, version: version.counter }],
					};
				},
			}),
		);
	}

	if (planeRegistry && input.crossDomainPresenceConsumer && op.knownCrossDomainPresenceVersions) {
		const consumer = input.crossDomainPresenceConsumer;
		// Genuinely N independently-versioned planes, one per linked Domain. Every linked Domain's
		// plane is ensured NOW, pre-hold: a plane that does not exist yet cannot wake a held poll
		// on its own first bump (PlaneRegistry.wake's membership-gated dispatch).
		const linkedIds = input.linkedDomainIds ? input.linkedDomainIds() : [];
		for (const id of linkedIds) consumer.ensureRegistered(id);
		const planeToDomain = new Map(linkedIds.map((id) => [crossDomainPresencePlaneName(id), id]));
		const presented = new Map<string, PlaneVersion>();
		for (const v of op.knownCrossDomainPresenceVersions) {
			presented.set(crossDomainPresencePlaneName(v.domainId), { epoch: v.epoch, counter: v.version });
		}
		participants.push(
			registryParticipant({
				registry: planeRegistry,
				settledAs: "crossDomainPresence",
				planes: new Set(planeToDomain.keys()),
				presented,
				// Ships only the changed subset, never a full resend; one consumer snapshot per poll.
				emit: (changedNames) => {
					const landedSnapshot = consumer.snapshot();
					const out: CrossDomainPresenceEntry[] = [];
					for (const name of changedNames) {
						const domainId = planeToDomain.get(name);
						const version = planeRegistry.version(name);
						if (!domainId || !version) continue;
						const landed = landedSnapshot?.[domainId];
						out.push({
							domainId,
							version: { epoch: version.epoch, version: version.counter },
							sessions: landed?.sessions ?? [],
							lastRefreshedAt: landed?.lastRefreshedAt ?? 0,
						});
					}
					return { crossDomainPresence: out };
				},
			}),
		);
	}

	if (planeRegistry) {
		// Always participates when the registry is wired: a single optional scalar cannot
		// distinguish a pre-plane console from a cold boot, and both want "ship current truth".
		const presented = new Map<string, PlaneVersion>();
		if (op.knownLinkedPeersVersion) {
			presented.set("linked-peers", {
				epoch: op.knownLinkedPeersVersion.epoch,
				counter: op.knownLinkedPeersVersion.version,
			});
		}
		participants.push(
			registryParticipant({
				registry: planeRegistry,
				settledAs: "linkedPeers",
				planes: new Set(["linked-peers"]),
				presented,
				emit: () => {
					const version = planeRegistry.version("linked-peers");
					if (!version) return {};
					return {
						linkedPeers: planeRegistry.snapshot<CrossDomainPeerEntry[]>("linked-peers") ?? [],
						linkedPeersVersion: { epoch: version.epoch, version: version.counter },
					};
				},
			}),
		);
	}

	if (planeRegistry && input.readAnchors) {
		// PER OWNER (see readAnchors.ts), registered lazily on this owner's own first poll.
		input.readAnchors.ensureRegistered(ownerId);
		const plane = readAnchorsPlaneName(ownerId);
		const presented = new Map<string, PlaneVersion>();
		if (op.knownReadAnchorsVersion) {
			presented.set(plane, {
				epoch: op.knownReadAnchorsVersion.epoch,
				counter: op.knownReadAnchorsVersion.version,
			});
		}
		participants.push(
			registryParticipant({
				registry: planeRegistry,
				settledAs: "readAnchors",
				planes: new Set([plane]),
				presented,
				emit: () => {
					const version = planeRegistry.version(plane);
					if (!version) return {};
					return {
						readAnchors: planeRegistry.snapshot<ReadAnchorWireEntry[]>(plane) ?? [],
						readAnchorsVersion: { epoch: version.epoch, version: version.counter },
					};
				},
			}),
		);
	}

	if (planeRegistry && input.boardStore) {
		// Same per-owner, lazily-registered, single-scalar shape as read-anchors.
		input.boardStore.ensureRegistered(ownerId);
		const plane = taskBoardPlaneName(ownerId);
		const presented = new Map<string, PlaneVersion>();
		if (op.knownTaskBoardVersion) {
			presented.set(plane, {
				epoch: op.knownTaskBoardVersion.epoch,
				counter: op.knownTaskBoardVersion.version,
			});
		}
		participants.push(
			registryParticipant({
				registry: planeRegistry,
				settledAs: "taskBoard",
				planes: new Set([plane]),
				presented,
				emit: () => {
					const version = planeRegistry.version(plane);
					if (!version) return {};
					const projection = planeRegistry.snapshot<BoardProjection>(plane);
					return {
						taskBoard: projection?.entries ?? [],
						taskBoardVersion: { epoch: version.epoch, version: version.counter },
						...(projection?.truncated ? { taskBoardTruncated: true } : {}),
					};
				},
			}),
		);
	}

	if (domain) {
		// The keyring piggyback predates the registry and is not a plane: it has no wait, so a
		// rotation alone never wakes a held poll. The read is lazy and memoized - post-hold, so a
		// rotation DURING the hold is still caught by whatever else settled the poll.
		let read: { version: string; snapshot: DomainSnapshot } | null | undefined;
		const dom = () => {
			if (read === undefined) read = domain();
			return read;
		};
		participants.push({
			settledAs: "domain",
			changed: () => {
				const d = dom();
				return d != null && op.knownDomainVersion !== d.version;
			},
			emit: () => {
				const d = dom();
				return d ? { domainVersion: d.version, domain: d.snapshot } : {};
			},
		});
	}

	return participants;
}
