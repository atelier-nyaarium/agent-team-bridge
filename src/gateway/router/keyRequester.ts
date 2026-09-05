import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { signKeyReceipt, signKeyRequest } from "../../shared/content-envelope.js";
import type { KeyReceipt, KeyRequest } from "../../shared/schemasContentKey.js";
import { WIRE_NONCE_BYTES } from "../../shared/wire-vocabulary.js";

const RETRY_MS = 10 * 60 * 1000;
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_EPOCHS_PER_REQUEST = 64;

export interface KeyRequesterDeps {
	domainId: string;
	gatewayId: string;
	gatewaySignPub: string;
	gatewaySignPriv: string;
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	onError: (message: string) => void;
	ambient: Pick<Ambient, "now" | "randomBytes" | "setTimer" | "clearTimer">;
}

export function createKeyRequester(deps: KeyRequesterDeps) {
	const now = () => deps.ambient.now();
	const random = (size: number) => deps.ambient.randomBytes(size);
	const setTimer = (handler: () => void, delay: number) => deps.ambient.setTimer(handler, delay);
	const clearTimer = (handle: TimerHandle) => deps.ambient.clearTimer(handle);
	const pending = new Map<number, number>();
	const reported = new Set<number>();
	let timer: TimerHandle | null = null;
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
		for (let offset = 0; offset < epochs.length; offset += MAX_EPOCHS_PER_REQUEST) {
			const batch = epochs.slice(offset, offset + MAX_EPOCHS_PER_REQUEST);
			const request: KeyRequest = signKeyRequest(
				{
					v: 1,
					domainId: deps.domainId,
					requesterSignPub: deps.gatewaySignPub,
					epochs: batch,
					at,
					nonce: random(WIRE_NONCE_BYTES).toString("base64"),
					signature: "",
				},
				deps.gatewaySignPriv,
			);
			try {
				await deps.send("key_request", { request });
				console.log(`[key-requester] requested epochs ${batch.join(",")}`);
			} catch {
				console.warn(`[key-requester] request send failed for epochs ${batch.join(",")}`);
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

	function stop(): void {
		if (timer === null) return;
		clearTimer(timer);
		timer = null;
		timerDelay = null;
	}

	async function sendReceipt(epoch: number): Promise<void> {
		const receipt: KeyReceipt = signKeyReceipt(
			{
				v: 1,
				domainId: deps.domainId,
				recipientSignPub: deps.gatewaySignPub,
				epoch,
				at: now(),
				nonce: random(WIRE_NONCE_BYTES).toString("base64"),
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

	return { request, installed, sendReceipt, resendReceipts, stop };
}
