import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { createVerifyChecks, summarize } from "../../scripts/lib/verifyChecks.js";
import { createRoutes } from "../gateway/routes.js";
import { FEDERATION_PROTOCOL_VERSION } from "../shared/router-protocol.js";
import { makeCtx } from "./helpers/routes.js";

const team = { team: "alpha", gatewayId: "gateway", status: "available", kind: "loose", queue_depth: 0 };
const capabilities = { known: true, capabilities: [], clientVersions: [] };
const currentCoverage = { rosterKnown: true, asked: 0, answered: 0 };
const currentGateway = {
	ok: true,
	version: packageJson.version,
	gatewayId: "gateway",
	incarnation: 4,
	protocolVersion: FEDERATION_PROTOCOL_VERSION,
	opLedgerProtocol: 1,
};

function checks(
	gateway: Record<string, unknown>,
	coverage: Record<string, unknown> | null = {},
	dial: (url: string, expectedFingerprint: string) => Promise<void> = async () => {},
	env: Record<string, string | undefined> = { FEDERATION_ROUTER_CERT_FP: "fp" },
) {
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/capabilities")) return Response.json({ console: capabilities, daemon: capabilities });
		if (url.endsWith("/discover?coverage=1"))
			return Response.json({ teams: [team], coverage, localGatewayId: "gateway", localDomainId: "domain" });
		return Response.json([team]);
	});
	return createVerifyChecks({
		fetch: fetch as (input: RequestInfo | URL) => Promise<Response>,
		dial,
		env,
		router: { certFingerprint: "fp", version: packageJson.version, protocolVersion: FEDERATION_PROTOCOL_VERSION },
		gateway,
		registered: [{ gatewayId: "gateway", incarnation: 4, protocolVersion: FEDERATION_PROTOCOL_VERSION }],
		localGatewayId: "gateway",
		routerUrl: "wss://router:20001",
		gatewayUrl: "http://gateway:20000",
	});
}

afterEach(() => vi.restoreAllMocks());

describe("setup verify checks", () => {
	it("passes the current gateway shapes", async () => {
		const answers = await Promise.all(checks(currentGateway, currentCoverage).map((check) => check.run()));
		expect(answers.every((answer) => answer.ok)).toBe(true);
	});

	it("fails route-gateway shapes", async () => {
		const answers = await Promise.all(checks({ ok: true }, null).map((check) => check.run()));
		const failed = answers.map((answer, index) => (!answer.ok ? index : -1)).filter((index) => index >= 0);
		expect(failed).toEqual([0, 2, 3, 4, 5]);
		expect(summarize(answers)).toEqual({ failed: 5, summary: "VERIFY FAILED (5 checks)" });
	});

	it("requires the expected op-ledger protocol", async () => {
		const answers = await Promise.all(
			checks({ ...currentGateway, opLedgerProtocol: 2 }, currentCoverage).map((check) => check.run()),
		);
		expect(answers[5]).toEqual({ ok: false, detail: "expected 1, got 2" });
	});

	it("uses the persisted pin for console WS", async () => {
		const dial = vi.fn(async () => {});
		const answers = await Promise.all(checks(currentGateway, currentCoverage, dial).map((check) => check.run()));
		expect(dial).toHaveBeenCalledWith("wss://router:20001/console", "fp");
		expect(answers[6]?.ok).toBe(true);
	});

	it("fails console WS when the persisted pin is missing", async () => {
		const context = checks(currentGateway, currentCoverage, async () => {}, {});
		const consoleCheck = context.find((check) => check.name === "console-ws");
		const answers = await consoleCheck?.run();
		expect(answers).toEqual({ ok: false, detail: "FEDERATION_ROUTER_CERT_FP is missing" });
	});

	it("keeps a Gateway-only setup verify branch", async () => {
		const source = await readFile(new URL("../../scripts/setup-verify.ts", import.meta.url), "utf8");
		expect(source).toContain("if (localRouter)");
		expect(source).toContain("FEDERATION_ROUTER_HOST");
		expect(source).toContain("pinnedRouterHealth");
		expect(source).toContain("if (!gatewayReport.router_connected)");
	});

	it("validates the in-process retained route handlers", async () => {
		const routes = createRoutes(makeCtx());
		const fetch = async (input: RequestInfo | URL): Promise<Response> => {
			const url = new URL(String(input));
			if (url.pathname === "/capabilities") return routes.capabilities();
			return routes.discover(url);
		};
		const answers = await Promise.all(
			createVerifyChecks({
				fetch,
				dial: async () => {},
				env: { FEDERATION_ROUTER_CERT_FP: "fp" },
				router: {
					certFingerprint: "fp",
					version: packageJson.version,
					protocolVersion: FEDERATION_PROTOCOL_VERSION,
				},
				gateway: currentGateway,
				registered: [{ gatewayId: "gateway", incarnation: 4, protocolVersion: FEDERATION_PROTOCOL_VERSION }],
				localGatewayId: "gateway",
				routerUrl: "wss://router:20001",
				gatewayUrl: "http://gateway:20000",
			}).map((check) => check.run()),
		);
		expect(answers[3]?.ok).toBe(true);
	});
});
