// The enrollment window, its pinned-TLS door, and the bootstrap install.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { Identity } from "../../shared/crypto.js";
import { GatewayBootstrapFrameSchema } from "../../shared/schemas.js";
import type { GatewayBoot } from "../boot.js";
import { activateStaged, openBootstrapBundle, stageBootstrap } from "../federation/bootstrapInstall.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";
import { admitGatewayPayload, type EnrollDelivery, logAdmitGatewayQr } from "../federation/enrollQr.js";
import { generateEnrollCert } from "../federation/enrollTls.js";
import type { FederationContext } from "./federationContext.js";
import type { EnrollTlsListener, OpenEnrollTls } from "./gatewayTypes.js";

const ENROLL_WINDOW_MS = 600_000;

export interface EnrollmentStageDeps {
	federationDir: string;
	localGatewayId: string;
	enrollTlsPort: number;
	enrollLanHost: string;
	openEnrollTls?: OpenEnrollTls;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	identity: () => Identity;
	contentKeyStore: ContentKeyStore;
	resolveBoot: (enrollNonce: string | null) => GatewayBoot;
	context: FederationContext;
}

export interface EnrollmentStage {
	/** Opens the window and publishes the admit payload. */
	enterArming: (nonce: string) => void;
	handleEnrollPost: (body: Record<string, unknown>) => Response;
	enrollTlsFetch: (req: Request) => Promise<Response>;
	stop: () => void;
}

export function composeEnrollment(deps: EnrollmentStageDeps): EnrollmentStage {
	const { context, federationDir, localGatewayId, contentKeyStore, ambient } = deps;
	let enrollTimer: TimerHandle | null = null;
	let enrollTlsServer: EnrollTlsListener | null = null;

	function refuse(error: string, status: number): Response {
		return new Response(JSON.stringify({ ok: false, error }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	function handleEnrollPost(body: Record<string, unknown>): Response {
		const install = context.arming()?.install;
		if (!install) return refuse("not in enrollment mode", 404);
		try {
			const gatewayId = install(body);
			return new Response(JSON.stringify({ ok: true, gatewayId }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (e) {
			return refuse(e instanceof Error ? e.message : String(e), 400);
		}
	}

	async function enrollTlsFetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/enroll") {
			let body: Record<string, unknown> = {};
			try {
				body = (await req.json()) as Record<string, unknown>;
			} catch {
				return refuse("Invalid JSON", 400);
			}
			return handleEnrollPost(body);
		}
		return refuse("not found", 404);
	}

	function install(frame: unknown, enrollIdentity: Identity, nonce: string): string {
		const bundle = openBootstrapBundle(frame, enrollIdentity, nonce, localGatewayId);
		const heldKeyCount = contentKeyStore.epochs().length;
		const outerSignerSignPub = GatewayBootstrapFrameSchema.parse(frame).signerSignPub;
		stageBootstrap(federationDir, bundle, enrollIdentity, contentKeyStore, ambient, outerSignerSignPub);
		try {
			activateStaged(federationDir, ambient);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`[enroll] bundle staged; a gateway restart completes it or a re-arm discards it: ${reason}`);
			throw new Error("bundle is staged; a gateway restart completes it or a re-arm discards it");
		}
		contentKeyStore.reload();
		console.log(`[federation] content keys: held ${heldKeyCount}, delivered ${bundle.contentKeys?.length ?? 0}`);
		context.standalone();
		enrollTlsServer?.stop();
		enrollTlsServer = null;
		if (enrollTimer) ambient.clearTimer(enrollTimer);
		const installedBoot = deps.resolveBoot(null);
		if (installedBoot.kind === "active") {
			try {
				context.activate(installedBoot.boot);
				console.log(
					`[enroll] installed credentials for Gateway "${localGatewayId}"; connecting to the Router.`,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(
					`[enroll] credentials installed but Router activation failed: ${msg}. Re-run setup.sh (Setup Gateway).`,
				);
			}
		} else {
			console.log(`[enroll] credentials installed but no Domain id resolved; re-run setup.sh (Setup Gateway).`);
		}
		return localGatewayId;
	}

	function enterArming(nonce: string): void {
		const enrollIdentity = deps.identity();
		const enrollCert = deps.openEnrollTls ? generateEnrollCert(deps.enrollLanHost) : null;
		const delivery: EnrollDelivery = {
			nonce,
			...(enrollCert
				? { lan: { host: deps.enrollLanHost, port: deps.enrollTlsPort, certFp: enrollCert.certFp } }
				: {}),
		};
		if (enrollCert && deps.openEnrollTls) {
			enrollTlsServer = deps.openEnrollTls({
				port: deps.enrollTlsPort,
				certPem: enrollCert.certPem,
				keyPem: enrollCert.keyPem,
				fetch: enrollTlsFetch,
			});
			console.log(
				`[enroll] pinned-TLS delivery on ${deps.enrollLanHost}:${deps.enrollTlsPort} (cert ${enrollCert.certFp.slice(0, 16)}...)`,
			);
		}
		logAdmitGatewayQr(enrollIdentity, localGatewayId, delivery);
		enrollTimer = ambient.setTimer(() => {
			if (context.arming()) {
				context.standalone();
				enrollTlsServer?.stop(true);
				enrollTlsServer = null;
				console.log("[enroll] enrollment window expired (~10 min); re-run setup.sh (Enroll gateway)");
			}
		}, ENROLL_WINDOW_MS);
		context.arm({
			install: (frame) => install(frame, enrollIdentity, nonce),
			admitPayload: admitGatewayPayload(enrollIdentity, localGatewayId, delivery),
		});
	}

	return {
		enterArming,
		handleEnrollPost,
		enrollTlsFetch,
		stop: () => {
			if (enrollTimer) ambient.clearTimer(enrollTimer);
			enrollTlsServer?.stop(true);
			enrollTlsServer = null;
		},
	};
}
