import { describe, expect, it } from "vitest";
import { frame, makeTerminalHarness } from "./helpers/console.js";

describe("console terminal ops (peek / tmux_send)", () => {
	it("peek resolves a devcontainer target and returns the captured pane + hash", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app" }, "p1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ ansi: "SCREEN", hash: "h1", kind: "tmux" });
		expect(h.hostOps[0]).toEqual({
			kind: "peek",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "claude" },
		});
	});

	it("peek resolves the 'host' machine target to its local tmux", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "peek", target: "host" }, "p2"));
		expect(h.hostOps[0]).toMatchObject({
			kind: "peek",
			target: { kind: "host", name: "host", sessionName: "claude" },
		});
	});

	it("peek with a matching sinceHash returns unchanged and drops the body", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app", sinceHash: "h1" }, "p3"));
		expect(reply.result).toEqual({ hash: "h1", unchanged: true });
	});

	it("peek carries a container-logs frame through as text + kind (pre-pane fallback)", async () => {
		const h = makeTerminalHarness(undefined, () => ({
			ok: true,
			result: { kind: "container-logs", text: "postCreate: installing deps", hash: "hlog" },
		}));
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app" }, "plog"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toMatchObject({ hash: "hlog", kind: "container-logs" });
		expect(reply.result).toHaveProperty("text");
	});

	it("rejects a loose session name (only the host target + devcontainers are terminal-eligible)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "some-loose" }, "p4"));
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("an 'absent' peek error renders the calm not-running message; a 'failure' passes through raw", async () => {
		const absent = makeTerminalHarness(undefined, () => ({
			ok: false,
			error: "no server running",
			errorKind: "absent",
		}));
		const r1 = await absent.handler.handleFrame(frame({ kind: "peek", target: "recipe-app" }, "pe1"));
		expect(r1.ok).toBe(false);

		const failure = makeTerminalHarness(undefined, () => ({
			ok: false,
			error: "tmux command timed out",
			errorKind: "failure",
		}));
		const r2 = await failure.handler.handleFrame(frame({ kind: "peek", target: "recipe-app" }, "pe2"));
		expect(r2.ok).toBe(false);
	});

	it("rejects a cross-Gateway target", async () => {
		const h = makeTerminalHarness();
		// A fully-qualified address whose gateway segment is not the local Gateway.
		const reply = await h.handler.handleFrame(
			frame({ kind: "peek", target: "test-domain.other-gw.recipe-app.dev" }, "p5"),
		);
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a reserved host session name (the daemon's own supervisor pane)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "host.host-daemon" }, "p6"));
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("tmux_send with text relays sendText", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "tmux_send", target: "recipe-app", text: "/model opus" }, "s1"),
		);
		expect(reply.result).toEqual({ sent: true });
		// dedupKey = `${conversationId}:${opId}` so the host can replay a re-relayed send.
		expect(h.hostOps[0]).toEqual({
			kind: "sendText",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "claude" },
			text: "/model opus",
			submit: true,
			dedupKey: "conv-pixel:s1",
		});
	});

	it("tmux_send with a named key relays sendKey", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "tmux_send", target: "host", key: "C-c" }, "s2"));
		expect(h.hostOps[0]).toEqual({
			kind: "sendKey",
			target: { kind: "host", name: "host", sessionName: "claude" },
			key: "C-c",
			dedupKey: "conv-pixel:s2",
		});
	});

	it("a retried tmux_send with the same opId relays once (idempotent)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "tmux_send", target: "recipe-app", key: "Enter" }, "dup");
		const [r1, r2] = await Promise.all([h.handler.handleFrame(f), h.handler.handleFrame(f)]);
		const r3 = await h.handler.handleFrame(f);
		expect(r1.ok && r2.ok && r3.ok).toBe(true);
		expect(h.hostOps).toHaveLength(1);
	});

	it("peek is a fresh read: a retried opId relays again (not idempotency-cached)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "peek", target: "recipe-app" }, "samepeek");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		expect(h.hostOps).toHaveLength(2);
	});

	it("rejects a tmux_send with neither text nor key (no stray keystroke)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "tmux_send", target: "recipe-app" }, "n1"));
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a tmux_send with both text and key", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "tmux_send", target: "recipe-app", text: "x", key: "Enter" }, "b1"),
		);
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a key not on the whitelist at the gateway (fail fast, no host round-trip)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "tmux_send", target: "recipe-app", key: "rm -rf" }, "k1"),
		);
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("list_dirs relays a listDirs host op and returns the entries", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "list_dirs", path: "~/" }, "ld1"));
		expect(reply.ok).toBe(true);
		expect(reply.result).toEqual({ entries: [".config", "projects"] });
		expect(h.hostOps[0]).toEqual({ kind: "listDirs", path: "~/" });
	});

	it("list_dirs rejects a non-path shape at the gateway (no host round-trip)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "list_dirs", path: "not-rooted" }, "ld2"));
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("list_dirs is a fresh read: a retried opId relays again (not idempotency-cached)", async () => {
		const h = makeTerminalHarness();
		const f = frame({ kind: "list_dirs", path: "/data" }, "ldsame");
		await h.handler.handleFrame(f);
		await h.handler.handleFrame(f);
		expect(h.hostOps).toHaveLength(2);
	});

	it("reload_plugins relays a reloadPlugins host op for the resolved session", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "reload_plugins", target: "recipe-app" }, "r1"));
		expect(reply.result).toEqual({ initiated: true });
		expect(h.hostOps[0]).toEqual({
			kind: "reloadPlugins",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "claude" },
			dedupKey: "conv-pixel:r1",
		});
	});

	it("rejects create_session / reload_plugins for a loose session", async () => {
		const h = makeTerminalHarness();
		const a = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "some-loose", sessionName: "x" }, "c2"),
		);
		const b = await h.handler.handleFrame(frame({ kind: "reload_plugins", target: "some-loose" }, "r2"));
		expect(a.ok).toBe(false);
		expect(b.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("peek resolves a composite project.session target to its session pane", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app.scratch" }, "pc1"));
		expect(h.hostOps[0]).toMatchObject({
			kind: "peek",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "scratch" },
		});
	});

	it("tmux_send targets the named session of a composite address", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "tmux_send", target: "recipe-app.scratch", text: "hi" }, "sc1"));
		expect(h.hostOps[0]).toMatchObject({
			kind: "sendText",
			target: { kind: "devcontainer", name: "recipe-app", sessionName: "scratch" },
		});
	});

	it("peek resolves host.session to the host machine's named session", async () => {
		const h = makeTerminalHarness();
		await h.handler.handleFrame(frame({ kind: "peek", target: "host.scratch" }, "ph1"));
		expect(h.hostOps[0]).toMatchObject({
			kind: "peek",
			target: { kind: "host", name: "host", sessionName: "scratch" },
		});
	});

	it("rejects a trailing-separator target (empty session) cleanly, before any host op", async () => {
		const h = makeTerminalHarness();
		// A trailing dot yields an empty trailing segment that fails the slug check at
		// Address construction (inside parseTarget), before any host op.
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app." }, "pe1"));
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects a session segment with illegal characters", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(frame({ kind: "peek", target: "recipe-app.Bad_Name" }, "pe2"));
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects an oversized session name", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "peek", target: `recipe-app.${"x".repeat(65)}` }, "pe3"),
		);
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});

	it("rejects create_session with an invalid explicit session name (a dot would break the composite)", async () => {
		const h = makeTerminalHarness();
		const reply = await h.handler.handleFrame(
			frame({ kind: "create_session", target: "recipe-app", sessionName: "bad.name" }, "ce1"),
		);
		expect(reply.ok).toBe(false);
		expect(h.hostOps).toHaveLength(0);
	});
});
