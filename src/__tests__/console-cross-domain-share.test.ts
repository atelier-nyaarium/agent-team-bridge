import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCrossDomainHandlers } from "../gateway/console/consoleCrossDomain.js";
import { createConsoleTargets } from "../gateway/console/consoleTargets.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { processAmbient } from "../shared/ambient.js";
import { MIGRATING, setMigrationEpoch } from "../shared/migration-fence.js";

const TARGET = { kind: "domain" as const, domainId: "friend" };
const dirs: string[] = [];

afterEach(() => {
	setMigrationEpoch(null);
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-share-"));
	dirs.push(dir);
	const mirror = new CrossDomainShareState(dir, undefined, processAmbient());
	const posted: string[] = [];
	const router = { refuse: false };
	const handlers = createCrossDomainHandlers({
		routes: { teams: () => Response.json([{ team: "app.dev", kind: "devcontainer" }]) },
		targets: createConsoleTargets({ localDomainId: "home", localGatewayId: "gw" }),
		crossDomainShare: {
			postRecord: async (action) => {
				posted.push(action);
				if (router.refuse) throw new Error("refused");
			},
			share: (sessionTarget, target) => mirror.share(sessionTarget, target),
			unshare: (sessionTarget, target) => mirror.unshare(sessionTarget, target),
			listShares: () => mirror.all(),
			expireSessionJobsForTarget: () => {},
			isLinkedDomain: () => true,
		},
	});
	const share = () => handlers.share({ kind: "cross_domain_share", sessionTarget: "app.dev", target: TARGET });
	return { mirror, posted, router, share };
}

describe("console share", () => {
	it("removes a new mirror when the Router refuses its record", async () => {
		const f = setup();
		f.router.refuse = true;
		await expect(f.share()).rejects.toThrow("refused");
		expect(f.mirror.all()).toEqual([]);
		expect(f.posted).toEqual(["cross_domain_share"]);
	});

	it("keeps a held mirror when a repeated share's record is refused", async () => {
		const f = setup();
		await expect(f.share()).resolves.toEqual({ ok: true });
		f.router.refuse = true;
		await expect(f.share()).rejects.toThrow("refused");
		expect(f.mirror.all()).toMatchObject([{ sessionTarget: "home.gw.app.dev", target: TARGET }]);
	});

	it("refuses under the migration fence before any Router traffic", async () => {
		const f = setup();
		setMigrationEpoch(7);
		await expect(f.share()).rejects.toThrow(MIGRATING);
		expect(f.posted).toEqual([]);
		expect(f.mirror.all()).toEqual([]);
	});
});
