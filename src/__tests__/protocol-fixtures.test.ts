import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	MailboxEntrySchema,
	PhoneListTeamsResultSchema,
	PhonePollResultSchema,
	PhoneRegisterResultSchema,
	PhoneRelayFrameSchema,
	PhoneRelayReplySchema,
	PhoneSendResultSchema,
} from "../shared/schemas.js";

////////////////////////////////
//  Golden protocol fixtures
//
//  The same files are decoded by the Android unit tests (wired as test
//  resources in app/build.gradle.kts), so a wire-shape change that breaks
//  either side fails a suite instead of shipping. Fixture intent:
//  - frame-*.json: every op kind through PhoneRelayFrameSchema.
//  - mailbox-*.json: every entry kind, incl. an `at` above 2^31 (Long bait)
//    and a live out-of-union request_type ("handoff").
//  - tolerance-extra-field.json: unknown fields must PASS (additive rule).
//  - invalid-missing-required.json: must FAIL both sides.

const FIXTURES = path.join(__dirname, "../../tests/fixtures/protocol");

function fixture(name: string): unknown {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

describe("protocol fixtures", () => {
	it.each([
		"frame-register.json",
		"frame-list-teams.json",
		"frame-send.json",
		"frame-respond.json",
		"frame-poll.json",
	])("%s parses as a relay frame", (name) => {
		expect(PhoneRelayFrameSchema.safeParse(fixture(name)).success).toBe(true);
	});

	it.each([
		"mailbox-message.json",
		"mailbox-reply.json",
		"mailbox-notice.json",
		"mailbox-handoff.json",
		"mailbox-reply-files.json",
	])("%s parses as a mailbox entry", (name) => {
		expect(MailboxEntrySchema.safeParse(fixture(name)).success).toBe(true);
	});

	it("keeps the at field above 2^31 (Long bait for the Kotlin side)", () => {
		const entry = MailboxEntrySchema.parse(fixture("mailbox-message.json"));
		expect(entry.at).toBeGreaterThan(2 ** 31);
	});

	it("tolerates unknown extra fields (additive rule)", () => {
		const result = MailboxEntrySchema.safeParse(fixture("tolerance-extra-field.json"));
		expect(result.success).toBe(true);
		// zod plain objects strip unknown keys; the field must not survive.
		expect(result.data).not.toHaveProperty("field_from_the_future");
	});

	it("rejects a missing required field", () => {
		expect(MailboxEntrySchema.safeParse(fixture("invalid-missing-required.json")).success).toBe(false);
	});

	it("poll-result.json parses as a poll result", () => {
		expect(PhonePollResultSchema.safeParse(fixture("poll-result.json")).success).toBe(true);
	});

	it("relay-reply.json parses as a relay reply", () => {
		expect(PhoneRelayReplySchema.safeParse(fixture("relay-reply.json")).success).toBe(true);
	});

	it("relay-reply-error.json parses as a failed relay reply", () => {
		const reply = PhoneRelayReplySchema.parse(fixture("relay-reply-error.json"));
		expect(reply.ok).toBe(false);
		expect(reply.error).toBeTruthy();
	});

	it("register-result.json and send-result.json parse as op results", () => {
		expect(PhoneRegisterResultSchema.safeParse(fixture("register-result.json")).success).toBe(true);
		expect(PhoneSendResultSchema.safeParse(fixture("send-result.json")).success).toBe(true);
	});

	it("list-teams-result.json tolerates an old-arbiter team without kind", () => {
		const result = PhoneListTeamsResultSchema.parse(fixture("list-teams-result.json"));
		expect(result.teams).toHaveLength(2);
		expect(result.teams[0].kind).toBe("devcontainer");
		expect(result.teams[1].kind).toBeUndefined();
	});
});
