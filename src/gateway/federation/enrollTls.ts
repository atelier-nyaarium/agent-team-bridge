import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

////////////////////////////////
//  Returns

export interface EnrollCert {
	certPem: string;
	keyPem: string;
	// SHA-256 of the leaf DER, lowercase hex. The phone pins exactly this.
	certFp: string;
}

////////////////////////////////
//  Functions & Helpers

/** Mint an ephemeral self-signed TLS leaf for the arming-window /enroll listener. The gateway's LAN
 * IP goes in subjectAltName=IP:<lanIp> so the phone's STANDARD hostname check passes (no permissive
 * verifier) while it pins the leaf fingerprint carried in the admit QR. The bundle is already E2E
 * sealed, so this TLS exists only to satisfy Android's cleartext policy without an app-wide permit and
 * to keep the LAN wire metadata-private; the pin is the trust, so the cert is single-use and lives
 * only in memory for the ~10 min window. ECDSA P-256 keeps minting fast enough to run per arming.
 * Returns null for a non-numeric / wildcard host - there is no real IP to bind the SAN to, so the
 * caller falls back to the paste path rather than serve a cert no phone can verify. */
export function generateEnrollCert(lanIp: string): EnrollCert | null {
	if (isIP(lanIp) !== 4 || lanIp === "0.0.0.0") return null;

	let dir: string | null = null;
	try {
		dir = mkdtempSync(join(tmpdir(), "enroll-tls-"));
		const keyPath = join(dir, "enroll.key");
		const csrPath = join(dir, "enroll.csr");
		const certPath = join(dir, "enroll.crt");
		const extPath = join(dir, "enroll.ext");
		run("openssl", ["ecparam", "-genkey", "-name", "prime256v1", "-out", keyPath]);
		run("openssl", ["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", "/CN=switchboard-enroll"]);
		writeFileSync(
			extPath,
			[
				"basicConstraints=CA:FALSE",
				"keyUsage=digitalSignature,keyEncipherment",
				"extendedKeyUsage=serverAuth",
				`subjectAltName=IP:${lanIp}`,
			].join("\n"),
		);
		run("openssl", [
			"x509",
			"-req",
			"-in",
			csrPath,
			"-signkey",
			keyPath,
			"-days",
			"1",
			"-sha256",
			"-out",
			certPath,
			"-extfile",
			extPath,
		]);

		const certPem = readFileSync(certPath, "utf-8");
		const keyPem = readFileSync(keyPath, "utf-8");
		const der = Buffer.from(certPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
		const certFp = createHash("sha256").update(der).digest("hex");
		return { certPem, keyPem, certFp };
	} catch (e) {
		// An openssl / mkdtemp failure must degrade to the paste path, never crash armed boot - the
		// caller treats null as "no LAN listener" and the Console enrolls by paste (still nonce-gated).
		console.warn(
			`[enroll] enroll cert mint failed; falling back to paste: ${e instanceof Error ? e.message : String(e)}`,
		);
		return null;
	} finally {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

function run(cmd: string, args: string[]): void {
	const result = spawnSync(cmd, args, { encoding: "utf-8" });
	if (result.error) {
		throw new Error(`${cmd} ${args[0]} failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args[0]} failed (exit ${result.status}): ${result.stderr}`);
	}
}
