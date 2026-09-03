import { randomBytes } from "node:crypto";
import { signKeyReceipt, signKeyRequest } from "../../shared/content-envelope.js";
import type { KeyReceipt, KeyRequest } from "../../shared/schemasContentKey.js";

const RETRY_MS = 10 * 60 * 1000;
const LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface KeyRequesterDeps {
	domainId: string;
	gatewayId: string;
	gatewaySignPub: string;
	gatewaySignPriv: string;
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	onError: (message: string) => void;
	now?: () => number;
	setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout> | number;
	clearTimeout?: (timer: ReturnType<typeof setTimeout> | number) => void;
}

export function createKeyRequester(deps: KeyRequesterDeps) {
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimeout ?? setTimeout;
	const clearTimer = deps.clearTimeout ?? clearTimeout;
	const pending = new Map<number, number>();
	const reported = new Set<number>();
	let timer: ReturnType<typeof setTimeout> | number | null = null;
	let timerDelay: number | null = null;
	let sending = false;
	let dirty = false;

	function arm(delay: number): void {
		if (timer !== null || pending.size === 0) return;
		const scheduled = setTimer(() => {
			timer = null;
			timerDelay = null;
			void send();
		}, delay);
		timer = scheduled;
		timerDelay = delay;
		if (typeof scheduled !== "number") scheduled.unref?.();
	}

	function armImmediate(): void {
		if (timerDelay === 0 || sending) return;
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
			timerDelay = null;
		}
		arm(0);
	}

	async function send(): Promise<void> {
		sending = true;
		const at = now();
		const epochs = [...pending.entries()]
			.filter(([, first]) => at - first < LIFETIME_MS)
			.map(([epoch]) => epoch)
			.sort((a, b) => a - b);
		for (const [epoch, first] of pending) {
			if (at - first >= LIFETIME_MS) {
				pending.delete(epoch);
				if (!reported.has(epoch)) {
					reported.add(epoch);
					deps.onError(`Gateway ${deps.gatewayId} could not obtain content key epoch ${epoch}`);
				}
			}
		}
		if (epochs.length > 0) {
			const request: KeyRequest = signKeyRequest(
				{
					v: 1,
					domainId: deps.domainId,
					requesterSignPub: deps.gatewaySignPub,
					epochs,
					at,
					nonce: randomBytes(18).toString("base64"),
					signature: "",
				},
				deps.gatewaySignPriv,
			);
			try {
				await deps.send("key_request", { request });
			} catch {
				console.warn(`[key-requester] request send failed for epochs ${epochs.join(",")}`);
			}
		}
		sending = false;
		if (dirty) {
			dirty = false;
			armImmediate();
		} else {
			arm(RETRY_MS);
		}
	}

	function request(epoch: number): void {
		if (pending.has(epoch)) return;
		pending.set(epoch, now());
		if (sending) dirty = true;
		else armImmediate();
	}

	function installed(epoch: number): void {
		pending.delete(epoch);
		if (pending.size === 0 && timer !== null) {
			clearTimer(timer);
			timer = null;
			timerDelay = null;
		}
	}

	async function sendReceipt(epoch: number): Promise<void> {
		const receipt: KeyReceipt = signKeyReceipt(
			{
				v: 1,
				domainId: deps.domainId,
				recipientSignPub: deps.gatewaySignPub,
				epoch,
				at: now(),
				nonce: randomBytes(18).toString("base64"),
				signature: "",
			},
			deps.gatewaySignPriv,
		);
		await deps.send("key_receipt", { receipt });
	}

	async function resendReceipts(epochs: number[]): Promise<void> {
		for (const epoch of epochs) {
			try {
				await sendReceipt(epoch);
			} catch (error) {
				console.warn(
					`[key-requester] receipt send failed for epoch ${epoch}: ${error instanceof Error ? error.message : error}`,
				);
			}
		}
	}

	return { request, installed, sendReceipt, resendReceipts };
}
