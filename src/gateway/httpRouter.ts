import { timingSafeEqual } from "node:crypto";
import type { BlobStore } from "../shared/blob-store.js";
import { BlobGetOpSchema, BlobPutOpSchema, BlobStatOpSchema } from "../shared/schemas.js";
import { answerBlobOp, BlobTooLarge } from "./blobOps.js";
import type { createRoutes } from "./routes.js";
import { presentedByRequest, type SessionAuthority } from "./sessionAuthority.js";

const BLOB_ROUTE_SCHEMAS = {
	"/blob/stat": BlobStatOpSchema,
	"/blob/put": BlobPutOpSchema,
	"/blob/get": BlobGetOpSchema,
} as const;

type GatewayRoutes = ReturnType<typeof createRoutes>;

export type HttpRoutes = Pick<
	GatewayRoutes,
	| "pending"
	| "teams"
	| "capabilities"
	| "discover"
	| "send"
	| "respond"
	| "poll"
	| "health"
	| "humanNotify"
	| "pluginAction"
	| "taskBoard"
	| "fetchBlobFromGateway"
>;

export interface HttpRouterDeps {
	handleEnrollPost: (body: Record<string, unknown>) => Response;
	enrollNonce?: string;
	/** Reads the current arming state, which a completed enrollment clears. */
	admitPayload: () => unknown;
	blobStore: BlobStore;
	sessionAuthority: Pick<SessionAuthority, "mayUseLocalPlane">;
	loopbackRoutes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
	/** Read per request: federation activating mid-session rebuilds the routes object. */
	routes: () => HttpRoutes;
}

export function createHttpRouter({
	handleEnrollPost,
	enrollNonce,
	admitPayload,
	blobStore,
	sessionAuthority,
	loopbackRoutes,
	routes,
}: HttpRouterDeps) {
	function serveAdmitPayload(req: Request): Response {
		// Admit payloads require the armed enrollment nonce.
		const presented = Buffer.from(req.headers.get("x-enroll-nonce") ?? "");
		const expected = Buffer.from(enrollNonce ?? "");
		const authed = !!enrollNonce && presented.length === expected.length && timingSafeEqual(presented, expected);
		const payload = admitPayload();
		if (!payload || !authed) {
			return new Response(JSON.stringify({ ok: false, error: "not in enrollment mode" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	async function serveBlobOp(
		req: Request,
		body: Record<string, unknown>,
		schema: (typeof BLOB_ROUTE_SCHEMAS)[keyof typeof BLOB_ROUTE_SCHEMAS],
	): Promise<Response> {
		if (!sessionAuthority.mayUseLocalPlane(presentedByRequest(req))) {
			return Response.json({ error: "blob transfer is not open to this caller" }, { status: 403 });
		}
		const parsed = schema.safeParse({ ...body, kind: schema.shape.kind.value });
		if (!parsed.success) {
			return Response.json(
				{ error: `Invalid blob request: ${parsed.error.issues[0]?.message}` },
				{ status: 400 },
			);
		}
		try {
			return Response.json(await answerBlobOp(blobStore, parsed.data, routes().fetchBlobFromGateway));
		} catch (err) {
			if (!(err instanceof BlobTooLarge)) throw err;
			return Response.json({ error: err.message }, { status: 413 });
		}
	}

	return async function router(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method;

		let body: Record<string, unknown> = {};
		if (method === "POST") {
			try {
				body = await req.json();
			} catch {
				return new Response(JSON.stringify({ error: `Invalid JSON` }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		if (method === "POST" && url.pathname === "/enroll") {
			return handleEnrollPost(body);
		}
		if (method === "GET" && url.pathname === "/admit-payload") {
			return serveAdmitPayload(req);
		}
		const r = routes();
		if (method === "GET" && url.pathname === "/pending") return r.pending(req);
		if (method === "GET" && url.pathname === "/teams") return r.teams();
		if (method === "GET" && url.pathname === "/capabilities") return r.capabilities();
		if (method === "GET" && url.pathname === "/discover") return r.discover(url);
		if (method === "POST" && url.pathname === "/send") return r.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return r.respond(req, body);
		if (method === "POST" && url.pathname === "/poll") return r.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return r.health();
		if (method === "POST" && url.pathname === "/human/notify") return r.humanNotify(req, body);
		if (method === "POST" && url.pathname === "/plugin-action") return r.pluginAction(req, body);
		if (method === "POST" && url.pathname === "/task-board") return r.taskBoard(req, body);
		if (method === "POST") {
			const agentRoute = loopbackRoutes.get(url.pathname);
			if (agentRoute) return agentRoute(req, body);
		}

		const blobRoute = BLOB_ROUTE_SCHEMAS[url.pathname as keyof typeof BLOB_ROUTE_SCHEMAS];
		if (method === "POST" && blobRoute) {
			return serveBlobOp(req, body, blobRoute);
		}

		return new Response("Not Found", { status: 404 });
	};
}
