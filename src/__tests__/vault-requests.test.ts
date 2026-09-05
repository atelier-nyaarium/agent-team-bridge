import { describe, expect, it } from "vitest";
import { createVaultRequests } from "../gateway/vault/requests.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import { VAULT_REQUEST_DEADLINE_MS, type VaultRequest } from "../shared/schemasVault.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const envelope = (text: string): ContentEnvelope => ({ v: 1, epoch: 1, nonce: "AAAA", ciphertext: text });

function bench(options: { deliverable?: boolean } = {}) {
	const ambient = fakeAmbient({ drive: "manual", now: () => 1_000_000 });
	const delivered: VaultRequest[] = [];
	const approved: Array<{ requestId: string; decision: string }> = [];
	const requests = createVaultRequests({
		ambient,
		deliver: (request) => {
			if (options.deliverable === false) return false;
			delivered.push(request);
			return true;
		},
		openTyped: (value, requestId) => (value.ciphertext === `typed:${requestId}` ? "hunter2" : null),
		onApproved: (request, decision) => approved.push({ requestId: request.requestId, decision }),
	});
	return { ambient, requests, delivered, approved };
}

describe("vault requests", () => {
	it("opens as a request row, answers once, and refuses the second tap", async () => {
		const { requests, delivered, approved } = bench();
		const opened = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh deploy@prod",
			sessionTarget: "host.alice",
		});
		if (opened.kind !== "opened") throw new Error("the request did not open");
		expect(delivered[0]).toMatchObject({
			v: 1,
			kind: "entry",
			entryId: "deploy",
			shape: "ssh deploy@prod",
			sessionTarget: "host.alice",
			deadlineAt: 1_000_000 + VAULT_REQUEST_DEADLINE_MS,
		});
		expect(requests.answer(opened.request.requestId, "window")).toEqual({ ok: true });
		await expect(opened.answer).resolves.toEqual({ kind: "approved", decision: "window" });
		expect(approved).toEqual([{ requestId: opened.request.requestId, decision: "window" }]);
		expect(requests.answer(opened.request.requestId, "deny")).toMatchObject({ ok: false });
		expect(requests.answer("unknown", "once")).toMatchObject({ ok: false });
	});

	it("a deny and the deadline both refuse, and an undeliverable row never opens", async () => {
		const { ambient, requests, delivered } = bench();
		const denied = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh deploy@prod",
			sessionTarget: "host.alice",
		});
		const expired = requests.open({ kind: "typed", operation: "sudo apt install foo", sessionTarget: "helper.h1" });
		if (denied.kind !== "opened" || expired.kind !== "opened") throw new Error("the requests did not open");
		expect(requests.answer(denied.request.requestId, "deny")).toEqual({ ok: true });
		await expect(denied.answer).resolves.toEqual({ kind: "refused" });

		await ambient.advance(VAULT_REQUEST_DEADLINE_MS + 1);
		await expect(expired.answer).resolves.toEqual({ kind: "refused" });
		expect(requests.collect(expired.request.requestId, "helper.h1")).toBeUndefined();
		expect(delivered).toHaveLength(2);

		const undeliverable = bench({ deliverable: false }).requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh deploy@prod",
			sessionTarget: "host.alice",
		});
		expect(undeliverable).toEqual({ kind: "undeliverable", reason: "unreachable" });
	});

	it("an answer waits to be collected until the deadline, and a session's end drops its requests", async () => {
		const { ambient, requests } = bench();
		const opened = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.alice",
		});
		if (opened.kind !== "opened") throw new Error("the request did not open");
		const { requestId } = opened.request;
		expect(requests.answer(requestId, "once")).toEqual({ ok: true });
		await ambient.advance(VAULT_REQUEST_DEADLINE_MS - 1);
		expect(requests.collect(requestId, "host.alice")?.request.requestId).toBe(requestId);
		await ambient.advance(2);
		expect(requests.collect(requestId, "host.alice")).toBeUndefined();

		const late = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.alice",
		});
		const ended = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.carol",
		});
		if (late.kind !== "opened" || ended.kind !== "opened") throw new Error("the requests did not open");
		requests.sessionEnded("host.carol");
		await expect(ended.answer).resolves.toEqual({ kind: "refused" });
		expect(requests.collect(ended.request.requestId, "host.carol")).toBeUndefined();
		expect(requests.collect(late.request.requestId, "host.alice")).toBeDefined();
	});

	it("a typed request needs a value sealed to it, and collect answers only the asking session", async () => {
		const { requests, approved } = bench();
		const typed = requests.open({ kind: "typed", operation: "sudo apt install foo", sessionTarget: "helper.h1" });
		if (typed.kind !== "opened") throw new Error("the request did not open");
		const { requestId } = typed.request;
		expect(requests.answer(requestId, "once")).toMatchObject({ ok: false });
		expect(requests.answer(requestId, "once", envelope("typed:other"))).toMatchObject({ ok: false });
		expect(requests.collect(requestId, "host.alice")).toBeUndefined();
		expect(requests.collect(requestId, "helper.h1")?.request.requestId).toBe(requestId);
		expect(requests.answer(requestId, "once", envelope(`typed:${requestId}`))).toEqual({ ok: true });
		await expect(typed.answer).resolves.toEqual({ kind: "approved", decision: "once", typedValue: "hunter2" });
		// Typed values never grant.
		expect(approved).toEqual([]);
		expect(requests.forget(requestId)).toBe(true);
		expect(requests.forget(requestId)).toBe(false);
		expect(requests.collect(requestId, "helper.h1")).toBeUndefined();
	});
});
