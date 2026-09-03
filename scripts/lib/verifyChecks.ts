import { z } from "zod";
import packageJson from "../../package.json";
import { FEDERATION_PROTOCOL_VERSION } from "../../src/shared/router-protocol.js";
import { CapabilityBundleSchema } from "../../src/shared/schemasCapability.js";
import { DiscoverCoverageSchema } from "../../src/shared/schemasConsoleResults.js";
import { TeamInfoSchema } from "../../src/shared/schemasPresence.js";
import { OP_LEDGER_PROTOCOL } from "../../src/shared/schemasRegister.js";

// The setup verify checks, run in order and printed PASS or FAIL.
export interface VerifyRouterReport {
	certFingerprint: string;
	version?: string;
	protocolVersion?: number;
}

export interface VerifyGatewayReport {
	ok?: boolean;
	version?: string;
	gatewayId?: string;
	incarnation?: number | null;
	protocolVersion?: number;
	opLedgerProtocol?: number;
}

export interface VerifyRegisteredGateway {
	gatewayId: string;
	incarnation?: number;
	protocolVersion?: number;
}

export interface VerifyCheckContext {
	fetch: (input: RequestInfo | URL) => Promise<Response>;
	dial: (url: string, expectedFingerprint: string) => Promise<void>;
	env: Record<string, string | undefined>;
	router: VerifyRouterReport;
	gateway: VerifyGatewayReport;
	registered: VerifyRegisteredGateway[];
	localGatewayId: string;
	routerUrl: string;
	gatewayUrl: string;
}

export interface VerifyCheck {
	name: string;
	run: () => Promise<{ ok: boolean; detail: string }>;
}

export interface VerifyCheckResult {
	ok: boolean;
	detail: string;
}

export function summarize(results: VerifyCheckResult[]): { failed: number; summary: string | null } {
	const failed = results.filter((result) => !result.ok).length;
	return { failed, summary: failed ? `VERIFY FAILED (${failed} checks)` : null };
}

const DiscoverCoverageAnswerSchema = z.object({
	teams: z.array(TeamInfoSchema),
	coverage: DiscoverCoverageSchema,
	localGatewayId: z.string(),
	localDomainId: z.string(),
});

async function json(fetch_: (input: RequestInfo | URL) => Promise<Response>, url: string): Promise<unknown> {
	const response = await fetch_(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

function result(run: () => void): () => Promise<{ ok: boolean; detail: string }> {
	return async () => {
		try {
			run();
			return { ok: true, detail: "" };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : "check failed" };
		}
	};
}

export function createVerifyChecks(context: VerifyCheckContext): VerifyCheck[] {
	const { gateway, registered, router } = context;
	return [
		{
			name: "router-gateway-version",
			run: result(() => {
				if (!router.version || router.version !== gateway.version)
					throw new Error(`Router ${router.version ?? "missing"}, Gateway ${gateway.version ?? "missing"}`);
				if (router.version !== packageJson.version)
					throw new Error(`expected ${packageJson.version}, got ${router.version}`);
			}),
		},
		{
			name: "router-pin",
			run: result(() => {
				const persisted = context.env.FEDERATION_ROUTER_CERT_FP;
				if (!persisted) throw new Error("FEDERATION_ROUTER_CERT_FP is missing");
				if (router.certFingerprint !== persisted.toLowerCase())
					throw new Error("Router /health fingerprint differs from .env");
			}),
		},
		{
			name: "protocol",
			run: result(() => {
				if (router.protocolVersion !== FEDERATION_PROTOCOL_VERSION)
					throw new Error(
						`expected ${FEDERATION_PROTOCOL_VERSION}, got ${router.protocolVersion ?? "missing"}`,
					);
				const own = registered.find((entry) => entry.gatewayId === context.localGatewayId);
				if (
					own?.protocolVersion !== FEDERATION_PROTOCOL_VERSION ||
					gateway.protocolVersion !== FEDERATION_PROTOCOL_VERSION
				)
					throw new Error("Router-held registration protocol does not match the Gateway");
			}),
		},
		{
			name: "gateway-registration-incarnation",
			run: result(() => {
				const own = registered.find((entry) => entry.gatewayId === context.localGatewayId);
				if (!own || own.incarnation === undefined)
					throw new Error("this Gateway is not registered with an incarnation");
				if (gateway.gatewayId !== context.localGatewayId || gateway.incarnation !== own.incarnation)
					throw new Error("Gateway health identity does not match the Router registration");
			}),
		},
		{
			name: "retained-http-shapes",
			run: async () => {
				try {
					CapabilityBundleSchema.parse(await json(context.fetch, `${context.gatewayUrl}/capabilities`));
					const plain = await json(context.fetch, `${context.gatewayUrl}/discover`);
					z.array(TeamInfoSchema).parse(plain);
					DiscoverCoverageAnswerSchema.parse(
						await json(context.fetch, `${context.gatewayUrl}/discover?coverage=1`),
					);
					return { ok: true, detail: "" };
				} catch (error) {
					return { ok: false, detail: error instanceof Error ? error.message : "schema validation failed" };
				}
			},
		},
		{
			name: "op-ledger",
			run: result(() => {
				if (gateway.opLedgerProtocol !== OP_LEDGER_PROTOCOL)
					throw new Error(`expected ${OP_LEDGER_PROTOCOL}, got ${gateway.opLedgerProtocol ?? "missing"}`);
			}),
		},
		{
			name: "console-ws",
			run: async () => {
				try {
					if (!context.routerUrl.startsWith("wss://")) throw new Error("refusing non-TLS Router URL");
					const persisted = context.env.FEDERATION_ROUTER_CERT_FP?.trim().toLowerCase();
					if (!persisted) throw new Error("FEDERATION_ROUTER_CERT_FP is missing");
					await context.dial(`${context.routerUrl}/console`, persisted);
					return { ok: true, detail: "" };
				} catch (error) {
					return { ok: false, detail: error instanceof Error ? error.message : "console WS failed" };
				}
			},
		},
	];
}
