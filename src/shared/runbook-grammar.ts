// One parse owns the placeholder grammar; every reader of a body derives from it.

import type { RunbookParameter } from "./schemasRunbook.js";

export type RunbookToken = { kind: "literal"; text: string } | { kind: "placeholder"; name: string };

export type RunbookParse = { ok: true; tokens: RunbookToken[] } | { ok: false; reason: string };

/** Anchored, so a `{{` either opens a placeholder here or opens nothing. */
const PLACEHOLDER_AT = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/;

/** The same form, found anywhere. Reads rendered text, which is prose rather than a template. */
const PLACEHOLDER_ANYWHERE = /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/;

/** Only an opener can begin a placeholder, so a lone `}}` stays literal for prose about JSON. */
export function parseBody(body: string): RunbookParse {
	const tokens: RunbookToken[] = [];
	let literalFrom = 0;
	let at = 0;
	while (at < body.length) {
		const open = body.indexOf("{{", at);
		if (open === -1) break;
		const match = PLACEHOLDER_AT.exec(body.slice(open));
		if (!match) return { ok: false, reason: "the body opens a `{{` that does not name a parameter" };
		if (open > literalFrom) tokens.push({ kind: "literal", text: body.slice(literalFrom, open) });
		tokens.push({ kind: "placeholder", name: match[1] as string });
		at = open + match[0].length;
		literalFrom = at;
	}
	if (literalFrom < body.length) tokens.push({ kind: "literal", text: body.slice(literalFrom) });
	return { ok: true, tokens };
}

/** First mention first, without repeats. Empty for a body that does not parse. */
export function placeholdersOf(body: string): string[] {
	const parsed = parseBody(body);
	if (!parsed.ok) return [];
	return [...new Set(parsed.tokens.flatMap((token) => (token.kind === "placeholder" ? [token.name] : [])))];
}

export type RunbookRender = { ok: true; text: string } | { ok: false; reason: string };

/** Renders once, then parses its own output; a value and its literals can compose a placeholder. */
export function renderRunbook(
	body: string,
	parameters: readonly RunbookParameter[],
	values: Readonly<Record<string, string>>,
): RunbookRender {
	const parsed = parseBody(body);
	if (!parsed.ok) return parsed;

	const declared = new Map(parameters.map((parameter) => [parameter.name, parameter]));
	const unknown = Object.keys(values).filter((name) => !declared.has(name));
	// A value for a parameter that does not exist means the sender holds a different runbook.
	if (unknown.length > 0) {
		return { ok: false, reason: `this runbook has no ${unknown.join(", ")}; push your copy of it first` };
	}

	const filled = new Map<string, string>();
	for (const [name, parameter] of declared) {
		// Own properties only: a parameter may legally be named `toString`.
		const supplied = Object.hasOwn(values, name) ? values[name] : undefined;
		const value = supplied ?? parameter.default ?? "";
		if (value === "") return { ok: false, reason: `${name} has no value` };
		if (parameter.kind === "choice" && !(parameter.options ?? []).includes(value)) {
			return { ok: false, reason: `${name} is not one of the values it offers` };
		}
		filled.set(name, value);
	}

	const text = parsed.tokens
		.map((token) => (token.kind === "literal" ? token.text : (filled.get(token.name) as string)))
		.join("");

	// Only a well-formed placeholder is a fault; a bare `{{` composes nothing and stays prose.
	if (PLACEHOLDER_ANYWHERE.test(text)) {
		return { ok: false, reason: "a filled value composes another `{{name}}`; take the braces out of it" };
	}
	return { ok: true, text };
}
