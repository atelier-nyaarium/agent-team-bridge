import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoticeId, SessionId, TeamAddress } from "../shared/session-id.js";

////////////////////////////////
//  Session identity vectors
//
//  vectors.json is read by BOTH this suite and SessionIdVectorsTest.kt, so the
//  hand-authored Kotlin twin cannot drift from the TS source: a canonical string
//  either side produces differently fails one of the two runtimes.

interface TeamVector {
	input: string;
	localSwitchId: string;
	switchId: string;
	name: string;
	canonical: string;
}
interface SessionVector {
	input: string;
	localSwitchId: string;
	conversationId: string;
	targetCanonical: string;
	key: string;
}
interface NoticeVector {
	input: string;
	localSwitchId: string;
	senderCanonical: string;
	key: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/session-id/vectors.json"), "utf8"),
) as {
	teamAddress: TeamVector[];
	sessionId: SessionVector[];
	notice: NoticeVector[];
	notSession: string[];
	notNotice: string[];
};

describe("session identity vectors", () => {
	it.each(vectors.teamAddress.map((v) => [v.input, v] as const))("TeamAddress.parse(%s)", (_, v) => {
		const a = TeamAddress.parse(v.input, v.localSwitchId);
		expect(a.switchId).toBe(v.switchId);
		expect(a.name).toBe(v.name);
		expect(a.canonical).toBe(v.canonical);
		// local() is the idempotent qualifier: same canonical for bare or qualified input.
		expect(TeamAddress.local(v.localSwitchId, v.input).canonical).toBe(v.canonical);
	});

	it.each(vectors.sessionId.map((v) => [v.input, v] as const))("SessionId.parse(%s)", (_, v) => {
		const s = SessionId.parse(v.input, v.localSwitchId);
		expect(s).not.toBeNull();
		expect(s?.conversationId).toBe(v.conversationId);
		expect(s?.target.canonical).toBe(v.targetCanonical);
		expect(s?.key).toBe(v.key);
		// channel(...).key reproduces the parsed key (store-key == lookup-key).
		expect(SessionId.channel(v.conversationId, s!.target).key).toBe(v.key);
	});

	it.each(vectors.notice.map((v) => [v.input, v] as const))("NoticeId.parse(%s)", (_, v) => {
		const n = NoticeId.parse(v.input, v.localSwitchId);
		expect(n).not.toBeNull();
		expect(n?.sender.canonical).toBe(v.senderCanonical);
		expect(n?.key).toBe(v.key);
	});

	it.each(vectors.notSession.map((s) => [JSON.stringify(s), s] as const))("SessionId.parse rejects %s", (_, s) => {
		expect(SessionId.parse(s, "anyhost")).toBeNull();
	});

	it.each(vectors.notNotice.map((s) => [JSON.stringify(s), s] as const))("NoticeId.parse rejects %s", (_, s) => {
		expect(NoticeId.parse(s, "anyhost")).toBeNull();
	});

	it("remote() preserves an explicit host and equals a parsed qualified address", () => {
		const r = TeamAddress.remote("hostb", "api");
		expect(r.canonical).toBe("hostb/api");
		expect(r.equals(TeamAddress.parse("hostb/api", "hosta"))).toBe(true);
	});

	it("a cross-Switch key is byte-stable regardless of the parsing host", () => {
		const s = "conv:c:hostb/api";
		for (const localSwitchId of ["hosta", "hostb", "whatever"]) {
			expect(SessionId.parse(s, localSwitchId)?.key).toBe(s);
		}
	});

	it("a bare target resolves to the local host (not idempotent)", () => {
		expect(SessionId.parse("conv:c:api", "hosta")?.key).toBe("conv:c:hosta/api");
	});
});
