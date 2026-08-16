import { timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function constantTimeBearerEquals(provided: string | null, expected: string): boolean {
	if (!provided) return false;
	const left = Buffer.from(provided);
	const right = Buffer.from(`Bearer ${expected}`);
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

////////////////////////////////
//  Constants

const MAX_INGEST_LINES = 2000;
const MAX_INGEST_BYTES = 512 * 1024;

////////////////////////////////
//  Interfaces & Types

export interface GatewayFrameSink {
	isConnected(): boolean;
	pushGatewayFrame(frame: Record<string, unknown>): boolean;
	pushToGateway(gatewayId: string, frame: Record<string, unknown>): boolean;
	gatewayIds(): string[];
}

export interface ConsoleSurfaceParams {
	port: number;
	authToken: string;
	getBridge: () => GatewayFrameSink | null;
	timeoutMs?: number;
	ingestFile?: string;
	onEnrollOp?: (op: EnrollOp) => EnrollResult | Promise<EnrollResult>;
	onFirstRoot?: (signed: SignedFirstRoot) => EnrollResult | Promise<EnrollResult>;
	onEnrollHandshake?: (op: EnrollHandshakeOp) => EnrollHandshakeResult | Promise<EnrollHandshakeResult>;
	onConsoleApproval?: (op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>;
	onRoster?: (req: RosterRequest) => RosterResult | Promise<RosterResult>;
	onTrustHandshake?: (op: TrustHandshakeOp) => TrustHandshakeResult | Promise<TrustHandshakeResult>;
	onTrustPending?: (req: TrustPendingRequest) => TrustPendingResult | Promise<TrustPendingResult>;
	onTransport?: (req: TransportRequest) => TransportResult | Promise<TransportResult>;
	/** How a console reaches this Router from either side of a NAT that does not hairpin. Behind the
	 * app token on purpose: a LAN address on the public /health would tell any scanner this port-forward
	 * ends on a home network at a specific private address, and only a console that already holds the
	 * token has any use for it. */
	onReach?: () => RouterReachAnswer;
	/** The gateways registered into the admin Domain, for the host's own setup screen. Admin Domain
	 * only, and never every Domain: the app token is shared by every tenant's console. */
	onGateways?: () => RouterGatewaysAnswer;
}

/** What the `reach` op answers. Both fields may be empty on a Router whose owner has not configured
 * them; the console then keeps whatever address it already has. `publicPort` is the port the public
 * host is dialed on, which is not the Router's own port when a forward remaps it; absent means the
 * Router's own. LAN addresses are always on the Router's own port. */
export interface RouterReachAnswer {
	publicHost: string | null;
	publicPort?: number;
	lanAddresses: string[];
}

/** What the `gateways` op answers. `signFp` is null for an identity-less registration. */
export interface RouterGatewaysAnswer {
	gateways: { gatewayId: string; signFp: string | null }[];
}

const CONSOLE_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 55_000;
const APP_TOKEN_HEADER = "x-console-bridge-token";

////////////////////////////////
//  Class

export class ConsoleSurface {
	private readonly authToken: string;
	private readonly getBridge: () => GatewayFrameSink | null;
	private readonly timeoutMs: number;
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
	private readonly onReach: (() => RouterReachAnswer) | null;
	private readonly onGateways: (() => RouterGatewaysAnswer) | null;
	private readonly pending = new Map<
		string,
		{ resolve: (res: Response) => void; timer: ReturnType<typeof setTimeout> }
	>();

	public constructor({
		port,
		authToken,
		getBridge,
		timeoutMs,
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
	}: ConsoleSurfaceParams) {
		this.authToken = authToken;
		this.getBridge = getBridge;
		this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
		this.handleRequest = this.handleRequest.bind(this);
	}

	public start(): void {
		throw new Error("ConsoleSurface requires RouterServer");
	}

	public stop(): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.resolve(bounce(503, `console bridge shutting down`));
		}
		this.pending.clear();
	}

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

	/** No request payload beyond the discriminator and no signature: the app token that gated this
	 * request IS the proof, and the answer is configuration, not state a signer could contest. */
	private handleReach(): Response {
		if (!this.onReach) return bounce(501, `reach not available`, false);
		return json(this.onReach(), 200);
	}

	private handleGateways(): Response {
		if (!this.onGateways) return bounce(501, `gateways not available`, false);
		return json(this.onGateways(), 200);
	}

	public settleConsoleRelay(opId: string, reply: Record<string, unknown>): void {
		const entry = this.pending.get(opId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(opId);
		entry.resolve(json(reply, 200));
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
			// An IO failure here must not reject: the request launch is not awaited.
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

	public async handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url, "http://console-bridge");
		if (req.method !== "POST") return bounce(405, `method not allowed`);
		if (!constantTimeBearerEquals(req.headers.get(APP_TOKEN_HEADER), this.authToken)) {
			// Log the refusal, never the token. A silent 401 is indistinguishable from a console
			// that never arrived, which is the one thing an operator needs to tell apart when a
			// migrated Router and an already-provisioned console disagree about this secret.
			console.log(`[console] rejected ${url.pathname}: app token mismatch`);
			return new Response(`Unauthorized`, { status: 401 });
		}

		if (url.pathname === "/ingest") return this.handleIngest(req);

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
		if (body.reach !== undefined) return this.handleReach();
		if (body.gateways !== undefined) return this.handleGateways();

		const { opId, signerSignPub, sealed, targetGateway } = body;
		if (
			typeof opId !== "string" ||
			typeof signerSignPub !== "string" ||
			typeof sealed !== "object" ||
			sealed === null
		) {
			return bounce(400, `opId, signerSignPub (strings) and sealed (object) are required`, false);
		}

		if (this.pending.has(opId)) {
			return bounce(409, `op already in flight`, true);
		}

		const bridge = this.getBridge();
		if (!bridge?.isConnected()) {
			return bounce(503, `gateway not connected`, true);
		}

		// A NAMED gateway that is not connected is refused here, never delivered to another one. The
		// fallback below picks the first connected gateway in the Domain, which is right for a frame
		// that names none and wrong for a frame that does: the frame is sealed to the named gateway's
		// box key, so the substitute cannot open it and answers "unseal failed" - a message about
		// cryptography for what is only a machine being switched off. Unreachable while one gateway
		// existed; the console began addressing a second one and it became the failure every op on an
		// offline machine reported.
		const route = (typeof targetGateway === "string" && targetGateway) || "";
		if (route && !bridge.gatewayIds().includes(route)) {
			return bounce(503, `gateway "${route}" is not connected`, true);
		}

		return new Promise<Response>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(opId);
				resolve(bounce(504, `relay timed out`, true));
			}, this.timeoutMs);
			this.pending.set(opId, { resolve, timer });

			const frame = { type: "console_relay", v: CONSOLE_PROTOCOL_VERSION, opId, signerSignPub, sealed };
			const pushed = route ? bridge.pushToGateway(route, frame) : bridge.pushGatewayFrame(frame);
			if (!pushed) {
				clearTimeout(timer);
				this.pending.delete(opId);
				resolve(bounce(503, `gateway unavailable`, true));
			}
		});
	}
}

////////////////////////////////
//  Functions & Helpers

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function bounce(status: number, error: string, retryable = true): Response {
	return json({ error, retryable }, status);
}
