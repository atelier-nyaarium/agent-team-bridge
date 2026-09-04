import { timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BEARER_PREFIX, CONSOLE_TOKEN_HEADER, ROUTER_PATHS } from "../shared/wire-vocabulary.js";

function constantTimeBearerEquals(provided: string | null, expected: string): boolean {
	if (!provided) return false;
	const left = Buffer.from(provided);
	const right = Buffer.from(BEARER_PREFIX + expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

import {
	type ConsoleApprovalOp,
	ConsoleApprovalOpSchema,
	type ConsoleApprovalResult,
	type EnrollHandshakeOp,
	EnrollHandshakeOpSchema,
	type EnrollHandshakeResult,
	type EnrollOp,
	EnrollOpSchema,
	type EnrollResult,
	type RosterRequest,
	RosterRequestSchema,
	type RosterResult,
	type SignedFirstRoot,
	SignedFirstRootSchema,
	type TransportRequest,
	TransportRequestSchema,
	type TransportResult,
	type TrustHandshakeOp,
	TrustHandshakeOpSchema,
	type TrustHandshakeResult,
	type TrustPendingRequest,
	TrustPendingRequestSchema,
	type TrustPendingResult,
} from "../shared/federation-lifecycle.js";

const MAX_INGEST_LINES = 2000;
const MAX_INGEST_BYTES = 512 * 1024;

export interface ConsoleSurfaceParams {
	port: number;
	authToken: string;
	ingestFile?: string;
	onEnrollOp?: (op: EnrollOp) => EnrollResult | Promise<EnrollResult>;
	onFirstRoot?: (signed: SignedFirstRoot) => EnrollResult | Promise<EnrollResult>;
	onEnrollHandshake?: (op: EnrollHandshakeOp) => EnrollHandshakeResult | Promise<EnrollHandshakeResult>;
	onConsoleApproval?: (op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>;
	onRoster?: (req: RosterRequest) => RosterResult | Promise<RosterResult>;
	onTrustHandshake?: (op: TrustHandshakeOp) => TrustHandshakeResult | Promise<TrustHandshakeResult>;
	onTrustPending?: (req: TrustPendingRequest) => TrustPendingResult | Promise<TrustPendingResult>;
	onTransport?: (req: TransportRequest) => TransportResult | Promise<TransportResult>;
	/** Reach requires the app token. */
	onReach?: (signerSignPub?: string) => RouterReachAnswer;
	/** Gateway listings use the admin Domain. */
	onGateways?: () => RouterGatewaysAnswer;
	onOwnerOp?: (raw: unknown) => unknown | Promise<unknown>;
}

/** Empty reach fields preserve cached addresses. */
export interface RouterReachAnswer {
	publicHost: string | null;
	publicPort?: number;
	lanAddresses: string[];
	/** The Domain admitting the asking console; a console needs it before it can sign. */
	domainId?: string;
}

export interface RouterGatewaysAnswer {
	gateways: { gatewayId: string; signFp: string | null }[];
}

export const APP_TOKEN_HEADER = CONSOLE_TOKEN_HEADER;

export class ConsoleSurface {
	private readonly authToken: string;
	private readonly ingestFile: string | null;
	private readonly onEnrollOp: ((op: EnrollOp) => EnrollResult | Promise<EnrollResult>) | null;
	private readonly onFirstRoot: ((signed: SignedFirstRoot) => EnrollResult | Promise<EnrollResult>) | null;
	private readonly onEnrollHandshake:
		| ((op: EnrollHandshakeOp) => EnrollHandshakeResult | Promise<EnrollHandshakeResult>)
		| null;
	private readonly onConsoleApproval:
		| ((op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>)
		| null;
	private readonly onRoster: ((req: RosterRequest) => RosterResult | Promise<RosterResult>) | null;
	private readonly onTrustHandshake:
		| ((op: TrustHandshakeOp) => TrustHandshakeResult | Promise<TrustHandshakeResult>)
		| null;
	private readonly onTrustPending:
		| ((req: TrustPendingRequest) => TrustPendingResult | Promise<TrustPendingResult>)
		| null;
	private readonly onTransport: ((req: TransportRequest) => TransportResult | Promise<TransportResult>) | null;
	private readonly onReach: ((signerSignPub?: string) => RouterReachAnswer) | null;
	private readonly onGateways: (() => RouterGatewaysAnswer) | null;
	private readonly onOwnerOp: ((raw: unknown) => unknown | Promise<unknown>) | null;
	public constructor({
		port,
		authToken,
		ingestFile,
		onEnrollOp,
		onFirstRoot,
		onEnrollHandshake,
		onConsoleApproval,
		onRoster,
		onTrustHandshake,
		onTrustPending,
		onTransport,
		onReach,
		onGateways,
		onOwnerOp,
	}: ConsoleSurfaceParams) {
		this.authToken = authToken;
		this.ingestFile = ingestFile ?? null;
		this.onEnrollOp = onEnrollOp ?? null;
		this.onFirstRoot = onFirstRoot ?? null;
		this.onEnrollHandshake = onEnrollHandshake ?? null;
		this.onConsoleApproval = onConsoleApproval ?? null;
		this.onRoster = onRoster ?? null;
		this.onTrustHandshake = onTrustHandshake ?? null;
		this.onTrustPending = onTrustPending ?? null;
		this.onTransport = onTransport ?? null;
		this.onReach = onReach ?? null;
		this.onGateways = onGateways ?? null;
		this.onOwnerOp = onOwnerOp ?? null;
		this.handleRequest = this.handleRequest.bind(this);
	}

	public start(): void {
		throw new Error("ConsoleSurface requires RouterServer");
	}

	public stop(): void {}

	private async handleEnrollOp(raw: unknown): Promise<Response> {
		if (!this.onEnrollOp) return bounce(501, `enrollment not available`, false);
		const parsed = EnrollOpSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid enroll op: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onEnrollOp(parsed.data);
			return json(result, result.ok ? 200 : 400);
		} catch (err) {
			return bounce(500, `enroll op failed: ${err}`, false);
		}
	}

	private async handleFirstRoot(raw: unknown): Promise<Response> {
		if (!this.onFirstRoot) return bounce(501, `first-root not available`, false);
		const parsed = SignedFirstRootSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid first_root: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onFirstRoot(parsed.data);
			return json(result, result.ok ? 200 : 400);
		} catch (err) {
			return bounce(500, `first_root failed: ${err}`, false);
		}
	}

	private async handleEnrollHandshake(raw: unknown): Promise<Response> {
		if (!this.onEnrollHandshake) return bounce(501, `enroll handshake not available`, false);
		const parsed = EnrollHandshakeOpSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid enroll handshake: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onEnrollHandshake(parsed.data);
			return json(result, result.ok ? 200 : 400);
		} catch (err) {
			return bounce(500, `enroll handshake failed: ${err}`, false);
		}
	}

	private async handleConsoleApproval(raw: unknown): Promise<Response> {
		if (!this.onConsoleApproval) return bounce(501, `device approval not available`, false);
		const parsed = ConsoleApprovalOpSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid device approval: ${parsed.error.issues[0]?.message}`, false);
		if (parsed.data.step === "join" || parsed.data.step === "fetch") {
			return bounce(400, `join/fetch must use the public device-approval ingress`, false);
		}
		try {
			const result = await this.onConsoleApproval(parsed.data);
			return json(result, result.ok ? 200 : 400);
		} catch (err) {
			return bounce(500, `device approval failed: ${err}`, false);
		}
	}

	private async handleRoster(raw: unknown): Promise<Response> {
		if (!this.onRoster) return bounce(501, `roster not available`, false);
		const parsed = RosterRequestSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid roster request: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onRoster(parsed.data);
			return json(result, 200);
		} catch (err) {
			return bounce(500, `roster failed: ${err}`, false);
		}
	}

	private async handleTrustHandshake(raw: unknown): Promise<Response> {
		if (!this.onTrustHandshake) return bounce(501, `trust handshake not available`, false);
		const parsed = TrustHandshakeOpSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid trust handshake: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onTrustHandshake(parsed.data);
			return json(result, result.ok ? 200 : 400);
		} catch (err) {
			return bounce(500, `trust handshake failed: ${err}`, false);
		}
	}

	private async handleTrustPending(raw: unknown): Promise<Response> {
		if (!this.onTrustPending) return bounce(501, `trust pending not available`, false);
		const parsed = TrustPendingRequestSchema.safeParse(raw);
		if (!parsed.success)
			return bounce(400, `invalid trust pending request: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onTrustPending(parsed.data);
			return json(result, 200);
		} catch (err) {
			return bounce(500, `trust pending failed: ${err}`, false);
		}
	}

	private async handleTransport(raw: unknown): Promise<Response> {
		if (!this.onTransport) return bounce(501, `transport not available`, false);
		const parsed = TransportRequestSchema.safeParse(raw);
		if (!parsed.success) return bounce(400, `invalid transport request: ${parsed.error.issues[0]?.message}`, false);
		try {
			const result = await this.onTransport(parsed.data);
			return json(result, 200);
		} catch (err) {
			return bounce(500, `transport failed: ${err}`, false);
		}
	}

	private handleReach(reach: unknown): Response {
		if (!this.onReach) return bounce(501, `reach not available`, false);
		const signer =
			reach && typeof reach === "object" ? (reach as { signerSignPub?: unknown }).signerSignPub : undefined;
		return json(this.onReach(typeof signer === "string" ? signer : undefined), 200);
	}

	private handleGateways(): Response {
		if (!this.onGateways) return bounce(501, `gateways not available`, false);
		return json(this.onGateways(), 200);
	}

	private async handleIngest(req: Request): Promise<Response> {
		const contentLength = Number(req.headers.get("content-length") ?? 0);
		if (contentLength > MAX_INGEST_BYTES) {
			console.log(`[console-ingest] rejected oversized body (content-length: ${contentLength})`);
			return bounce(400, `body exceeds 512KB limit`, false);
		}

		let raw: string;
		try {
			raw = await req.text();
		} catch {
			return bounce(400, `failed to read body`, false);
		}

		if (raw.length > MAX_INGEST_BYTES) {
			console.log(`[console-ingest] rejected oversized body (${raw.length} bytes)`);
			return bounce(400, `body exceeds 512KB limit`, false);
		}

		let parsed: { device?: unknown; conversationId?: unknown; at?: unknown; lines?: unknown } = {};
		let lines: string[];

		try {
			parsed = JSON.parse(raw) as typeof parsed;
			const rawLines = parsed.lines;
			if (Array.isArray(rawLines)) {
				lines = rawLines.map((l) => String(l));
			} else if (typeof rawLines === "string") {
				lines = rawLines.split("\n");
			} else {
				lines = raw.split("\n");
			}
		} catch {
			lines = raw.split("\n");
		}

		const device = typeof parsed.device === "string" ? parsed.device : "?";
		const conversationId = typeof parsed.conversationId === "string" ? parsed.conversationId : "?";

		let truncated = false;
		if (lines.length > MAX_INGEST_LINES) {
			truncated = true;
			lines = lines.slice(0, MAX_INGEST_LINES);
		}

		const prefix = `[console-ingest] conv=${conversationId} dev=${device} |`;
		for (const line of lines) console.log(`${prefix} ${line}`);
		if (this.ingestFile) {
			const batch = lines.map((line) => `${JSON.stringify({ device, conversationId, line })}\n`).join("");
			try {
				mkdirSync(path.dirname(this.ingestFile), { recursive: true });
				appendFileSync(this.ingestFile, batch);
			} catch (err) {
				console.error(`[console-ingest] write failed: ${(err as Error).message}`);
			}
		}

		if (truncated) {
			console.log(`[console-ingest] truncated to ${MAX_INGEST_LINES} lines from conv=${conversationId}`);
		}

		console.log(`[console-ingest] received ${lines.length} lines from ${conversationId}`);

		return json({ ok: true, received: lines.length }, 200);
	}

	/** App-token check for socket upgrades. */
	public authorizeToken(provided: string | string[] | undefined): boolean {
		return constantTimeBearerEquals(typeof provided === "string" ? provided : null, this.authToken);
	}

	public async handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url, "http://console-bridge");
		if (req.method !== "POST") return bounce(405, `method not allowed`);
		// Token gates this surface. Nonce routes are separate.
		if (!constantTimeBearerEquals(req.headers.get(APP_TOKEN_HEADER), this.authToken)) {
			// Never log the token.
			console.log(`[console] rejected ${url.pathname}: app token mismatch`);
			return new Response(`Unauthorized`, { status: 401 });
		}

		if (url.pathname === ROUTER_PATHS.ingest) return this.handleIngest(req);

		let body: Record<string, unknown>;
		try {
			body = (await req.json()) as Record<string, unknown>;
		} catch {
			return bounce(400, `invalid JSON`, false);
		}

		if (body.enrollOp !== undefined) return this.handleEnrollOp(body.enrollOp);

		if (body.firstRoot !== undefined) return this.handleFirstRoot(body.firstRoot);

		if (body.enrollHandshake !== undefined) return this.handleEnrollHandshake(body.enrollHandshake);

		if (body.consoleApproval !== undefined) return this.handleConsoleApproval(body.consoleApproval);

		if (body.roster !== undefined) return this.handleRoster(body.roster);

		if (body.trustHandshake !== undefined) return this.handleTrustHandshake(body.trustHandshake);
		if (body.trustPending !== undefined) return this.handleTrustPending(body.trustPending);

		if (body.transport !== undefined) return this.handleTransport(body.transport);
		if (body.reach !== undefined) return this.handleReach(body.reach);
		if (body.gateways !== undefined) return this.handleGateways();
		if (body.ownerOp !== undefined) {
			if (!this.onOwnerOp) return bounce(501, `owner op not available`, false);
			const result = await this.onOwnerOp(body.ownerOp);
			if (typeof result === "object" && result !== null && "malformed" in result)
				return bounce(400, `invalid owner op`, false);
			return json(result, 200);
		}

		return bounce(404, `route not found`, false);
	}
}

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function bounce(status: number, error: string, retryable = true): Response {
	return json({ error, retryable }, status);
}
