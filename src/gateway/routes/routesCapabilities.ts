import type { Ambient } from "../../shared/ambient.js";
import { UNREPORTED_CAPABILITIES } from "../../shared/capabilities.js";
import { CapabilitySnapshotSchema } from "../../shared/schemasCapability.js";
import { jsonResponse } from "../routeSchemas.js";

/** Bounds the remote wait below the caller's timeout. */
const CAPABILITIES_ROUTER_DEADLINE_MS = 1_000;

type DeadlineTimers = Pick<Ambient, "setTimer" | "clearTimer">;

/** Returns the remote answer or fallback. */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T, ambient: DeadlineTimers): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = ambient.setTimer(() => resolve(fallback), ms);
		void work.then(
			(value) => {
				ambient.clearTimer(timer);
				resolve(value);
			},
			() => {
				ambient.clearTimer(timer);
				resolve(fallback);
			},
		);
	});
}

export interface CapabilityRoutesDeps {
	capabilityStore?: Pick<import("../console/capabilityStore.js").CapabilityStore, "snapshot">;
	daemonCapabilityStore?: Pick<import("../daemonCapabilities.js").DaemonCapabilityStore, "snapshot">;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "isRegistered" | "callInboxTool"> | null;
	ambient: DeadlineTimers;
}

export function createCapabilityRoutes({
	capabilityStore,
	daemonCapabilityStore,
	routerClient,
	ambient,
}: CapabilityRoutesDeps) {
	/** Ungated on purpose: non-secret ids, and the host window carries no credential to present. */
	async function capabilities(): Promise<Response> {
		// The console and daemon folds stay apart: only the caller knows what it already holds.
		let consoleSnapshot = capabilityStore?.snapshot() ?? UNREPORTED_CAPABILITIES;
		if (routerClient?.isRegistered()) {
			const result = await withDeadline(
				routerClient.callInboxTool("capabilities_read", { kind: "capabilities_read" }),
				CAPABILITIES_ROUTER_DEADLINE_MS,
				{ callId: "", error: "Router did not answer in time" },
				ambient,
			);
			const parsed = CapabilitySnapshotSchema.safeParse(result.result);
			// Unknown snapshots do not displace local capabilities.
			if (!result.error && parsed.success && parsed.data.known) consoleSnapshot = parsed.data;
		}
		return jsonResponse({
			// Remove-by: 2026-11-01. An older plugin reads the console fold at the top level.
			...consoleSnapshot,
			console: consoleSnapshot,
			daemon: daemonCapabilityStore?.snapshot() ?? UNREPORTED_CAPABILITIES,
		});
	}

	return { capabilities };
}
