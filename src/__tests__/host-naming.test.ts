import { describe, expect, it } from "vitest";
import { sanitizeHostId } from "../shared/host-id.js";
import {
	composeConvSessionId,
	parseConvSessionTeam,
	parseQualifiedTeam,
	qualifyTeam,
} from "../shared/phone-protocol.js";

describe("host qualification", () => {
	it("qualifies a bare name under a host", () => {
		expect(qualifyTeam("laptop", "recipe-app")).toBe("laptop/recipe-app");
	});

	it("leaves an already-qualified name unchanged (idempotent)", () => {
		expect(qualifyTeam("laptop", "laptop/recipe-app")).toBe("laptop/recipe-app");
		expect(qualifyTeam("other", "laptop/recipe-app")).toBe("laptop/recipe-app");
	});

	it("parses a qualified name into host and local name", () => {
		expect(parseQualifiedTeam("laptop/recipe-app")).toEqual({ host: "laptop", name: "recipe-app" });
	});

	it("parses a bare name to a null host (resolves local)", () => {
		expect(parseQualifiedTeam("recipe-app")).toEqual({ host: null, name: "recipe-app" });
	});

	it("splits on the FIRST separator so the host is unambiguous", () => {
		// Host ids and local names never contain the separator, but the parse must
		// still be defined: everything after the first separator is the name.
		expect(parseQualifiedTeam("laptop/a/b")).toEqual({ host: "laptop", name: "a/b" });
	});

	it("round-trips through the conv session-id grammar", () => {
		const qualified = qualifyTeam("laptop", "recipe-app");
		const sid = composeConvSessionId("conv-123", qualified);
		expect(sid).toBe("conv:conv-123:laptop/recipe-app");
		// The tail-after-last-colon parse yields the qualified team, which then
		// splits back into host + name.
		const tail = parseConvSessionTeam(sid);
		expect(tail).toBe("laptop/recipe-app");
		expect(parseQualifiedTeam(tail!)).toEqual({ host: "laptop", name: "recipe-app" });
	});
});

describe("sanitizeHostId", () => {
	it("lowercases and slugifies a hostname", () => {
		expect(sanitizeHostId("My-Laptop.local")).toBe("my-laptop-local");
	});

	it("collapses runs of non-alphanumerics and trims the ends", () => {
		expect(sanitizeHostId("__Host 01__")).toBe("host-01");
	});

	it("falls back to 'host' for an empty result", () => {
		expect(sanitizeHostId("")).toBe("host");
		expect(sanitizeHostId("///")).toBe("host");
	});

	it("never produces the qualifier separator", () => {
		expect(sanitizeHostId("a/b/c")).not.toContain("/");
	});
});
