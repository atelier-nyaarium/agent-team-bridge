import { z } from "zod";

////////////////////////////////
//  Interfaces & Types

export interface MessagePartsViolation {
	index: number;
	length: number;
}

export interface ValidResult {
	valid: true;
	parts: string[];
}

export interface InvalidResult {
	valid: false;
	error: string;
	totalLength: number;
	suggestedParts: number;
	violations: MessagePartsViolation[];
	guidelines: string[];
}

export type ValidateMessagePartsResult = ValidResult | InvalidResult;

////////////////////////////////
//  Schemas

export const ValidateMessagePartsInputSchema = z.object({
	parts: z.array(z.string()).describe(`Array of message parts to validate against Discord's character limit.`),
	safeLength: z
		.number()
		.optional()
		.default(1800)
		.describe(`Soft target length per part, used to calculate suggested part count. Defaults to 1800.`),
	maxLength: z
		.number()
		.optional()
		.default(2000)
		.describe(`Hard maximum length per part. Parts at or above this length are violations. Defaults to 2000.`),
	retryCount: z
		.number()
		.optional()
		.default(0)
		.describe(`Caller-tracked retry count. Increases the suggested part count on each retry. Defaults to 0.`),
});
export type ValidateMessagePartsInput = z.input<typeof ValidateMessagePartsInputSchema>;

////////////////////////////////
//  Constants

const SPLITTING_GUIDELINES = [
	`Each part MUST be under the character limit.`,
	`DO NOT cut sentences in half. Find natural break points.`,
	`Each part should flow naturally into the next.`,
	`DO NOT add your own commentary like "Part 2" or "continued...".`,
	`Maintain the original writing style and tone.`,
	`Avoid repeating content across parts.`,
	`Divide content roughly evenly across all parts.`,
	"When splitting ```code blocks``` across parts, ensure each part has its own ``` sentinels.",
	`When splitting lists across parts, DO NOT cut inside a nested list.`,
	`DO NOT cut inside a table row.`,
];

////////////////////////////////
//  Functions & Helpers

export function validateMessageParts({
	parts,
	safeLength = 1800,
	maxLength = 2000,
	retryCount = 0,
}: ValidateMessagePartsInput): ValidateMessagePartsResult {
	const violations: MessagePartsViolation[] = [];

	for (let i = 0; i < parts.length; i++) {
		if (parts[i].length >= maxLength) {
			violations.push({ index: i, length: parts[i].length });
		}
	}

	if (violations.length === 0) {
		return { valid: true, parts };
	}

	const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
	const suggestedParts = Math.ceil(totalLength / safeLength) + retryCount + 1;

	return {
		valid: false,
		error: `Parts exceed ${maxLength} character limit. Split into ${suggestedParts} parts following the splitting guidelines.`,
		totalLength,
		suggestedParts,
		violations,
		guidelines: SPLITTING_GUIDELINES,
	};
}
