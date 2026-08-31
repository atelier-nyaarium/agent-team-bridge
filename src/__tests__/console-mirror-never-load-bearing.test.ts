import { describe, expect, it } from "vitest";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import type { DeviceMailbox, DeviceMailboxStore } from "../shared/device-mailbox.js";
import { type Address, parseTarget } from "../shared/session-id.js";

/** Every caller mirrors AFTER its primary delivery, so a throw here would report a spurious failure
 * for a message that already landed, and the caller's retry would duplicate it. deliverToOwner
 * already guards append(); these cover the resolution around it, which it does not. */
describe("mirrorPeer is never load-bearing", () => {
	const parsed = parseTarget("alice.hosta.spawn.session", "alice", "hosta");
	if (!("session" in parsed)) throw new Error("fixture must parse to a full address");
	const threadAddr: Address = parsed;

	function opsWith(mailboxStore: Partial<DeviceMailboxStore>) {
		return createConsolePushOps({
			mailboxStore: mailboxStore as DeviceMailboxStore,
			ownerId: () => "owner-1",
			localGatewayId: "hosta",
			localAddress: () => threadAddr,
			refuseImpersonation: () => null,
			relayWithRetry: async () => ({ ok: true }),
		});
	}

	it("mirrors normally when the mailbox resolves", () => {
		const appended: unknown[] = [];
		const { mirrorPeer } = opsWith({
			ensure: () => ({ append: (entry: unknown) => void appended.push(entry) }) as unknown as DeviceMailbox,
		});

		mirrorPeer(threadAddr, "a", "b", { body: "hi" });

		// Proves the swallow test below exercises a real path rather than an early return.
		expect(appended).toHaveLength(1);
	});

	it("swallows a throwing mailbox resolution instead of failing its caller", () => {
		const { mirrorPeer } = opsWith({
			ensure: () => {
				throw new Error("mailbox store exploded");
			},
		});

		expect(() => mirrorPeer(threadAddr, "a", "b", { body: "hi" })).not.toThrow();
	});
});
