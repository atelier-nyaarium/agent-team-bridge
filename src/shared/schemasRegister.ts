import { z } from "zod";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { EnabledPluginSchema } from "./schemasCapability.js";
import { ADDRESS_SEP, isSlug } from "./session-id.js";

////////////////////////////////
//  WS register schema

export const OP_LEDGER_PROTOCOL = 1;

export const GatewayRegisterAnswerSchema = z
	.object({ ok: z.boolean(), migrationFenced: z.boolean().optional() })
	.passthrough();

export const WsRegisterSchema = z.object({
	type: z.literal("register"),
	team: z
		.string()
		.min(1)
		.max(129)
		.refine((t) => {
			const segs = t.split(ADDRESS_SEP);
			return segs.length <= 2 && segs.every(isSlug);
		}, "team must be a slug spawn-point or spawn.session"),
	mode: z.string().optional(),
	subId: z.string().optional(),
	conversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
	version: z.string().optional(),
	deliveryProtocol: z.number().int().min(0).max(1_000).optional(),
	claudeSessionId: z.string().optional(),
	cwdName: z.string().max(256).optional(),
	token: z.string().optional(),
	sessionToken: z.string().max(256).optional(),
	isMainOrLead: z.boolean().optional().catch(undefined),
	daemonCapabilities: z.array(EnabledPluginSchema).max(64).optional(),
	daemonInstanceId: z.string().max(64).optional(),
});
