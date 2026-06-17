import { describe, expect, it } from "vitest";
import { sanitizeSwitchId } from "../shared/host-id.js";
import {
	composeConvSessionId,
	parseConvSessionTeam,
	parseQualifiedTeam,
	qualifyTeam,
} from "../shared/phone-protocol.js";

describe("switch qualification", () => {
	it("qualifies a bare name under a Switch id", () => {
		expect(qualifyTeam("laptop", "recipe-app")).toBe("laptop/recipe-app");
	});

	it("leaves an already-qualified name unchanged (idempotent)", () => {
		expect(qualifyTeam("laptop", "laptop/recipe-app")).toBe("laptop/recipe-app");
		expect(qualifyTeam("other", "laptop/recipe-app")).toBe("laptop/recipe-app");
	});

	it("parses a qualified name into switch and local name", () => {
		expect(parseQualifiedTeam("laptop/recipe-app")).toEqual({ switchId: "laptop", name: "recipe-app" });
	});

	it("parses a bare name to a null switchId (resolves local)", () => {
		expect(parseQualifiedTeam("recipe-app")).toEqual({ switchId: null, name: "recipe-app" });
	});

	it("splits on the FIRST separator so the switch is unambiguous", () => {
		// Switch ids and local names never contain the separator, but the parse must
		// still be defined: everything after the first separator is the name.
		expect(parseQualifiedTeam("laptop/a/b")).toEqual({ switchId: "laptop", name: "a/b" });
	});

	it("round-trips through the conv session-id grammar", () => {
		const qualified = qualifyTeam("laptop", "recipe-app");
		const sid = composeConvSessionId("conv-123", qualified);
		expect(sid).toBe("conv:conv-123:laptop/recipe-app");
		// The tail-after-last-colon parse yields the qualified team, which then
		// splits back into switch + name.
		const tail = parseConvSessionTeam(sid);
		expect(tail).toBe("laptop/recipe-app");
		expect(parseQualifiedTeam(tail!)).toEqual({ switchId: "laptop", name: "recipe-app" });
	});
});

describe("sanitizeSwitchId", () => {
	it("lowercases and slugifies a hostname", () => {
		expect(sanitizeSwitchId("My-Laptop.local")).toBe("my-laptop-local");
	});

	it("collapses runs of non-alphanumerics and trims the ends", () => {
		expect(sanitizeSwitchId("__Host 01__")).toBe("host-01");
	});

	it("falls back to 'switch' for an empty result", () => {
		expect(sanitizeSwitchId("")).toBe("switch");
		expect(sanitizeSwitchId("///")).toBe("switch");
	});

	it("never produces the qualifier separator", () => {
		expect(sanitizeSwitchId("a/b/c")).not.toContain("/");
	});
});
