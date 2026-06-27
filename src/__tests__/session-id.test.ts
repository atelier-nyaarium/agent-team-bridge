import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	composeSessionName,
	DEFAULT_SESSION,
	GATEWAY_QUALIFIER_SEP,
	isComposite,
	NoticeId,
	parseSessionName,
	SessionId,
	TeamAddress,
} from "../shared/session-id.js";

////////////////////////////////
//  Session identity vectors
//
//  vectors.json is read by BOTH this suite and SessionIdVectorsTest.kt, so the
//  hand-authored Kotlin twin cannot drift from the TS source: a canonical string
//  either side produces differently fails one of the two runtimes.

interface TeamVector {
	input: string;
	localGatewayId: string;
	gatewayId: string;
	name: string;
	canonical: string;
}
interface SessionVector {
	input: string;
	localGatewayId: string;
	conversationId: string;
	targetCanonical: string;
	key: string;
}
interface NoticeVector {
	input: string;
	localGatewayId: string;
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
		const a = TeamAddress.parse(v.input, v.localGatewayId);
		expect(a.gatewayId).toBe(v.gatewayId);
		expect(a.name).toBe(v.name);
		expect(a.canonical).toBe(v.canonical);
		// local() is the idempotent qualifier: same canonical for bare or qualified input.
		expect(TeamAddress.local(v.localGatewayId, v.input).canonical).toBe(v.canonical);
	});

	it.each(vectors.sessionId.map((v) => [v.input, v] as const))("SessionId.parse(%s)", (_, v) => {
		const s = SessionId.parse(v.input, v.localGatewayId);
		expect(s).not.toBeNull();
		expect(s?.conversationId).toBe(v.conversationId);
		expect(s?.target.canonical).toBe(v.targetCanonical);
		expect(s?.key).toBe(v.key);
		// channel(...).key reproduces the parsed key (store-key == lookup-key).
		expect(SessionId.channel(v.conversationId, s!.target).key).toBe(v.key);
	});

	it.each(vectors.notice.map((v) => [v.input, v] as const))("NoticeId.parse(%s)", (_, v) => {
		const n = NoticeId.parse(v.input, v.localGatewayId);
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

	it("a cross-Gateway key is byte-stable regardless of the parsing host", () => {
		const s = "conv:c:hostb/api";
		for (const localGatewayId of ["hosta", "hostb", "whatever"]) {
			expect(SessionId.parse(s, localGatewayId)?.key).toBe(s);
		}
	});

	it("a bare target resolves to the local host (not idempotent)", () => {
		expect(SessionId.parse("conv:c:api", "hosta")?.key).toBe("conv:c:hosta/api");
	});
});

describe("composite project.session grammar", () => {
	it("a composite survives gateway-qualification and parses back (separator != '/')", () => {
		const local = composeSessionName("recipe-app", "scratch");
		const addr = TeamAddress.parse(`gw1${GATEWAY_QUALIFIER_SEP}${local}`, "local-gw");
		expect(addr.gatewayId).toBe("gw1");
		expect(parseSessionName(addr.name)).toEqual({ project: "recipe-app", session: "scratch" });
	});

	it("a composite team rides a conv: session id and parses back (separator != ':')", () => {
		const team = `gw1${GATEWAY_QUALIFIER_SEP}${composeSessionName("recipe-app", "scratch")}`;
		const sid = SessionId.channel("conv-abc", TeamAddress.parse(team, "local-gw"));
		const back = SessionId.parse(sid.key, "local-gw");
		expect(back?.target.canonical).toBe(team);
		expect(parseSessionName(back!.target.name)).toEqual({ project: "recipe-app", session: "scratch" });
	});

	it("a bare name has no session and resolves to the default", () => {
		expect(parseSessionName("recipe-app")).toEqual({ project: "recipe-app", session: DEFAULT_SESSION });
	});

	it("a composite name splits into project and session", () => {
		expect(parseSessionName("recipe-app.scratch")).toEqual({ project: "recipe-app", session: "scratch" });
	});

	it("splits on the LAST separator so a dotted project name round-trips", () => {
		expect(composeSessionName("my.app", "foo")).toBe("my.app.foo");
		expect(parseSessionName("my.app.foo")).toEqual({ project: "my.app", session: "foo" });
	});

	it("is a mechanical split: a bare dotted name splits too (resolveTmuxTarget checks the catalog first)", () => {
		expect(parseSessionName("my.app")).toEqual({ project: "my", session: "app" });
	});

	it("compose then parse round-trips a dotless project", () => {
		expect(parseSessionName(composeSessionName("recipe-app", "scratch"))).toEqual({
			project: "recipe-app",
			session: "scratch",
		});
	});

	it("isComposite is true only when a session segment is present", () => {
		expect(isComposite("recipe-app")).toBe(false);
		expect(isComposite("recipe-app.scratch")).toBe(true);
		// Mechanical (separator-based); a dotted bare project reads composite, the catalog disambiguates upstream.
		expect(isComposite("my.app")).toBe(true);
	});
});
