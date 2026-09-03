import { describe, expect, it } from "vitest";
import { ownerKeyId } from "../shared/owner-id.js";
import { CONVERSATION, fakeDurable, makeConsoleSeam, OWNER_PUB } from "./helpers/consoleSeam.js";

describe("console conversation owners", () => {
	it("remembers a conversation's owner across a handler restart", async () => {
		const owners = fakeDurable();
		const first = makeConsoleSeam({ conversationOwners: owners });
		expect(first.handler.ownerOfConversation(CONVERSATION)).toBeUndefined();

		await first.dispatch({ kind: "list_dirs", path: "~/" });
		expect(first.handler.ownerOfConversation(CONVERSATION)).toBe(ownerKeyId(OWNER_PUB));

		const second = makeConsoleSeam({ conversationOwners: owners });
		expect(second.handler.ownerOfConversation(CONVERSATION)).toBe(ownerKeyId(OWNER_PUB));
		expect(second.handler.ownerOfConversation("someone-else")).toBeUndefined();
	});

	it("starts empty when the stored value has the wrong shape", () => {
		const owners = fakeDurable();
		owners.save(["not", "a", "record"]);
		const seam = makeConsoleSeam({ conversationOwners: owners });
		expect(seam.handler.ownerOfConversation(CONVERSATION)).toBeUndefined();
	});

	it("falls back to the Domain owner for a console the capability store knows", () => {
		const seam = makeConsoleSeam({
			capabilityStore: { report() {}, touch() {}, forget() {}, knows: (id) => id === "phone-uuid" },
			domain: () => ({ version: "v1", snapshot: { ownerSignPub: OWNER_PUB } as never }),
		});
		expect(seam.handler.ownerOfConversation("phone-uuid")).toBe(ownerKeyId(OWNER_PUB));
		expect(seam.handler.ownerOfConversation("stranger")).toBeUndefined();
	});
});
