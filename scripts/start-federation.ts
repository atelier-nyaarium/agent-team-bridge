// Start the federation Router without touching the gateway. Driven by start-federation.sh / .ps1,
// thin launchers that exec this. Every .env key the Router reads is written here or by the setup
// menu; the LAN bind is re-detected on every run so a DHCP move never strands the Router on an
// address this machine no longer holds.

import { die, note } from "./lib/host.js";
import { ensureRouterEnv, shortFp, startRouter } from "./lib/routerStart.js";

////////////////////////////////
//  Entry

async function main(): Promise<void> {
	const env = await ensureRouterEnv();
	if (!env.publicHost)
		note("No public address set. Run ./setup.sh to add one so a phone off this LAN can reach the Router.");
	const health = await startRouter(env, { build: true });
	note(`Router ${health.wasRunning ? "running" : "ready"}. Fingerprint ${shortFp(health.certFingerprint)}`);
	console.log(health.certFingerprint);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
