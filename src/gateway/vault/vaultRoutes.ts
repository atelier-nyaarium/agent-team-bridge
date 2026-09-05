// Vault values leave only in approved answers.

import { type Ambient, withinMs } from "../../shared/ambient.js";
import { MIGRATING } from "../../shared/migration-fence.js";
import {
	VAULT_ROUTE_WAIT_CAP_MS,
	type VaultApprovedDecision,
	VaultAskpassRequestSchema,
	VaultCaptureRequestSchema,
	VaultCollectRequestSchema,
	type VaultPublicEntry,
	type VaultRequest,
	VaultSearchRequestSchema,
	VaultUseRequestSchema,
	type VaultValueAnswer,
	VaultWithdrawRequestSchema,
} from "../../shared/schemasVault.js";
import { bindingTokensEqual } from "../../shared/session-tokens.js";
import { jsonResponse as json } from "../agentRouteEnvelope.js";
import type { VaultClient, VaultEntryView } from "../router/vaultClient.js";
import { presentedByRequest } from "../sessionAuthority.js";
import { type GrantScope, operationShape, type VaultDecisions } from "./decisions.js";
import type { HelperTokens } from "./helperTokens.js";
import { helperTarget, type VaultRequestAnswer, type VaultRequests } from "./requests.js";

const DEFAULT_WAIT_MS = 25_000;
const REFUSAL = "the owner did not authorize";
const HELPER_TOKEN_HEADER = "x-vault-helper-token";

export interface VaultRoutesDeps {
	client: () => VaultClient | null;
	decisions: VaultDecisions;
	requests: VaultRequests;
	helperTokens: HelperTokens;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	/** Resolve requests to session teams. */
	resolveCaller: (req: Request) => string | null;
	/** A notice in the session's thread. */
	notifyOwner: (sessionTarget: string, title: string, body: string) => void;
	hostToken?: string;
}

type Handler = (req: Request, body: unknown) => Promise<Response>;

/** Who asked: a bound session by its team, or the helper by its token. */
type Principal = { kind: "session"; target: string } | { kind: "helper"; target: string };

const refused = (reason: string, status = 403): Response =>
	json({ outcome: "refused", reason } satisfies VaultValueAnswer, status);

/** Migration, an unreachable owner, and too many open requests each read differently. */
const unopened = (reason: "migrating" | "unreachable" | "flooded"): Response => {
	if (reason === "flooded")
		return json({ outcome: "refused", reason: "too many vault requests are already open for this caller" }, 429);
	return json(
		{ outcome: "refused", reason: reason === "migrating" ? MIGRATING : "the owner cannot be reached" },
		503,
	);
};

const publicView = (entry: VaultEntryView): VaultPublicEntry => ({
	id: entry.id,
	publicTitle: entry.publicTitle ?? "",
	...(entry.publicDescription === null ? {} : { publicDescription: entry.publicDescription }),
	hasValue: entry.hasValue,
});

export function createVaultRoutes(deps: VaultRoutesDeps): Map<string, Handler> {
	const waitFor = (requested: number | undefined) => Math.min(requested ?? DEFAULT_WAIT_MS, VAULT_ROUTE_WAIT_CAP_MS);

	/** One credential per caller; each route names the kinds it serves. An unknown token answers not found, as the agent routes do. */
	const principal = (req: Request, accepts: ReadonlyArray<Principal["kind"]>): Principal | Response => {
		const helperToken = req.headers.get(HELPER_TOKEN_HEADER);
		if (helperToken) {
			const tokenId = deps.helperTokens.verify(helperToken);
			if (tokenId && accepts.includes("helper")) return { kind: "helper", target: helperTarget(tokenId) };
			return json({ error: "not found" }, 404);
		}
		const team = deps.resolveCaller(req);
		if (team && accepts.includes("session")) return { kind: "session", target: team };
		return team || presentedByRequest(req).token
			? json({ error: "not found" }, 404)
			: json({ error: "this session is not bound to the gateway" }, 401);
	};

	async function ready(): Promise<VaultClient | Response> {
		const client = deps.client();
		if (!client) return json({ error: "vault unavailable: this Gateway is not enrolled" }, 503);
		const refreshed = await client.refresh();
		if (refreshed.kind !== "ok") return json({ error: `vault unavailable: ${refreshed.error}` }, 503);
		return client;
	}

	const usable = (
		client: VaultClient,
		entryId: string,
	): { entry: VaultEntryView; value: () => string | null } | Response => {
		const stored = client.stored(entryId);
		if (!stored) return refused("no such entry", 404);
		const entry = client.view(stored);
		if (!entry.hasValue) return refused("the entry holds no value", 409);
		if (!client.allowedHere(entry)) return refused("this Gateway may not use the entry");
		return { entry, value: () => client.openValue(stored) };
	};

	/** The wait ends at the answer, the budget, or the caller leaving; a leaver takes no answer. */
	async function waitAnswer(
		answer: Promise<VaultRequestAnswer>,
		waitMs: number,
		signal: AbortSignal,
	): Promise<VaultRequestAnswer | null | "gone"> {
		if (signal.aborted) return "gone";
		let onAbort: () => void = () => undefined;
		const gone = new Promise<"gone">((resolve) => {
			onAbort = () => resolve("gone");
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([withinMs(deps.ambient, answer, waitMs), gone]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Grants answer immediately; otherwise requests wait. A retry joins the request still open. */
	async function decide(
		req: Request,
		scope: GrantScope,
		operation: string,
		value: () => string | null,
		waitMs: number,
	): Promise<Response> {
		const covering = deps.decisions.covers(scope, deps.ambient.now());
		if (covering) return approved(covering.tier, value());
		const input = { kind: "entry" as const, entryId: scope.entryId, operation, sessionTarget: scope.sessionTarget };
		const existing = deps.requests.find(input);
		const opened = existing ? { kind: "opened" as const, ...existing } : deps.requests.open(input);
		if (opened.kind !== "opened") return unopened(opened.reason);
		return settle(await waitAnswer(opened.answer, waitMs, req.signal), opened.request, value);
	}

	function approved(decision: VaultApprovedDecision, value: string | null): Response {
		if (value === null) return json({ outcome: "refused", reason: "the value could not be opened" }, 503);
		return json({ outcome: "approved", decision, value } satisfies VaultValueAnswer);
	}

	/**
	 * An entry approval is shared: it named this caller's own operation, so every waiter joined to
	 * the request takes the value. A typed value is delivered once, to whoever collects first.
	 */
	function settle(
		answer: VaultRequestAnswer | null | "gone",
		request: VaultRequest,
		value: () => string | null,
	): Response {
		if (answer === null || answer === "gone")
			return json({
				outcome: "pending",
				requestId: request.requestId,
				deadlineAt: request.deadlineAt,
			} satisfies VaultValueAnswer);
		const taken = deps.requests.forget(request.requestId);
		if (answer.kind === "refused") return refused(REFUSAL);
		if (!taken && answer.typedValue !== undefined) return refused(REFUSAL);
		return approved(answer.decision, answer.typedValue ?? value());
	}

	const search: Handler = async (req, body) => {
		const who = principal(req, ["session"]);
		if (who instanceof Response) return who;
		const parsed = VaultSearchRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault search" }, 400);
		const client = await ready();
		if (client instanceof Response) return client;
		const query = parsed.data.query?.trim().toLowerCase();
		const entries = client
			.live()
			.map((stored) => client.view(stored))
			.filter((entry) => entry.publicTitle !== null && client.allowedHere(entry))
			.filter(
				(entry) =>
					!query ||
					entry.publicTitle?.toLowerCase().includes(query) ||
					entry.publicDescription?.toLowerCase().includes(query),
			)
			.map(publicView);
		return json({ entries });
	};

	const use: Handler = async (req, body) => {
		const who = principal(req, ["session"]);
		if (who instanceof Response) return who;
		const parsed = VaultUseRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault use request" }, 400);
		const client = await ready();
		if (client instanceof Response) return client;
		const found = usable(client, parsed.data.entryId);
		if (found instanceof Response) return found;
		const scope = {
			entryId: parsed.data.entryId,
			shape: operationShape(parsed.data.operation),
			sessionTarget: who.target,
		};
		return decide(req, scope, parsed.data.operation, found.value, waitFor(parsed.data.waitMs));
	};

	const collect: Handler = async (req, body) => {
		const who = principal(req, ["session", "helper"]);
		if (who instanceof Response) return who;
		const parsed = VaultCollectRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault collect request" }, 400);
		const pending = deps.requests.collect(parsed.data.requestId, who.target);
		if (!pending) return refused(REFUSAL);
		const answer = await waitAnswer(pending.answer, waitFor(parsed.data.waitMs), req.signal);
		if (answer === null || answer === "gone" || answer.kind !== "approved" || pending.request.kind !== "entry")
			return settle(answer, pending.request, () => null);
		const client = await ready();
		if (client instanceof Response) return client;
		const found = usable(client, pending.request.entryId);
		return settle(answer, pending.request, found instanceof Response ? () => null : found.value);
	};

	const withdraw: Handler = async (req, body) => {
		const who = principal(req, ["session", "helper"]);
		if (who instanceof Response) return who;
		const parsed = VaultWithdrawRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault withdraw request" }, 400);
		return json({ withdrawn: deps.requests.withdraw(parsed.data.requestId, who.target) });
	};

	const capture: Handler = async (req, body) => {
		const who = principal(req, ["session"]);
		if (who instanceof Response) return who;
		const parsed = VaultCaptureRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault capture" }, 400);
		const client = await ready();
		if (client instanceof Response) return client;
		const id = deps.ambient.newId();
		// Trim the shell's trailing newline.
		const value = parsed.data.value.endsWith("\n") ? parsed.data.value.slice(0, -1) : parsed.data.value;
		if (!value) return json({ error: "invalid vault capture" }, 400);
		const created = await client.create({ id, ...parsed.data, value });
		if (created.kind === "unavailable") return json({ error: created.error }, 503);
		if (created.kind === "refused") return json({ error: created.refusal }, 409);
		deps.notifyOwner(
			who.target,
			"Vault entry captured",
			`${who.target} captured "${parsed.data.publicTitle}" as ${id}.`,
		);
		return json({ id });
	};

	/** Unique title match selects an entry; otherwise input is typed. */
	const askpass: Handler = async (req, body) => {
		const who = principal(req, ["helper"]);
		if (who instanceof Response) return who;
		const parsed = VaultAskpassRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid askpass request" }, 400);
		const client = await ready();
		if (client instanceof Response) return client;
		const shape = operationShape(parsed.data.cmdline);
		const sessionTarget = who.target;
		const waitMs = waitFor(parsed.data.waitMs);
		// Duplicate titles require typed input.
		const matches = client
			.live()
			.map((stored) => ({ stored, entry: client.view(stored) }))
			.filter(
				({ entry }) =>
					entry.hasValue &&
					client.allowedHere(entry) &&
					entry.publicTitle?.toLowerCase() === shape.toLowerCase(),
			);
		const match = matches.length === 1 ? matches[0] : undefined;
		if (match) {
			const scope = { entryId: match.entry.id, shape, sessionTarget };
			return decide(req, scope, parsed.data.cmdline, () => client.openValue(match.stored), waitMs);
		}
		const opened = deps.requests.open({ kind: "typed", operation: parsed.data.cmdline, sessionTarget });
		if (opened.kind !== "opened") return unopened(opened.reason);
		return settle(await waitAnswer(opened.answer, waitMs, req.signal), opened.request, () => null);
	};

	/** Host token gates helper minting; an unenrolled gateway has no vault to mint for. */
	const helperToken: Handler = async (req) => {
		const presented = req.headers.get("x-host-token");
		if (!deps.hostToken || !presented || !bindingTokensEqual(presented, deps.hostToken))
			return json({ error: "host token required" }, 401);
		if (!deps.client()) return json({ error: "vault unavailable: this Gateway is not enrolled" }, 503);
		const minted = deps.helperTokens.mint();
		return minted ? json(minted) : json({ error: "the helper token could not be stored" }, 503);
	};

	return new Map<string, Handler>([
		["/vault/search", search],
		["/vault/use", use],
		["/vault/collect", collect],
		["/vault/withdraw", withdraw],
		["/vault/capture", capture],
		["/vault/askpass", askpass],
		["/vault/helper-token", helperToken],
	]);
}
