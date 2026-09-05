import type { ConsoleOp } from "../../shared/console-protocol.js";
import {
	ALLOWED_KEYS,
	type HostListDirsResult,
	type HostOp,
	type HostOpResult,
	type HostPeekResult,
	isSpawnWorkdirPath,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { composeSessionName } from "../../shared/session-id.js";
import type { SessionStore } from "../../shared/session-store.js";
import type { ConsoleTargets } from "./consoleTargets.js";
import { friendlyPeekError } from "./consoleTypes.js";

export interface TerminalOpsDeps {
	targets: ConsoleTargets;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	sessionStore?: Pick<SessionStore, "getByTeam" | "teamOf">;
}

export function createTerminalHandlers({ targets, relayToHost, sessionStore }: TerminalOpsDeps) {
	function assertDaemonDrivable(target: TmuxTarget): void {
		const record = sessionStore?.getByTeam(composeSessionName(target.name, target.sessionName));
		if (record?.liveTeam && record.liveTeam.team !== sessionStore!.teamOf(record)) {
			throw new Error(`terminal view unavailable for a user-launched session; end it from your terminal`);
		}
	}

	async function peek(op: Extract<ConsoleOp, { kind: "peek" }>) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const target = targets.tmuxTarget(op.target);
		assertDaemonDrivable(target);
		const r = await relayToHost({ kind: "peek", target });
		if (!r.ok) throw new Error(friendlyPeekError(r.error, r.errorKind));
		const peekResult = r.result as HostPeekResult;
		if (op.sinceHash && op.sinceHash === peekResult.hash) return { hash: peekResult.hash, unchanged: true };
		if (peekResult.kind === "container-logs")
			return { text: peekResult.text, hash: peekResult.hash, kind: "container-logs" as const };
		return { ansi: peekResult.ansi, hash: peekResult.hash, kind: "tmux" as const };
	}

	async function tmuxSend(op: Extract<ConsoleOp, { kind: "tmux_send" }>, conversationId: string, opId: string) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		if ((op.text == null) === (op.key == null)) {
			throw new Error("tmux_send requires exactly one of text or key");
		}
		const target = targets.tmuxTarget(op.target);
		assertDaemonDrivable(target);
		const dedupKey = `${conversationId}:${opId}`;
		let hostOp: HostOp;
		if (op.key != null) {
			if (!ALLOWED_KEYS.has(op.key)) throw new Error(`disallowed key "${op.key}"`);
			hostOp = { kind: "sendKey", target, key: op.key, dedupKey };
		} else {
			hostOp = { kind: "sendText", target, text: op.text ?? "", submit: op.submit ?? true, dedupKey };
		}
		const r = await relayToHost(hostOp);
		if (!r.ok) throw new Error(r.error ?? "send failed");
		return { sent: true };
	}

	async function listDirs(op: Extract<ConsoleOp, { kind: "list_dirs" }>) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		// An empty path asks the spawn point for its default directory.
		if (op.path.length > 0 && !isSpawnWorkdirPath(op.spawn, op.path)) {
			throw new Error("invalid path: must be absolute, ~-rooted, or a Windows drive path");
		}
		const r = await relayToHost({ kind: "listDirs", path: op.path, spawn: op.spawn });
		if (!r.ok) throw new Error(r.error ?? "list failed");
		const listed = r.result as HostListDirsResult;
		return {
			entries: listed.entries,
			...(listed.truncated ? { truncated: true } : {}),
			...(listed.path ? { path: listed.path } : {}),
		};
	}

	async function reloadPlugins(
		op: Extract<ConsoleOp, { kind: "reload_plugins" }>,
		conversationId: string,
		opId: string,
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const target = targets.tmuxTarget(op.target);
		assertDaemonDrivable(target);
		const dedupKey = `${conversationId}:${opId}`;
		const r = await relayToHost({ kind: "reloadPlugins", target, dedupKey });
		if (!r.ok) throw new Error(r.error ?? "reload failed");
		return { initiated: true };
	}

	return { peek, tmuxSend, listDirs, reloadPlugins };
}
