import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayBridge } from "../federation-server/gatewayBridge.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { createScheduledService } from "../federation-server/scheduled/scheduledService.js";
import { createShareService } from "../federation-server/share/shareService.js";
import { signAdmission, signRegister } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { type InboxRow, signRowEnvelope } from "../shared/schemasInbox.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sources(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function socket() {
	const sent: Record<string, unknown>[] = [];
	return {
		sent,
		readyState: 1,
		on: () => undefined,
		send: (value: string) => sent.push(JSON.parse(value)),
		close: () => undefined,
	};
}

describe("Router owner state residue", () => {
	// The Router stores ciphertext and never accesses content keys.
	it("federation-server imports no content-key symbol", () => {
		const offenders = sources(path.join(REPO_ROOT, "src", "federation-server")).filter((file) =>
			file.endsWith("keyDeliveryService.ts")
				? false
				: /from\s+["'][^"']*(content-envelope|contentKeyStore|schemasContentKey)\.js["']/.test(
						fs.readFileSync(file, "utf8").replace(/import type[^;]*;/g, ""),
					),
		);
		expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
	});

	it("refuses a peer row after unshare at the bridge and retires the one already held", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-residue-"));
		roots.push(dataDir);
		const owners = new Map([
			["home", generateIdentity()],
			["friend", generateIdentity()],
		]);
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (domainId) => owners.get(domainId)?.sign.pub ?? null,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			now: () => 100,
		});
		const router = generateIdentity();
		const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const share = createShareService({
			registry,
			isLinked: () => true,
			dropLinkEdge: () => undefined,
			retireRevokedPeerRows: (d, t, f) => inbox.retireRevokedPeerRows(d, t, f),
			connectedGateways: () => [],
			now: () => 100,
		});
		const gate = (dst: string, target: string, src: string) => share.admitPeerRow(dst, target, src);
		inbox.setPeerGate(gate);
		const gateway = generateIdentity();
		const admission = signAdmission(
			{
				kind: "gateway",
				signPub: gateway.sign.pub,
				boxPub: gateway.box.pub,
				gatewayId: "fgw",
				issuedAt: 1,
				nonce: "n",
			},
			(owners.get("friend") as ReturnType<typeof generateIdentity>).sign.priv,
			(owners.get("friend") as ReturnType<typeof generateIdentity>).sign.pub,
		);
		const bridge = new GatewayBridge({
			port: 0,
			authToken: "token",
			getDomain: (domainId) => ({
				ownerSignPub: (owners.get(domainId) as ReturnType<typeof generateIdentity>).sign.pub,
				admissions: domainId === "friend" ? [admission] : [],
				revocations: [],
			}),
			getDomainMeta: () => null,
			hasLinkEdge: () => true,
			adminDomainId: () => "home",
			inbox,
		});
		bridge.setPeerRowGate(gate);
		bridge.attach();
		bridge.transportAdapter?.handleOpen(socket() as never);
		const proofAt = Date.now();
		await bridge.handleCall("c1", "gateway_register", {
			domainId: "friend",
			gatewayId: "fgw",
			protocolVersion: 1,
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			admission: JSON.stringify(admission),
			proofAt,
			proofNonce: "proof",
			proof: signRegister("fgw", proofAt, "proof", gateway.sign.priv),
		});
		// The registration is the only identity a frame handler ever sees.
		const seen: Array<{ reg: unknown; params: unknown }> = [];
		bridge.registerGatewayFrame("probe", (reg, params) => {
			seen.push({ reg, params });
			return { ok: true };
		});
		await bridge.handleCall("c1", "probe", { incarnation: 1, domainId: "home", gatewayId: "hgw", note: "x" });
		expect(seen[0]).toMatchObject({ reg: { domainId: "friend", gatewayId: "fgw" }, params: { note: "x" } });
		expect(seen[0]?.params).not.toHaveProperty("domainId");
		inbox.upsertSession("home", "hgw", "proj.main", { kind: "shell", label: "x", recordExists: true });
		share.share("home", "home.hgw.proj.main", { kind: "domain", domainId: "friend" });
		const peerRow = (opId: string) => {
			const envelope = {
				origin: { kind: "gateway" as const, domainId: "friend", gatewayId: "fgw" },
				opKey: { conversationId: "c", opId },
				epoch: "peer" as const,
				kind: "message" as const,
				contentRefs: [],
			};
			return {
				envelope,
				producerSig: signRowEnvelope(envelope, gateway.sign.priv),
				body: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
			};
		};
		const address = "session:home/hgw/proj.main";
		expect(
			await bridge.handleCall("c1", "inbox_append", { address, row: peerRow("one"), incarnation: 1 }),
		).toMatchObject({
			outcome: "accepted",
		});
		expect(inbox.pendingFor("home", "hgw")).toHaveLength(1);
		share.unshare("home", "home.hgw.proj.main", { kind: "domain", domainId: "friend" });
		expect(inbox.pendingFor("home", "hgw")).toEqual([]);
		expect(inbox.opResult("home", { conversationId: "c", opId: "one" })).toMatchObject({
			outcome: "target_revoked",
		});
		expect(
			await bridge.handleCall("c1", "inbox_append", { address, row: peerRow("two"), incarnation: 1 }),
		).toMatchObject({
			ok: false,
		});
		registry.close();
	});

	// Result and message rows use distinct per-owner keys.
	it("fires a scheduled send through the real ledger: one session row, pending and sent results", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-residue-"));
		roots.push(dataDir);
		const owner = generateIdentity();
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: () => owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			now: () => 100,
		});
		const router = generateIdentity();
		const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const timers: Array<() => void> = [];
		const scheduled = createScheduledService({
			registry,
			inbox,
			appendScheduledMessage: (domainId, address, opKey, body, contentRefs) => {
				const envelope = {
					origin: { kind: "router" as const, domainId },
					opKey,
					epoch: body.epoch,
					kind: "message" as const,
					contentRefs,
				};
				return inbox.appendRow({
					address,
					row: { envelope, producerSig: signRowEnvelope(envelope, router.sign.priv), body },
					producerSignPub: router.sign.pub,
				});
			},
			referenceHeld: { has: () => true, hold: () => undefined, release: () => undefined },
			scheduler: { set: (_ms, fn) => timers.push(fn) - 1, clear: () => undefined },
			now: () => 100,
		});
		const target = { domainId: "home", gatewayId: "hgw", sessionId: "proj.main" };
		const body = { v: 1 as const, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" };
		expect(
			scheduled.schedule(
				"home",
				{ conversationId: "conv", device: "phone", opId: "op" },
				{ kind: "schedule_send", target, fireAt: 200, opId: "send-1", files: [], body },
			),
		).toMatchObject({ outcome: "accepted" });
		timers[0]?.();
		const sessionRows = inbox.rows({ kind: "session", ...target }, 1, 10);
		expect(sessionRows).toHaveLength(1);
		expect(sessionRows[0]?.envelope.opKey).toEqual({ conversationId: "conv", opId: "send-1" });
		const ownerRows = inbox.rows({ kind: "owner", domainId: "home", ownerSignPub: owner.sign.pub }, 1, 10);
		expect(ownerRows.map((row: InboxRow) => (row.body as { outcome: string }).outcome)).toEqual([
			"pending",
			"sent",
		]);
		expect(scheduled.list("home")[0]).toMatchObject({ state: "fired", attempts: 1 });
		registry.close();
	});
});
