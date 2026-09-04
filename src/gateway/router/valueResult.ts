import { valueResultAadKind } from "../../shared/content-envelope.js";

type OkOutcome = { kind: "ok"; result: unknown };
type RefusalOutcome = { kind: "refusal"; reason: string };

export function composeValueResult(input: {
	opId: string;
	conversationId: string;
	incarnation: number;
	outcome: OkOutcome | RefusalOutcome;
	seal: (
		plaintext: Buffer,
		aad: { kind: ReturnType<typeof valueResultAadKind> },
	) => { kind: "ok"; envelope: unknown } | null;
}): Record<string, unknown> {
	let result: unknown = input.outcome;
	if (input.outcome.kind === "ok") {
		const sealed = input.seal(Buffer.from(JSON.stringify(input.outcome.result)), {
			kind: valueResultAadKind(input.opId),
		});
		result = sealed?.kind === "ok" ? sealed.envelope : { kind: "refusal", reason: "content key unavailable" };
	}
	return {
		opId: input.opId,
		conversationId: input.conversationId,
		result,
		incarnation: input.incarnation,
	};
}
