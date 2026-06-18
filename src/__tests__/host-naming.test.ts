import { describe, expect, it } from "vitest";
import {
	composeConvSessionId,
	parseConvSessionTeam,
	parseQualifiedTeam,
	qualifyTeam,
} from "../shared/console-protocol.js";
import { sanitizeGatewayId } from "../shared/host-id.js";

describe("gateway qualification", () => {
	it("qualifies a bare name under a Gateway id", () => {
		expect(qualifyTeam("laptop", "recipe-app")).toBe("laptop/recipe-app");
	});

	it("leaves an already-qualified name unchanged (idempotent)", () => {
		expect(qualifyTeam("laptop", "laptop/recipe-app")).toBe("laptop/recipe-app");
		expect(qualifyTeam("other", "laptop/recipe-app")).toBe("laptop/recipe-app");
	});

	it("parses a qualified name into gateway and local name", () => {
		expect(parseQualifiedTeam("laptop/recipe-app")).toEqual({ gatewayId: "laptop", name: "recipe-app" });
	});

	it("parses a bare name to a null gatewayId (resolves local)", () => {
		expect(parseQualifiedTeam("recipe-app")).toEqual({ gatewayId: null, name: "recipe-app" });
	});

	it("splits on the FIRST separator so the gateway is unambiguous", () => {
		// Gateway ids and local names never contain the separator, but the parse must
		// still be defined: everything after the first separator is the name.
		expect(parseQualifiedTeam("laptop/a/b")).toEqual({ gatewayId: "laptop", name: "a/b" });
	});

	it("round-trips through the conv session-id grammar", () => {
		const qualified = qualifyTeam("laptop", "recipe-app");
		const sid = composeConvSessionId("conv-123", qualified);
		expect(sid).toBe("conv:conv-123:laptop/recipe-app");
		// The tail-after-last-colon parse yields the qualified team, which then
		// splits back into gateway + name.
		const tail = parseConvSessionTeam(sid);
		expect(tail).toBe("laptop/recipe-app");
		expect(parseQualifiedTeam(tail!)).toEqual({ gatewayId: "laptop", name: "recipe-app" });
	});
});

describe("sanitizeGatewayId", () => {
	it("lowercases and slugifies a hostname", () => {
		expect(sanitizeGatewayId("My-Laptop.local")).toBe("my-laptop-local");
	});

	it("collapses runs of non-alphanumerics and trims the ends", () => {
		expect(sanitizeGatewayId("__Host 01__")).toBe("host-01");
	});

	it("falls back to 'gateway' for an empty result", () => {
		expect(sanitizeGatewayId("")).toBe("gateway");
		expect(sanitizeGatewayId("///")).toBe("gateway");
	});

	it("never produces the qualifier separator", () => {
		expect(sanitizeGatewayId("a/b/c")).not.toContain("/");
	});
});
