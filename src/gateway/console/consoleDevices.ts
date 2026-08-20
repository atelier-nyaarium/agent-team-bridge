import { capFifo } from "../../shared/cap-fifo.js";
import { type ConsoleReplyBody, MAX_OPS_PER_CONVERSATION, type MailboxInput } from "../../shared/console-protocol.js";
import type { DeviceMailboxStore } from "../../shared/device-mailbox.js";
import { type ConversationRegistry, RESERVED_TEAM_NAMES, type TeamRegistry } from "../websocket.js";
import { ConsolePeer } from "./consolePeer.js";

////////////////////////////////
//  Interfaces & Types

export interface ConsoleDevicesDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	mailboxStore: DeviceMailboxStore;
	isProjectName?: (name: string) => boolean;
	// See ConsolePeer's own param doc; identity when absent (tests).
	qualifyFrom?: (from: string) => string;
	// See ConsolePeer's own param doc; no relay when absent (tests, single-gateway setups).
	fanOut?: (entry: Record<string, unknown>) => void;
}

export type ConsoleDevices = ReturnType<typeof createConsoleDevices>;

////////////////////////////////
//  Functions & Helpers

/** The device registry: every console install's peer, key binding, owner index and idempotency
 * cache. The dispatcher reaches all of it through the returned surface. */
export function createConsoleDevices({
	registry,
	conversationRegistry,
	mailboxStore,
	isProjectName,
	qualifyFrom,
	fanOut,
}: ConsoleDevicesDeps) {
	// The per-install conversationId is the device identity: it keys the registry sub, the
	// signing-key binding, the idempotency cache, and the device-name binding. The mailbox is
	// keyed by owner (below), so an owner's devices share one inbox while each keeps its own
	// registry slot and key binding.
	const bindings = new Map<string, string>();
	// conversationId -> the console signing key bound to that install. A frame whose signerSignPub
	// differs from the binding cannot operate this conversation, so a console cannot poll or settle
	// another install's mailbox by borrowing its conversationId. A register op may rebind.
	const signers = new Map<string, string>();
	// conversationId -> (opId -> in-flight/settled reply body) for mutating-op idempotency.
	const opCache = new Map<string, Map<string, Promise<ConsoleReplyBody>>>();
	// conversationId -> ownerId, and ownerId -> its device conversationIds. The mailbox store is
	// keyed by ownerId, so these map a device to its shared owner inbox and let teardown release
	// the inbox only when the owner's last device is gone.
	const deviceOwner = new Map<string, string>();
	const ownerDevices = new Map<string, Set<string>>();

	// When the store evicts an owner inbox (idle sweep or cap), tear down every device peer that
	// shared it. The box is already gone, so this only clears device-side state.
	mailboxStore.setOnEvict((ownerId) => {
		for (const conversationId of [...(ownerDevices.get(ownerId) ?? [])]) teardownDevice(conversationId);
	});

	function recordInbound(ownerId: string, sessionId: string): void {
		// The session id is the opaque store key the console echoes; under the fully-qualified
		// grammar there is no bare form to normalize. Recorded on the durable owner inbox so
		// respondability survives a restart.
		mailboxStore.get(ownerId)?.recordSession(sessionId);
	}

	/** Append only if the device is still live, so a late continuation cannot
	 * resurrect a torn-down install. Routes to the owner inbox the device shares;
	 * gated on device liveness, so a rename (same conversation) still delivers. */
	function appendIfLive(conversationId: string, entry: MailboxInput, dedupeKey?: string): void {
		const ownerId = deviceOwner.get(conversationId);
		if (!ownerId || !bindings.has(conversationId)) return;
		mailboxStore.get(ownerId)?.append(entry, dedupeKey);
	}

	function assertValidIdentity(device: string, conversationId: string): void {
		if (RESERVED_TEAM_NAMES.has(device)) {
			throw new Error(`"${device}" is a reserved name; pick another device name`);
		}
		if (isProjectName?.(device)) {
			throw new Error(`"${device}" is a project on the bridge; pick another device name`);
		}
		const bound = bindings.get(conversationId);
		if (bound && bound !== device) {
			throw new Error(`This install is bound to device name "${bound}"; send a register op to rename`);
		}
		const conversationHolder = conversationRegistry.get(conversationId);
		if (conversationHolder && !conversationHolder.data.virtual) {
			throw new Error(`conversationId is in use by a live bridge connection`);
		}
		const subs = registry.get(device);
		if (subs) {
			for (const [, ws] of subs) {
				if (!ws.data.virtual) {
					throw new Error(`"${device}" is an existing team name; pick another device name`);
				}
			}
		}
	}

	function ensurePeer(
		device: string,
		conversationId: string,
		signerSignPub: string,
		ownerId: string,
		allowRebind = false,
	): ConsolePeer {
		// A register op may rename the device: migrate the registry sub off the old name (the
		// owner inbox and binding carry over) before the identity checks see the stale binding.
		const bound = bindings.get(conversationId);
		if (allowRebind && bound && bound !== device) {
			const oldSubs = registry.get(bound);
			const oldSub = oldSubs?.get(conversationId);
			if (oldSub?.data.virtual) {
				oldSubs?.delete(conversationId);
				if (oldSubs?.size === 0) registry.delete(bound);
			}
			bindings.delete(conversationId);
		}

		// Cryptographic install binding: the conversation is owned by the first signing key seen
		// for it; a later frame with a different key is rejected unless this is a re-enrolling
		// register. Blocks a console from operating another install's mailbox by borrowing its
		// conversationId.
		const boundSigner = signers.get(conversationId);
		if (boundSigner && boundSigner !== signerSignPub && !allowRebind) {
			throw new Error(`conversationId is bound to a different device key`);
		}

		assertValidIdentity(device, conversationId);
		mailboxStore.ensure(ownerId);
		signers.set(conversationId, signerSignPub);
		deviceOwner.set(conversationId, ownerId);
		let siblings = ownerDevices.get(ownerId);
		if (!siblings) {
			siblings = new Set();
			ownerDevices.set(ownerId, siblings);
		}
		siblings.add(conversationId);

		let subs = registry.get(device);
		if (!subs) {
			subs = new Map();
			registry.set(device, subs);
		}

		const existing = subs.get(conversationId) as unknown as ConsolePeer | undefined;
		if (existing) {
			existing.data.isStale = false;
			// Self-heal the conversation pointer if a since-closed real socket displaced it.
			conversationRegistry.set(conversationId, existing.asWs());
			return existing;
		}

		const peer = new ConsolePeer(
			// While the device is live, re-create an evicted box so deliveries survive a store
			// sweep; once torn down, return undefined so a late push cannot resurrect an owner
			// inbox the index no longer tracks.
			() => (bindings.has(conversationId) ? mailboxStore.ensure(ownerId) : undefined),
			device,
			conversationId,
			conversationId,
			(sessionId) => recordInbound(ownerId, sessionId),
			qualifyFrom,
			fanOut,
		);
		subs.set(conversationId, peer.asWs());
		conversationRegistry.set(conversationId, peer.asWs());
		bindings.set(conversationId, device);
		return peer;
	}

	// Tear down a single device's peer state (registry sub, bindings, key, idempotency
	// cache, conversation pointer, owner index). Does NOT touch the shared owner inbox;
	// removePeer and the evict callback own the inbox lifecycle.
	function teardownDevice(conversationId: string): void {
		const device = bindings.get(conversationId);
		bindings.delete(conversationId);
		signers.delete(conversationId);
		opCache.delete(conversationId);

		const ownerId = deviceOwner.get(conversationId);
		deviceOwner.delete(conversationId);
		if (ownerId) {
			const siblings = ownerDevices.get(ownerId);
			siblings?.delete(conversationId);
			if (siblings && siblings.size === 0) ownerDevices.delete(ownerId);
		}

		const conversationWs = conversationRegistry.get(conversationId);
		if (conversationWs?.data.virtual) {
			conversationRegistry.delete(conversationId);
		}

		if (!device) return;
		const subs = registry.get(device);
		if (!subs) return;

		// Remove only this install's virtual sub; never evict a co-resident real team's sockets.
		// The team entry goes only when nothing remains.
		const sub = subs.get(conversationId);
		if (sub?.data.virtual) {
			subs.delete(conversationId);
		}
		if (subs.size === 0) {
			registry.delete(device);
		}
	}

	function removePeer(conversationId: string): void {
		const ownerId = deviceOwner.get(conversationId);
		teardownDevice(conversationId);
		if (ownerId) {
			// Release this device's watermark from the shared inbox, and delete the inbox only
			// once its last device is gone (teardownDevice drops the entry).
			mailboxStore.get(ownerId)?.forgetConsumer(conversationId);
			if (!ownerDevices.has(ownerId)) mailboxStore.delete(ownerId);
		}
	}

	function opCacheGet(conversationId: string, opId: string): Promise<ConsoleReplyBody> | undefined {
		return opCache.get(conversationId)?.get(opId);
	}

	function opCacheSet(conversationId: string, opId: string, promise: Promise<ConsoleReplyBody>): void {
		let perConv = opCache.get(conversationId);
		if (!perConv) {
			perConv = new Map();
			opCache.set(conversationId, perConv);
		}
		perConv.set(opId, promise);
		capFifo(perConv, MAX_OPS_PER_CONVERSATION);
	}

	function opCacheDelete(conversationId: string, opId: string): void {
		opCache.get(conversationId)?.delete(opId);
	}

	return {
		ensurePeer,
		removePeer,
		appendIfLive,
		opCacheGet,
		opCacheSet,
		opCacheDelete,
	};
}
