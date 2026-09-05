import { ROUTER_PATHS } from "../shared/wire-vocabulary.js";

/** Body cap per path; zero means the body is never read. */
export function bodyCapFor(pathname: string): number {
	if (pathname === ROUTER_PATHS.deviceApproval || pathname.startsWith(`${ROUTER_PATHS.deviceApproval}/`))
		return 8 * 1024;
	if (pathname === ROUTER_PATHS.ingest) return 512 * 1024;
	if (pathname === ROUTER_PATHS.console) return 67_108_864;
	return 0;
}

export type BodyRead = { outcome: "ok"; bytes: Buffer } | { outcome: "too-large" } | { outcome: "aborted" };

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/** The one settlement behind both server surfaces: the cap, the refusals, and the request they build. */
export function settleRequest(url: URL, method: string, headers: Headers, body: BodyRead): Request | Response {
	if (body.outcome === "too-large") return new Response("Payload Too Large", { status: 413 });
	if (body.outcome === "aborted") return new Response(null, { status: 499 });
	if (body.bytes.length > bodyCapFor(url.pathname)) return new Response("Payload Too Large", { status: 413 });
	// A bodyless method carrying bytes has no request to build.
	if (body.bytes.length && BODYLESS_METHODS.has(method.toUpperCase()))
		return new Response("Body Not Allowed", { status: 400 });
	return new Request(url, { method, headers, body: body.bytes.length ? new Uint8Array(body.bytes) : undefined });
}

/** The Fetch surface, read whole because a Fetch body has no incremental cap. */
export async function readFetchRequest(source: Request, url: URL): Promise<Request | Response> {
	const bytes = bodyCapFor(url.pathname) === 0 ? Buffer.alloc(0) : Buffer.from(await source.arrayBuffer());
	return settleRequest(url, source.method, source.headers, { outcome: "ok", bytes });
}
