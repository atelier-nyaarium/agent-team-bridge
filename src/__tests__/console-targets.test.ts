import { describe, expect, it } from "vitest";
import { BOARD_REFUSED_PREFIX } from "../gateway/boardStore.js";
import { createConsoleTargets } from "../gateway/console/consoleTargets.js";
import { DEFAULT_SESSION } from "../shared/session-id.js";

////////////////////////////////
//  Tests
//
//  The trap shape throughout: a FOREIGN domain with a COLLIDING gateway id. Folded to its bare
//  field it names the same-named local session, so every local-gated method must refuse it.

const targets = createConsoleTargets({
	localDomainId: "home",
	localGatewayId: "gw",
	isTrustedCatalogProject: (name) => name === "recipe-app",
});
const FOREIGN = "other.gw.app.dev";

describe("createConsoleTargets", () => {
	it("refuses the colliding-gateway foreign shape at every local-gated method", () => {
		expect(() => targets.boardSessionKey(FOREIGN)).toThrow(`${BOARD_REFUSED_PREFIX}session_missing`);
		expect(() => targets.requireLocalComposite(FOREIGN, "forget")).toThrow("another Gateway");
		expect(() => targets.localSpawn(FOREIGN)).toThrow("another Gateway");
		expect(() => targets.tmuxTarget(FOREIGN)).toThrow("another Gateway");
		expect(() => targets.shareTarget(FOREIGN, () => new Error("only local"))).toThrow("only local");
	});

	it("parse alone passes a foreign address through, for the ops that route cross-Gateway", () => {
		const t = targets.parse(FOREIGN);
		expect(t.domain).toBe("other");
		expect(t.gateway).toBe("gw");
	});

	it("resolves local names in every accepted spelling to one bare key", () => {
		expect(targets.boardSessionKey("app.dev")).toBe("app.dev");
		expect(targets.boardSessionKey("home.gw.app.dev")).toBe("app.dev");
		// A spawn-point folds to its default session.
		expect(targets.boardSessionKey("app")).toBe(`app.${DEFAULT_SESSION}`);
	});

	it("checks foreign before spawn-point, so a foreign spawn-point hears the refusal no session name could fix", () => {
		expect(() => targets.requireLocalComposite("other.gw.app", "close")).toThrow("another Gateway");
		expect(() => targets.requireLocalComposite("app", "close")).toThrow("spawn-point");
	});

	it("maps a null Domain (arming mode) to the sentinel so local keys still form", () => {
		const arming = createConsoleTargets({ localDomainId: null, localGatewayId: "gw" });
		expect(arming.boardSessionKey("app.dev")).toBe("app.dev");
		expect(arming.localAddress("app.dev").canonical).toContain("app.dev");
	});

	it("resolves tmux targets by kind and refuses what has no pane", () => {
		expect(targets.tmuxTarget("host.abc")).toEqual({ kind: "host", name: "host", sessionName: "abc" });
		expect(targets.tmuxTarget("recipe-app.dev")).toEqual({
			kind: "devcontainer",
			name: "recipe-app",
			sessionName: "dev",
		});
		expect(() => targets.tmuxTarget("stranger.dev")).toThrow("only the host and devcontainers");
	});

	it("does not classify a name known only through discovery", () => {
		const knownTeamPaths = new Map([["untrusted", "/tmp/untrusted"]]);
		const offlineCatalog = new Map<string, string>();
		const trustedTargets = createConsoleTargets({
			localDomainId: "home",
			localGatewayId: "gw",
			isTrustedCatalogProject: (name) => offlineCatalog.has(name),
		});

		expect(knownTeamPaths.has("untrusted")).toBe(true);
		expect(() => trustedTargets.tmuxTarget("untrusted.dev")).toThrow("only the host and devcontainers");
	});
});
