import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DOMAIN_ID, resolveLocalDomainId, sanitizeDomainId } from "../shared/domain-id.js";

describe("sanitizeDomainId", () => {
	it("slugs to lower-case alphanumerics with single dashes", () => {
		expect(sanitizeDomainId("My Home")).toBe("my-home");
		expect(sanitizeDomainId("ACME_Corp.1")).toBe("acme-corp-1");
	});

	it("trims dash runs at the ends", () => {
		expect(sanitizeDomainId("--home--")).toBe("home");
	});

	it("collapses the qualifier separator instead of carrying it", () => {
		expect(sanitizeDomainId("a/b")).toBe("a-b");
	});

	it("falls back to the default Domain on empty or all-separator input", () => {
		expect(sanitizeDomainId("")).toBe(DEFAULT_DOMAIN_ID);
		expect(sanitizeDomainId("///")).toBe(DEFAULT_DOMAIN_ID);
	});
});

describe("resolveLocalDomainId", () => {
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env.FEDERATION_DOMAIN_ID;
	});

	afterEach(() => {
		if (prev === undefined) delete process.env.FEDERATION_DOMAIN_ID;
		else process.env.FEDERATION_DOMAIN_ID = prev;
	});

	it("defaults to the home Domain when the env is unset", () => {
		delete process.env.FEDERATION_DOMAIN_ID;
		expect(resolveLocalDomainId()).toBe(DEFAULT_DOMAIN_ID);
	});

	it("honors and sanitizes FEDERATION_DOMAIN_ID", () => {
		process.env.FEDERATION_DOMAIN_ID = "Acme Corp";
		expect(resolveLocalDomainId()).toBe("acme-corp");
	});
});
