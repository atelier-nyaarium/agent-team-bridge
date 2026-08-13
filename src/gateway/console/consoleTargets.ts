import { isReservedHostSession, isShellSafeName, isTmuxName, type TmuxTarget } from "../../shared/host-op.js";
import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	LOCAL_DOMAIN_SENTINEL,
	parseSessionName,
	parseTarget,
	SpawnPoint,
} from "../../shared/session-id.js";
import { refusalError } from "../boardStore.js";

////////////////////////////////
//  Interfaces & Types

export interface ConsoleTargetsDeps {
	localDomainId: string | null;
	localGatewayId: string;
	isProjectName?: (name: string) => boolean;
}

/** A composite local target: the ops that act on ONE session record resolve to this. */
export interface LocalComposite {
	name: string;
	spawn: string;
	session: string;
}

export interface ShareTarget {
	name: string;
	canonical: string;
}

export type ConsoleTargets = ReturnType<typeof createConsoleTargets>;

////////////////////////////////
//  Functions & Helpers

/**
 * Every console-named target resolves through this one object, and the foreign-Gateway refusal
 * lives here alone: a session on another Gateway is refused, never folded onto a same-named local
 * one. The residue test pins parseTarget to this module within console/.
 */
export function createConsoleTargets({ localDomainId, localGatewayId, isProjectName }: ConsoleTargetsDeps) {
	// The local Domain segment for every canonical address minted here. Null (arming mode) maps to
	// the sentinel, so a key still forms.
	const localDomain = localDomainId || LOCAL_DOMAIN_SENTINEL;

	/** Parse WITHOUT the local gate, for the ops that legitimately route cross-Gateway (send). */
	function parse(named: string): Address | SpawnPoint {
		return parseTarget(named, localDomain, localGatewayId);
	}

	function requireLocal(named: string, foreignError: () => Error): Address | SpawnPoint {
		const t = parse(named);
		if (t.domain !== localDomain || t.gateway !== localGatewayId) throw foreignError();
		return t;
	}

	/** The canonical Address of a LOCAL session by its team field - the form the share state and the
	 * pending-job store key by (identical to routes' localAddress and the relay gate's, so a console
	 * share key matches the gate byte-for-byte). */
	function localAddress(name: string): Address {
		const { project, session } = parseSessionName(name);
		return Address.local(localDomain, localGatewayId, project, session);
	}

	/** The bare `spawn.session` key a board entry stores, from whatever the console named the session
	 * as. The board's every other reader - the MCP route, sessionEnded, the TTL sweep - keys by the
	 * local field, so an un-normalized value is stored but never matched again. */
	function boardSessionKey(named: string): string {
		const t = requireLocal(named, () => refusalError("session_missing"));
		return t instanceof SpawnPoint
			? composeSessionName(t.spawn, DEFAULT_SESSION)
			: composeSessionName(t.spawn, t.session);
	}

	/** One named session for the record ops (forget, close, rename). A foreign address is checked
	 * FIRST: telling a caller to name a session on a target no session name could ever fix would lie. */
	function requireLocalComposite(named: string, verb: string): LocalComposite {
		const t = requireLocal(
			named,
			() => new Error(`cannot ${verb} "${named}": that session lives on another Gateway`),
		);
		if (t instanceof SpawnPoint) {
			throw new Error(`cannot ${verb} "${named}": name a specific project.session, not a spawn-point`);
		}
		return { name: composeSessionName(t.spawn, t.session), spawn: t.spawn, session: t.session };
	}

	/** The local spawn segment for create_session, refused ahead of any record mint. */
	function localSpawn(named: string): string {
		return requireLocal(named, () => new Error(`terminal view is not available for a session on another Gateway`))
			.spawn;
	}

	/** The canonical `domain.gateway.spawn.session` key a session is shared under, the single form
	 * every read path (the relay gate, the sweep, discovery) compares against. */
	function shareTarget(named: string, foreignError: () => Error): ShareTarget {
		const t = requireLocal(named, foreignError);
		const name = t instanceof SpawnPoint ? t.spawn : composeSessionName(t.spawn, t.session);
		return { name, canonical: localAddress(name).canonical };
	}

	/** Resolve a console terminal target to the host tmux it maps to. The target is a local team
	 * field (`spawn` -> default session, or `spawn.session`) or its fully-qualified Address;
	 * `explicitSession` (create_session) overrides the derived session. */
	function tmuxTarget(qualifiedTarget: string, explicitSession?: string): TmuxTarget {
		const t = requireLocal(
			qualifiedTarget,
			() => new Error(`terminal view is not available for a session on another Gateway`),
		);
		const project = t.spawn;
		const sessionName = explicitSession ?? (t instanceof SpawnPoint ? DEFAULT_SESSION : t.session);
		let target: TmuxTarget;
		if (project === "host") {
			if (isReservedHostSession(sessionName)) throw new Error(`"${sessionName}" is a reserved host session`);
			target = { kind: "host", name: "host", sessionName };
		} else if (isProjectName?.(project)) target = { kind: "devcontainer", name: project, sessionName };
		else throw new Error(`terminal view is not available for "${project}" (only the host and devcontainers)`);
		// Both name and session reach the host's shell launch command; the grammar makes both strict
		// dotless slugs, so assert it at the boundary regardless (defense in depth).
		if (!isShellSafeName(target.name)) throw new Error(`invalid project name "${target.name}"`);
		if (!isTmuxName(target.sessionName)) throw new Error(`invalid session name "${target.sessionName}"`);
		return target;
	}

	return {
		localDomain,
		parse,
		localAddress,
		boardSessionKey,
		requireLocalComposite,
		localSpawn,
		shareTarget,
		tmuxTarget,
	};
}
