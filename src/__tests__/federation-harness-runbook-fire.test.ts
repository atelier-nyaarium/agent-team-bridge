import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ConsoleRunbookFireResultSchema,
	ConsoleRunbookPreviewResultSchema,
	ConsoleRunbookPutResultSchema,
	type Runbook,
	type RunbookFireTarget,
} from "../shared/schemasRunbook.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("federation harness: firing a runbook", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	beforeAll(async () => {
		h = await startFederationHarness({ wakeTimeoutMs: 300 });
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	const release: Runbook = {
		id: "release",
		name: "Release",
		body: "Cut a {{level}} release of {{repo}}. Never hand-edit a version.",
		parameters: [
			{ name: "level", label: "Level", kind: "choice", options: ["patch", "minor"], default: "patch" },
			{ name: "repo", label: "Repo", kind: "text" },
		],
		revision: 1,
	};

	const fire = async (values: Record<string, string>, into: RunbookFireTarget, opId?: string) =>
		ConsoleRunbookFireResultSchema.parse(
			(await h.phone.value({ kind: "runbook_fire", runbookId: release.id, values, into }, opId)).result,
		);

	/** What the fake daemon does when the gateway asks it to launch: register, or never answer. */
	const launchesInto = (registers: boolean) => {
		const launched: FakeSession[] = [];
		h.host.handlers.onCreateSession = (op) => {
			if (!registers) return;
			const attached = attachFakeSession(h.gateway, {
				team: composeSessionName(op.target.name, op.target.sessionName),
				conversationId: `conv-launch-${op.target.sessionName}`,
				sessionToken: op.sessionToken,
			});
			sessions.push(attached);
			launched.push(attached);
		};
		return launched;
	};

	it("renders the stored body and lands it in a session that is listening", async () => {
		const put = ConsoleRunbookPutResultSchema.parse(
			(await h.phone.value({ kind: "runbook_put", runbook: release })).result,
		);
		expect(put.stored).toBe(true);

		const target = "fixture-app.release";
		const attached = attachFakeSession(h.gateway, { team: target, conversationId: "conv-runbook-fire" });
		sessions.push(attached);
		await attached.ready();

		const fired = await fire({ level: "minor", repo: "switchboard" }, { kind: "session", target });
		expect(fired.fired).toBe(true);

		const body = "Cut a minor release of switchboard. Never hand-edit a version.";
		await h.waitFor(async () => attached.inbound.find((frame) => frame.body === body), "the rendered runbook");
	});

	it("refuses by name rather than shipping a placeholder as instruction", async () => {
		const target = "fixture-app.release";
		const missing = await fire({ level: "minor" }, { kind: "session", target });
		expect(missing.fired).toBe(false);
		expect(missing.reason).toContain("repo");

		const notOffered = await fire({ level: "major", repo: "switchboard" }, { kind: "session", target });
		expect(notOffered.fired).toBe(false);
	});

	it("answers a retry from what it already sent, rather than firing twice", async () => {
		const target = "fixture-app.retry";
		const attached = attachFakeSession(h.gateway, { team: target, conversationId: "conv-runbook-retry" });
		sessions.push(attached);
		await attached.ready();

		const values = { level: "patch", repo: "lexicon" };
		const body = "Cut a patch release of lexicon. Never hand-edit a version.";
		const landed = () => attached.inbound.filter((frame) => frame.body === body).length;

		const first = await fire(values, { kind: "session", target }, "op-fire-once");
		expect(first.fired).toBe(true);
		await h.waitFor(async () => (landed() === 1 ? true : undefined), "the first delivery");

		const again = await fire(values, { kind: "session", target }, "op-fire-once");
		expect(again).toEqual(first);
		expect(landed()).toBe(1);
	});

	it("refuses a second fire of the same op while the first is still going", async () => {
		const target = "fixture-app.concurrent";
		const attached = attachFakeSession(h.gateway, { team: target, conversationId: "conv-runbook-concurrent" });
		sessions.push(attached);
		await attached.ready();

		const values = { level: "minor", repo: "switchboard" };
		const body = "Cut a minor release of switchboard. Never hand-edit a version.";
		const both = await Promise.all([
			fire(values, { kind: "session", target }, "op-fire-concurrent"),
			fire(values, { kind: "session", target }, "op-fire-concurrent"),
		]);

		// One attempt is refused, and the body still lands exactly once.
		expect(both.some((answer) => !answer.fired)).toBe(true);
		await h.waitFor(
			async () => (attached.inbound.filter((frame) => frame.body === body).length === 1 ? true : undefined),
			"exactly one delivery",
		);
	});

	it("creates a session, waits for it to listen, then lands the runbook in it", async () => {
		const launched = launchesInto(true);
		const fired = await fire({ level: "patch", repo: "evie-bot" }, { kind: "new", target: "host" });
		expect(fired.fired).toBe(true);
		expect(fired.sessionId).toBeTruthy();

		const attached = await h.waitFor(async () => launched[0], "the launched session");
		const body = "Cut a patch release of evie-bot. Never hand-edit a version.";
		await h.waitFor(async () => attached.inbound.find((frame) => frame.body === body), "the rendered runbook");
	});

	it("does not fire when the session it created never starts listening", async () => {
		launchesInto(false);
		const answer = await fire({ level: "patch", repo: "quiet" }, { kind: "new", target: "host" });
		expect(answer.fired).toBe(false);
		// The session is left to be fired at again rather than closed.
		expect(answer.sessionId).toBeTruthy();
		expect(h.gateway.faults.sessionRecord(composeSessionName("host", answer.sessionId as string))).toBeTruthy();
	});

	it("previews exactly what a fire would send, and sends nothing", async () => {
		const target = "fixture-app.preview";
		const attached = attachFakeSession(h.gateway, { team: target, conversationId: "conv-runbook-preview" });
		sessions.push(attached);
		await attached.ready();

		const values = { level: "minor", repo: "nyaadot" };
		const shown = ConsoleRunbookPreviewResultSchema.parse(
			(await h.phone.value({ kind: "runbook_preview", runbookId: release.id, values })).result,
		);
		expect(shown.text).toBe("Cut a minor release of nyaadot. Never hand-edit a version.");
		expect(shown.revision).toBe(release.revision);
		expect(attached.inbound.filter((frame) => typeof frame.body === "string")).toEqual([]);

		const fired = await fire(values, { kind: "session", target });
		expect(fired.fired).toBe(true);
		await h.waitFor(
			async () => attached.inbound.find((frame) => frame.body === shown.text),
			"the previewed body, unchanged",
		);
	});

	it("refuses a fire pinned to a revision the runbook has moved past", async () => {
		const stale = ConsoleRunbookFireResultSchema.parse(
			(
				await h.phone.value({
					kind: "runbook_fire",
					runbookId: release.id,
					values: { level: "minor", repo: "switchboard" },
					into: { kind: "session", target: "fixture-app.release" },
					expectedRevision: release.revision + 1,
				})
			).result,
		);
		expect(stale.fired).toBe(false);
		expect(stale.reason).toContain("preview it again");
	});

	it("does not fire a runbook this gateway does not hold", async () => {
		const answer = ConsoleRunbookFireResultSchema.parse(
			(
				await h.phone.value({
					kind: "runbook_fire",
					runbookId: "absent",
					values: {},
					into: { kind: "session", target: "fixture-app.release" },
				})
			).result,
		);
		expect(answer.fired).toBe(false);
		expect(answer.reason).toContain("absent");
	});
});
