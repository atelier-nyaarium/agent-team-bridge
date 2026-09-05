import { UNREPORTED_CAPABILITIES } from "../../shared/capabilities.js";
import { CapabilitySnapshotSchema } from "../../shared/schemasCapability.js";
import { jsonResponse } from "../routeSchemas.js";

/** Bounds the remote wait below the caller's timeout. */
const CAPABILITIES_ROUTER_DEADLINE_MS = 1_000;

/** Returns the remote answer or fallback. */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		timer.unref?.();
		void work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});
}

export interface CapabilityRoutesDeps {
	capabilityStore?: Pick<import("../console/capabilityStore.js").CapabilityStore, "snapshot">;
	daemonCapabilityStore?: Pick<import("../daemonCapabilities.js").DaemonCapabilityStore, "snapshot">;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "isRegistered" | "callInboxTool"> | null;
}

export function createCapabilityRoutes({ capabilityStore, daemonCapabilityStore, routerClient }: CapabilityRoutesDeps) {
	/** Ungated on purpose: it serves non-secret capability ids and their own instruction text, and the
	 * hand-launched host window this exists to serve carries no credential to present. */
	async function capabilities(): Promise<Response> {
		// Kept apart rather than merged here: only the caller knows what it already holds, and a.
		let consoleSnapshot = capabilityStore?.snapshot() ?? UNREPORTED_CAPABILITIES;
		if (routerClient?.isRegistered()) {
			const result = await withDeadline(
				routerClient.callInboxTool("capabilities_read", { kind: "capabilities_read" }),
				CAPABILITIES_ROUTER_DEADLINE_MS,
				{ callId: "", error: "Router did not answer in time" },
			);
			const parsed = CapabilitySnapshotSchema.safeParse(result.result);
			// Unknown snapshots do not displace local capabilities.
			if (!result.error && parsed.success && parsed.data.known) consoleSnapshot = parsed.data;
		}
		return jsonResponse({
			// LEGACY, remove after 2026-11-01. A session started by a plugin from before the split reads.
			...consoleSnapshot,
			console: consoleSnapshot,
			daemon: daemonCapabilityStore?.snapshot() ?? UNREPORTED_CAPABILITIES,
		});
	}

	return { capabilities };
}
