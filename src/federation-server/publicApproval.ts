import {
	type ConsoleApprovalOp,
	ConsoleApprovalOpSchema,
	type ConsoleApprovalResult,
} from "../shared/federation-lifecycle.js";

////////////////////////////////
//  Interfaces & Types

export interface PublicApprovalParams {
	// Public join/fetch only.
	port: number;
	onApproval: (op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>;
	maxBodyBytes?: number;
	maxGlobalPerWindow?: number;
	maxPerIdPerWindow?: number;
	rateLimitWindowMs?: number;
	now?: () => number;
}

////////////////////////////////
//  Constants

// Small public body cap.
const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
// Fixed-window request caps.
const DEFAULT_MAX_GLOBAL_PER_WINDOW = 600;
const DEFAULT_MAX_PER_ID_PER_WINDOW = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

////////////////////////////////
//  Class

const _MAX_PUBLIC_BODY_BYTES = 65_536;

export class PublicApproval {
	private readonly onApproval: (op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>;
	private readonly maxBodyBytes: number;
	private readonly maxGlobalPerWindow: number;
	private readonly maxPerIdPerWindow: number;
	private readonly rateLimitWindowMs: number;
	private readonly now: () => number;

	private windowStartedAt = 0;
	private globalCount = 0;
	private readonly perId = new Map<string, number>();

	public constructor({
		port,
		onApproval,
		maxBodyBytes,
		maxGlobalPerWindow,
		maxPerIdPerWindow,
		rateLimitWindowMs,
		now,
	}: PublicApprovalParams) {
		this.onApproval = onApproval;
		this.maxBodyBytes = maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		this.maxGlobalPerWindow = maxGlobalPerWindow ?? DEFAULT_MAX_GLOBAL_PER_WINDOW;
		this.maxPerIdPerWindow = maxPerIdPerWindow ?? DEFAULT_MAX_PER_ID_PER_WINDOW;
		this.rateLimitWindowMs = rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
		this.now = now ?? Date.now;
		this.handleRequest = this.handleRequest.bind(this);
	}

	public start(): void {
		throw new Error("PublicApproval requires RouterServer");
	}

	public stop(): void {}

	public async handleRequest(req: Request): Promise<Response> {
		if (req.method !== "POST") return notFound();
		if (this.globalRateLimited()) return tooManyRequests();

		const contentLength = Number(req.headers.get("content-length") ?? 0);
		if (contentLength > this.maxBodyBytes) return payloadTooLarge();

		let raw: string;
		try {
			raw = await req.text();
		} catch {
			return notFound();
		}
		if (raw.length > this.maxBodyBytes) return payloadTooLarge();

		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return notFound();
		}

		const parsed = ConsoleApprovalOpSchema.safeParse(body);
		if (!parsed.success) return notFound();
		const op = parsed.data;
		if (op.step !== "join" && op.step !== "fetch") return notFound();

		if (this.perIdRateLimited(op.approvalId)) return tooManyRequests();

		const result = await this.onApproval(op);
		return json(result, 200);
	}

	////////////////////////////////
	//  Functions & Helpers

	private rollWindow(): void {
		const now = this.now();
		if (now - this.windowStartedAt >= this.rateLimitWindowMs) {
			this.windowStartedAt = now;
			this.globalCount = 0;
			this.perId.clear();
		}
	}

	private globalRateLimited(): boolean {
		this.rollWindow();
		this.globalCount += 1;
		return this.globalCount > this.maxGlobalPerWindow;
	}

	private perIdRateLimited(approvalId: string): boolean {
		const next = (this.perId.get(approvalId) ?? 0) + 1;
		this.perId.set(approvalId, next);
		return next > this.maxPerIdPerWindow;
	}
}

////////////////////////////////
//  Functions & Helpers

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function notFound(): Response {
	return new Response("Not Found", { status: 404 });
}

function payloadTooLarge(): Response {
	return new Response("Payload Too Large", { status: 413 });
}

function tooManyRequests(): Response {
	return new Response("Too Many Requests", { status: 429 });
}
