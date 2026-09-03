import { describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_FILE_BYTES } from "../gateway/routes.js";
import { makePushRoutes } from "./helpers/consoleDelivery.js";

describe("phone-bound console delivery", () => {
	it("appends a human notice with qualified sender metadata", async () => {
		const h = makePushRoutes();
		const response = h.routes.humanNotify(new Request("http://gateway/human/notify"), {
			from: "recipe-app",
			title: "cycle done",
			summary: "s",
			full: "body",
			fullSpoken: "spoken",
		});
		expect(response.status).toBe(200);
		await vi.waitFor(() => expect(h.calls.some((call) => call.action === "inbox_append")).toBe(true));
		const append = h.calls.find((call) => call.action === "inbox_append");
		expect(append?.params).toMatchObject({
			address: expect.stringContaining("owner:alice/"),
			row: { envelope: { kind: "notice", origin: { kind: "gateway", gatewayId: "hosta" } } },
		});
	});

	it("rejects malformed notices and oversized attachments before appending", () => {
		const h = makePushRoutes();
		expect(
			h.routes.humanNotify(new Request("http://gateway/human/notify"), { from: "recipe-app", title: "missing" })
				.status,
		).toBe(400);
		expect(
			h.routes.humanNotify(new Request("http://gateway/human/notify"), {
				from: "recipe-app",
				title: "big",
				summary: "s",
				full: "body",
				files: [
					{
						filename: "big.bin",
						mime: "application/octet-stream",
						size: MAX_RESPONSE_FILE_BYTES + 1,
						descriptiveKey: "big.bin",
						role: "attachment",
					},
				],
			}).status,
		).toBe(413);
		expect(h.calls.filter((call) => call.action === "inbox_append")).toHaveLength(0);
	});

	it("appends a plugin action under the caller's own thread", async () => {
		const h = makePushRoutes();
		const response = h.routes.pluginAction(new Request("http://gateway/plugin-action"), {
			from: "recipe-app",
			pluginId: "designer",
			actionType: "delete-card",
			payload: { fileName: "x.html" },
		});
		expect(response.status).toBe(200);
		await vi.waitFor(() => expect(h.calls.some((call) => call.action === "inbox_append")).toBe(true));
		const append = h.calls.find((call) => call.action === "inbox_append");
		expect(append?.params).toMatchObject({ row: { envelope: { kind: "plugin_action" } } });
	});
});
