import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slugField } from "../shared/crypto.js";
import { DOMAIN_ID_FILE, resolveLocalDomainId, sanitizeDomainId } from "../shared/domain-id.js";

describe("sanitizeDomainId", () => {
	it("slugs to lower-case alphanumerics with single dashes", () => {
		expect(sanitizeDomainId("My Lab")).toBe("my-lab");
		expect(sanitizeDomainId("ACME_Corp.1")).toBe("acme-corp-1");
	});

	it("trims dash runs at the ends", () => {
		expect(sanitizeDomainId("--alice--")).toBe("alice");
	});

	it("collapses the qualifier separator instead of carrying it", () => {
		expect(sanitizeDomainId("a/b")).toBe("a-b");
	});

	it("throws on empty or all-separator input (no silent default)", () => {
		expect(() => sanitizeDomainId("")).toThrow();
		expect(() => sanitizeDomainId("///")).toThrow();
	});
});

describe("slugField / sanitizeDomainId alignment", () => {
	const slug = slugField();

	it("accepts canonical ids that sanitize unchanged", () => {
		for (const id of ["alice", "carol-gw", "guest-9f3a", "a3f91c2e4d5b6789", "sakura"]) {
			expect(slug.safeParse(id).success).toBe(true);
			expect(sanitizeDomainId(id)).toBe(id);
		}
	});

	it("rejects pure-separator / edge-dash ids that sanitizeDomainId would throw on or alter", () => {
		// The edge-case class these expose: these once passed slugField but throw at sanitize
		// (the silent default that once swallowed them is gone), so reject them at validation.
		for (const bad of ["---", "-x", "x-", "a--b", ""]) {
			expect(slug.safeParse(bad).success).toBe(false);
		}
	});
});

describe("resolveLocalDomainId", () => {
	let prev: string | undefined;
	let dir: string;

	beforeEach(() => {
		prev = process.env.FEDERATION_DOMAIN_ID;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "domid-"));
	});

	afterEach(() => {
		if (prev === undefined) delete process.env.FEDERATION_DOMAIN_ID;
		else process.env.FEDERATION_DOMAIN_ID = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when neither the file nor the env is set", () => {
		delete process.env.FEDERATION_DOMAIN_ID;
		expect(resolveLocalDomainId(dir)).toBeNull();
	});

	it("falls back to FEDERATION_DOMAIN_ID, sanitized, when there is no file", () => {
		process.env.FEDERATION_DOMAIN_ID = "Acme Corp";
		expect(resolveLocalDomainId(dir)).toBe("acme-corp");
	});

	it("prefers the delivered domain-id file over the env", () => {
		process.env.FEDERATION_DOMAIN_ID = "from-env";
		fs.writeFileSync(path.join(dir, DOMAIN_ID_FILE), "From File\n");
		expect(resolveLocalDomainId(dir)).toBe("from-file");
	});
});
