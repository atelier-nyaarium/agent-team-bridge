import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export interface RouterTls {
	certPem: string;
	keyPem: string;
	certFp: string;
}

////////////////////////////////
//  Functions & Helpers

export function loadRouterTls(dataDir: string): RouterTls {
	const certFile = path.join(dataDir, "router-cert.pem");
	const keyFile = path.join(dataDir, "router-key.pem");
	const certExists = exists(certFile);
	const keyExists = exists(keyFile);
	if (certExists !== keyExists) throw new Error("router TLS certificate and key must be present together");
	if (!certExists) mintRouterTls(dataDir, certFile, keyFile);
	const certPem = readFileSync(certFile, "utf8");
	const keyPem = readFileSync(keyFile, "utf8");
	let der: Buffer;
	try {
		const certificate = new X509Certificate(certPem);
		createPrivateKey(keyPem);
		der = certificate.raw;
	} catch {
		throw new Error("router TLS files are corrupt");
	}
	return { certPem, keyPem, certFp: createHash("sha256").update(der).digest("hex") };
}

function exists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function mintRouterTls(dataDir: string, certFile: string, keyFile: string): void {
	mkdirSync(dataDir, { recursive: true });
	const result = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			keyFile,
			"-out",
			certFile,
			"-days",
			"14600",
			"-subj",
			"/CN=switchboard-federation-router",
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`router TLS mint failed: ${result.stderr || result.error?.message}`);
	chmodSync(keyFile, 0o600);
	try {
		chmodSync(certFile, 0o600);
	} catch {}
	writeFileSync(keyFile, readFileSync(keyFile), { mode: 0o600 });
}
