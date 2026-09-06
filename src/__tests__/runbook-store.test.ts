import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunbookStore } from "../gateway/runbooks/store.js";
import { openDurable } from "../shared/durable-store.js";
import { RUNBOOKS_MAX, type Runbook } from "../shared/schemasRunbook.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-store-"));
	roots.push(root);
	return root;
};
const open = (dataDir: string) => openDurable(dataDir, "runbooks", (store) => createRunbookStore({ store }));

const book = (id: string, over: Partial<Runbook> = {}): Runbook => ({
	id,
	name: id,
	body: "release {{level}}",
	parameters: [{ name: "level", label: "Level", kind: "text" }],
	revision: 1,
	...over,
});

describe("runbook store", () => {
	it("holds what the phone pushed and gives it back across a reopen", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		expect(store.put(book("deploy"))).toEqual({ stored: true, revision: 1 });
		expect(store.get("deploy")?.body).toBe("release {{level}}");
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["deploy"]);
	});

	it("orders by name, then by id so a shared name still gives one order", () => {
		const store = open(fresh());
		store.put(book("b", { name: "Zebra" }));
		store.put(book("a", { name: "Apple" }));
		store.put(book("c", { name: "Apple" }));
		expect(store.list().map((r) => r.id)).toEqual(["a", "c", "b"]);
	});

	it("takes a newer revision and refuses an older one", () => {
		const store = open(fresh());
		store.put(book("deploy", { revision: 5, body: "five {{level}}" }));
		expect(store.put(book("deploy", { revision: 6, body: "six {{level}}" })).stored).toBe(true);
		expect(store.get("deploy")?.body).toBe("six {{level}}");

		const stale = store.put(book("deploy", { revision: 5, body: "five {{level}}" }));
		expect(stale.stored).toBe(false);
		// A refused put says what to rebase on.
		expect(stale.revision).toBe(6);
		expect(store.get("deploy")?.body).toBe("six {{level}}");
	});

	it("takes an unchanged re-push but refuses a changed one at the same revision", () => {
		const store = open(fresh());
		store.put(book("deploy", { revision: 6, body: "six {{level}}" }));
		expect(store.put(book("deploy", { revision: 6, body: "six {{level}}" })).stored).toBe(true);

		// A second device editing without bumping would otherwise overwrite the first silently.
		const conflict = store.put(book("deploy", { revision: 6, body: "other {{level}}" }));
		expect(conflict.stored).toBe(false);
		expect(conflict.revision).toBe(6);
		expect(store.get("deploy")?.body).toBe("six {{level}}");
	});

	it("refuses a record whose body and parameters disagree, leaving the held one alone", () => {
		const store = open(fresh());
		store.put(book("deploy"));
		const refused = store.put(book("deploy", { revision: 2, body: "no placeholders here" }));
		expect(refused.stored).toBe(false);
		expect(refused.reason).toBeTruthy();
		expect(store.get("deploy")?.revision).toBe(1);
	});

	it("caps how many a gateway holds, but never refuses replacing one it has", () => {
		const store = open(fresh());
		for (let i = 0; i < RUNBOOKS_MAX; i++) expect(store.put(book(`r${i}`)).stored).toBe(true);
		expect(store.put(book("one-too-many")).stored).toBe(false);
		expect(store.put(book("r0", { revision: 2 })).stored).toBe(true);
	});

	it("deletes once, and says so only the first time", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		store.put(book("deploy"));
		expect(store.remove("deploy")).toEqual({ deleted: true });
		expect(store.remove("deploy")).toEqual({ deleted: false });
		expect(open(dataDir).list()).toEqual([]);
	});

	it("refuses to hand a caller the record it holds to edit", () => {
		const store = open(fresh());
		store.put(book("deploy"));
		const listed = store.list()[0] as Runbook;
		expect(() => {
			(listed as { body: string }).body = "tampered";
		}).toThrow();
		expect(store.get("deploy")?.body).toBe("release {{level}}");
	});

	it("keeps a held record a later rule would refuse, rather than erasing the owner's work", () => {
		const dataDir = fresh();
		const stale = { ...book("stale"), body: "no placeholders here" };
		fs.writeFileSync(path.join(dataDir, "runbooks.json"), JSON.stringify([stale, book("good")]));
		const store = open(dataDir);
		expect(store.list().map((r) => r.id)).toEqual(["good", "stale"]);

		// A write of its neighbour must not take it off disk.
		store.put(book("good", { revision: 2 }));
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["good", "stale"]);
	});

	it("starts fresh when the file on disk no longer validates, and heals on the next write", () => {
		const dataDir = fresh();
		fs.writeFileSync(path.join(dataDir, "runbooks.json"), JSON.stringify([{ id: "deploy" }]));
		const store = open(dataDir);
		expect(store.list()).toEqual([]);
		expect(store.put(book("deploy")).stored).toBe(true);
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["deploy"]);
	});
});
