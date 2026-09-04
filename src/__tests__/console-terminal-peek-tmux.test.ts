import { describe, expect, it } from "vitest";
import { SessionStore } from "../shared/session-store.js";
import { makeConsoleSeam } from "./helpers/consoleSeam.js";

describe("console terminal operations through dispatch", () => {
	it("resolves project and host targets for peek", async () => {
		const h = makeConsoleSeam();
		await h.dispatch({ kind: "peek", target: "recipe-app" });
		await h.dispatch({ kind: "peek", target: "host.scratch" });
		expect(h.hostOps).toEqual([
			{ kind: "peek", target: { kind: "devcontainer", name: "recipe-app", sessionName: "claude" } },
			{ kind: "peek", target: { kind: "host", name: "host", sessionName: "scratch" } },
		]);
	});

	it("routes peek through the value handler", async () => {
		const h = makeConsoleSeam();
		const op = { kind: "peek" as const, target: "recipe-app" };

		await expect(h.handler.handleDelivery(op, "pixel", "conv-pixel", "peek-op", "owner-pub")).resolves.toEqual({
			ansi: "SCREEN",
			hash: "h1",
			kind: "tmux",
		});
		await expect(h.handler.handleValue(op, "pixel", "conv-pixel", "peek-op", "owner-pub")).resolves.toEqual({
			ansi: "SCREEN",
			hash: "h1",
			kind: "tmux",
		});
	});

	it("returns unchanged when the pane hash matches", async () => {
		const h = makeConsoleSeam();
		expect(await h.dispatch({ kind: "peek", target: "recipe-app", sinceHash: "h1" })).toEqual({
			hash: "h1",
			unchanged: true,
		});
	});

	it("returns container logs as text", async () => {
		const h = makeConsoleSeam({
			relayToHost: async () => ({
				ok: true,
				result: { kind: "container-logs", text: "booting", hash: "log1" },
			}),
		});
		expect(await h.dispatch({ kind: "peek", target: "recipe-app" })).toEqual({
			text: "booting",
			hash: "log1",
			kind: "container-logs",
		});
	});

	it("sends text or a whitelisted key with the resolved target", async () => {
		const h = makeConsoleSeam();
		await h.dispatch({ kind: "tmux_send", target: "recipe-app", text: "hello" });
		await h.dispatch({ kind: "tmux_send", target: "host", key: "C-c" });
		expect(h.hostOps).toMatchObject([
			{ kind: "sendText", text: "hello", submit: true },
			{ kind: "sendKey", key: "C-c" },
		]);
	});

	it("rejects invalid tmux input and invalid targets before host access", async () => {
		const h = makeConsoleSeam();
		await expect(h.dispatch({ kind: "tmux_send", target: "recipe-app" })).rejects.toThrow("exactly one");
		await expect(h.dispatch({ kind: "tmux_send", target: "recipe-app", text: "x", key: "Enter" })).rejects.toThrow(
			"exactly one",
		);
		await expect(h.dispatch({ kind: "tmux_send", target: "recipe-app", key: "rm -rf" })).rejects.toThrow(
			"disallowed",
		);
		await expect(h.dispatch({ kind: "peek", target: "recipe-app." })).rejects.toThrow();
		expect(h.hostOps).toHaveLength(0);
	});

	it("lists directories only for valid spawn paths", async () => {
		const h = makeConsoleSeam();
		expect(await h.dispatch({ kind: "list_dirs", path: "~/" })).toEqual({
			entries: [".config", "projects"],
		});
		await expect(h.dispatch({ kind: "list_dirs", path: "relative" })).rejects.toThrow("invalid path");
	});

	it("does not cache fresh reads under a repeated op id", async () => {
		const h = makeConsoleSeam();
		await h.dispatch({ kind: "peek", target: "recipe-app" }, "same");
		await h.dispatch({ kind: "peek", target: "recipe-app" }, "same");
		expect(h.hostOps).toHaveLength(2);
	});

	it("rejects loose and foreign terminal targets", async () => {
		const h = makeConsoleSeam();
		await expect(h.dispatch({ kind: "peek", target: "some-loose" })).rejects.toThrow();
		await expect(h.dispatch({ kind: "peek", target: "test-domain.other-gw.recipe-app.dev" })).rejects.toThrow();
		await expect(h.dispatch({ kind: "peek", target: "host.host-daemon" })).rejects.toThrow("reserved");
	});

	it("rejects terminal access to an alias-served record", async () => {
		const store = new SessionStore();
		store.adoptById("main", { spawn: "recipe-app" });
		store.confirm("recipe-app.main", { team: "recipe-app.other", subId: "s" });
		const h = makeConsoleSeam({ sessionStore: store });
		await expect(h.dispatch({ kind: "peek", target: "recipe-app.main" })).rejects.toThrow("user-launched");
		expect(h.hostOps).toHaveLength(0);
	});
});
