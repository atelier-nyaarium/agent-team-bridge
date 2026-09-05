import { type Ambient, withinMs } from "../../shared/ambient.js";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { type HostOp, type HostOpResult, isSpawnWorkdirPath } from "../../shared/host-op.js";
import { composeSessionName } from "../../shared/session-id.js";
import { sanitizeLabel } from "../../shared/session-sanitize.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";
import type { WakeResult } from "../wake.js";
import type { ConsoleTargets } from "./consoleTargets.js";
import { CreateSessionAmbiguousError } from "./consoleTypes.js";

export interface SessionLifecycleDeps {
	targets: ConsoleTargets;
	createSessionBoundMs: number;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	tryWakeTeam?: (team: string) => Promise<WakeResult>;
	isWakeInFlight?: (team: string) => boolean;
	markCreateInFlight?: (team: string) => () => void;
	awaitRegister?: (team: string) => Promise<WakeResult>;
	dropSessionResume?: (team: string, boardDisposition: BoardDisposition) => void;
	/** Close and forget end session grants. */
	onSessionEnded?: (team: string) => void;
	sessionStore?: Pick<
		SessionStore,
		| "getByTeam"
		| "teamOf"
		| "adoptById"
		| "adoptOrReattach"
		| "mintOrReattach"
		| "hostWorkdirHint"
		| "forget"
		| "rename"
		| "ensureBindToken"
	>;
}

export function createSessionLifecycleHandlers({
	targets,
	createSessionBoundMs,
	ambient,
	relayToHost,
	tryWakeTeam,
	isWakeInFlight,
	markCreateInFlight,
	awaitRegister,
	dropSessionResume,
	onSessionEnded,
	sessionStore,
}: SessionLifecycleDeps) {
	async function createSession(
		op: Extract<ConsoleOp, { kind: "create_session" }>,
		conversationId: string,
		opId: string,
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		if (!op.sessionName && !op.displayLabel) {
			throw new Error("create_session needs a sessionName or a displayLabel");
		}
		const spawn = targets.localSpawn(op.target);
		if (op.workdir != null && !isSpawnWorkdirPath(spawn, op.workdir)) {
			throw new Error("invalid workdir: must be an absolute, ~-rooted, or Windows drive path");
		}
		const labelSanitized = op.displayLabel != null && sanitizeLabel(op.displayLabel) === null;
		const dedupKey = `${conversationId}:${opId}`;
		let sessionId: string;
		let label: string;
		let adopted: { record: SessionRecord; created: boolean } | null | undefined;
		if (op.sessionName) {
			sessionId = op.sessionName;
			label = op.displayLabel ?? sessionId;
			adopted = sessionStore?.adoptOrReattach(sessionId, {
				spawn,
				sessionLabel: label,
				workdirHint: label,
				workdirPath: op.workdir,
				mintedFrom: dedupKey,
			});
		} else {
			label = op.displayLabel as string;
			const minted = sessionStore?.mintOrReattach({
				spawn,
				sessionLabel: label,
				workdirHint: label,
				workdirPath: op.workdir,
				mintedFrom: dedupKey,
			});
			sessionId = minted?.record.id ?? label;
			adopted = minted ?? null;
		}
		if (sessionStore && !adopted) {
			throw new Error(`cannot create session "${sessionId}": the name is reserved or a project`);
		}
		// The console is the authority: the record outlives a launch that fails, listed asleep until a forget.
		const target = targets.tmuxTarget(op.target, sessionId);
		const workdirHint =
			sessionStore && adopted ? sessionStore.hostWorkdirHint(adopted.record) : (op.workdir ?? label);

		const launchTeam = composeSessionName(target.name, target.sessionName);
		const viaWake = target.kind === "devcontainer" && tryWakeTeam;
		const releaseInFlight = markCreateInFlight?.(launchTeam);
		const launch: Promise<HostOpResult> = (
			viaWake
				? tryWakeTeam(launchTeam).then(
						(r): HostOpResult =>
							r.ok
								? { ok: true }
								: {
										ok: false,
										error: `failed to wake "${sessionId}"`,
										errorKind: r.errorKind,
									},
					)
				: relayToHost({
						kind: "createSession",
						target,
						workdirHint,
						resumeSessionId: adopted?.record.claudeSessionId,
						sessionToken: adopted ? sessionStore?.ensureBindToken(adopted.record) : undefined,
						dedupKey,
					})
		).finally(() => {
			if (viaWake || !awaitRegister) {
				releaseInFlight?.();
			} else {
				void awaitRegister(launchTeam).finally(() => releaseInFlight?.());
			}
		});

		const winner = await withinMs(ambient, launch, createSessionBoundMs);

		if (winner === null) {
			launch.catch(() => undefined);
			return {
				created: true,
				id: adopted?.record.id ?? sessionId,
				sessionLabel: adopted?.record.sessionLabel,
				labelSanitized,
				status: "pending" as const,
			};
		}

		if (!winner.ok) {
			if (winner.errorKind === "timeout" || winner.errorKind === "disconnected") {
				throw new CreateSessionAmbiguousError(winner.error ?? "create session had no definitive answer");
			}
			throw new Error(winner.error ?? "create session failed");
		}
		return {
			created: true,
			id: adopted?.record.id ?? sessionId,
			sessionLabel: adopted?.record.sessionLabel,
			labelSanitized,
		};
	}

	async function wake(op: Extract<ConsoleOp, { kind: "wake" }>) {
		if (!tryWakeTeam) throw new Error("wake is unavailable");
		const { name, spawn, session } = targets.requireLocalComposite(op.target, "wake");
		const adopted =
			sessionStore && !sessionStore.getByTeam(name)
				? sessionStore.adoptById(session, { spawn, sessionLabel: session, workdirHint: session })
				: null;
		const mayForget = () => {
			if (!adopted || !sessionStore) return false;
			const current = sessionStore.getByTeam(name);
			return current === adopted && current.confirmedAt === undefined;
		};
		const wakeCall = tryWakeTeam(name);
		const winner = await withinMs(ambient, wakeCall, createSessionBoundMs);
		if (winner === null) {
			void wakeCall
				.then((r) => {
					if (!r.ok && mayForget()) sessionStore?.forget(name);
				})
				.catch(() => {
					if (mayForget()) sessionStore?.forget(name);
				});
			return { ok: true, status: "pending" as const };
		}
		if (!winner.ok) {
			if (mayForget()) sessionStore?.forget(name);
			const reason =
				winner.error ??
				(winner.errorKind === "disconnected"
					? "the host is not connected"
					: winner.errorKind === "timeout"
						? "it did not come online in time"
						: "unknown error");
			throw new Error(`failed to wake "${name}": ${reason}`);
		}
		return winner;
	}

	async function closeSession(
		op: Extract<ConsoleOp, { kind: "close_session" }>,
		conversationId: string,
		opId: string,
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const { name } = targets.requireLocalComposite(op.target, "close");
		const target = targets.tmuxTarget(op.target);
		const record = sessionStore?.getByTeam(name);
		if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
			throw new Error(`"${name}" is user-launched; end it from your terminal`);
		}
		if (isWakeInFlight?.(name)) {
			throw new Error(`"${name}" is waking; wait for it to finish before closing`);
		}
		const dedupKey = `${conversationId}:${opId}`;
		const r = await relayToHost({ kind: "killSession", target, dedupKey });
		if (!r.ok) throw new Error(r.error ?? "close failed");
		onSessionEnded?.(name);
		return { closed: true };
	}

	async function forget(op: Extract<ConsoleOp, { kind: "forget" }>, conversationId: string, opId: string) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const { name } = targets.requireLocalComposite(op.target, "forget");
		if (isWakeInFlight?.(name)) throw new Error(`"${name}" is waking; wait for it to finish before forgetting`);
		const dedupKey = `${conversationId}:${opId}`;
		try {
			const target = targets.tmuxTarget(op.target);
			const r = await relayToHost({ kind: "killSession", target, dedupKey });
			if (!r.ok) console.log(`[console] forget "${name}": kill failed - ${r.error ?? "unknown error"}`);
		} catch (e) {
			console.log(`[console] forget "${name}": kill failed - ${(e as Error).message}`);
		}
		const disposition: BoardDisposition = op.boardDisposition ?? "release";
		dropSessionResume?.(name, disposition);
		onSessionEnded?.(name);
		return { killed: true, boardDisposition: disposition };
	}

	function renameSession(op: Extract<ConsoleOp, { kind: "rename_session" }>) {
		const { name } = targets.requireLocalComposite(op.target, "rename");
		const applied = sessionStore?.rename(name, op.sessionLabel) ?? null;
		return { renamed: applied !== null, sessionLabel: applied ?? undefined };
	}

	return { createSession, wake, closeSession, forget, renameSession };
}
