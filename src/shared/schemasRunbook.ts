// A body's placeholders are its parameter list; nothing declares one without the other.

import { z } from "zod";

// Size is the owner's own to spend: these ops reach one gateway, authenticated as its owner, and
// the console path's 64 MiB body cap is the only ceiling.

/** `{{name}}`, the only placeholder form. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export interface PlaceholderOccurrence {
	name: string;
	index: number;
	/** The matched text's length, which a filled value replaces. */
	length: number;
}

export function placeholderOccurrences(body: string): PlaceholderOccurrence[] {
	return [...body.matchAll(PLACEHOLDER_RE)].map((match) => ({
		name: match[1] as string,
		index: match.index,
		length: match[0].length,
	}));
}

/** Only the opener is checked; prose about JSON legitimately closes nested braces. */
function strayOpener(body: string): boolean {
	const opens = new Set(placeholderOccurrences(body).map((occurrence) => occurrence.index));
	for (const match of body.matchAll(/\{\{/g)) if (!opens.has(match.index)) return true;
	return false;
}

/** First mention first, without repeats. */
export function placeholdersOf(body: string): string[] {
	return [...new Set(placeholderOccurrences(body).map((occurrence) => occurrence.name))];
}

export const RunbookParameterSchema = z
	.object({
		/** Matches its placeholder in the body. */
		name: z
			.string()
			.min(1)
			.regex(/^[A-Za-z][A-Za-z0-9_]*$/),
		label: z.string().min(1),
		kind: z.enum(["text", "choice"]).meta({ id: "RunbookParameterKind", catalog: "kind" }),
		default: z.string().optional(),
		/** A choice's options, in the order the form offers them. */
		options: z.array(z.string().min(1)).optional(),
	})
	.meta({ id: "RunbookParameter" });

export type RunbookParameter = z.infer<typeof RunbookParameterSchema>;

export const RunbookSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		body: z.string().min(1),
		parameters: z.array(RunbookParameterSchema),
		/** Phone-owned. A gateway refuses a put below the revision it holds. */
		revision: z.number().int().positive(),
	})
	.meta({ id: "Runbook" });

export type Runbook = z.infer<typeof RunbookSchema>;

export const ConsoleRunbookListResultSchema = z
	.object({ runbooks: z.array(RunbookSchema) })
	.meta({ id: "ConsoleRunbookListResult" });

export const ConsoleRunbookPutResultSchema = z
	.object({
		stored: z.boolean(),
		/** What the gateway holds after the write, so a refused put still says what to rebase on. */
		revision: z.number().int().nonnegative(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleRunbookPutResult" });

export const ConsoleRunbookDeleteResultSchema = z
	.object({ deleted: z.boolean() })
	.meta({ id: "ConsoleRunbookDeleteResult" });

export function runbookRefusal(runbook: Runbook): string | null {
	if (strayOpener(runbook.body)) return "the body opens a `{{` that no placeholder closes";

	const placeholders = placeholdersOf(runbook.body);
	const declared = runbook.parameters.map((parameter) => parameter.name);
	if (new Set(declared).size !== declared.length) return "a parameter is declared twice";

	const missing = placeholders.filter((name) => !declared.includes(name));
	if (missing.length > 0) return `the body names ${missing.join(", ")}, which no parameter declares`;

	const unused = declared.filter((name) => !placeholders.includes(name));
	if (unused.length > 0) return `${unused.join(", ")} is declared but the body never names it`;

	for (const parameter of runbook.parameters) {
		// A filled value is text, never another template, so rendering cannot recurse.
		const fills = [parameter.default ?? "", ...(parameter.options ?? [])];
		if (fills.some((fill) => fill.includes("{{") || fill.includes("}}"))) {
			return `${parameter.name} offers a value containing placeholder braces`;
		}
		if (parameter.kind !== "choice") continue;
		const options = parameter.options ?? [];
		if (options.length === 0) return `${parameter.name} is a choice with no options`;
		if (new Set(options).size !== options.length) return `${parameter.name} repeats an option`;
		if (parameter.default !== undefined && !options.includes(parameter.default)) {
			return `${parameter.name} defaults to an option it does not offer`;
		}
	}
	return null;
}
