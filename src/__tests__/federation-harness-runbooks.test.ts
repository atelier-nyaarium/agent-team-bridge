import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ConsoleRunbookDeleteResultSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPutResultSchema,
	type Runbook,
} from "../shared/schemasRunbook.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("federation harness: runbooks", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	const book = (over: Partial<Runbook> = {}): Runbook => ({
		id: "release",
		name: "Release",
		body: "Cut a {{level}} release. Never hand-edit a version.",
		parameters: [{ name: "level", label: "Level", kind: "choice", options: ["patch", "minor"], default: "patch" }],
		revision: 1,
		...over,
	});

	const put = async (runbook: Runbook) =>
		ConsoleRunbookPutResultSchema.parse((await h.phone.value({ kind: "runbook_put", runbook })).result);
	const list = async () =>
		ConsoleRunbookListResultSchema.parse((await h.phone.value({ kind: "runbook_list" })).result);

	it("carries a runbook from the phone to the gateway's store and back", async () => {
		expect(await put(book())).toEqual({ stored: true, revision: 1 });

		const listed = await list();
		expect(listed.runbooks.map((runbook) => runbook.id)).toEqual(["release"]);
		expect(listed.runbooks[0]?.parameters[0]).toMatchObject({ kind: "choice", options: ["patch", "minor"] });

		const deleted = ConsoleRunbookDeleteResultSchema.parse(
			(await h.phone.value({ kind: "runbook_delete", runbookId: "release" })).result,
		);
		expect(deleted).toEqual({ deleted: true });
		expect((await list()).runbooks).toEqual([]);
	});

	it("refuses a body the gateway cannot fill, naming the parameter", async () => {
		const refused = await put(book({ id: "broken", body: "cut a {{tier}} release" }));
		expect(refused.stored).toBe(false);
		expect(refused.reason).toContain("tier");
		expect((await list()).runbooks.map((runbook) => runbook.id)).not.toContain("broken");
	});

	it("refuses a second device's edit that did not bump the revision", async () => {
		await put(book({ id: "deploy", revision: 3 }));
		const conflict = await put(book({ id: "deploy", revision: 3, name: "Deploy" }));
		expect(conflict).toMatchObject({ stored: false, revision: 3 });

		const held = (await list()).runbooks.find((runbook) => runbook.id === "deploy");
		expect(held?.name).toBe("Release");
	});
});
