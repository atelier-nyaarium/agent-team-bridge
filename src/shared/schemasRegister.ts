import { z } from "zod";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { EnabledPluginSchema } from "./schemasCapability.js";
import { ADDRESS_SEP, isSlug } from "./session-id.js";

////////////////////////////////
//  WS Register Schema
//
//  Validates the register message at the bridge WebSocket boundary, the one
//  message where a blind-cast team name could key the registry on undefined.
//  mode stays an open string; the handler normalizes it (every connection is
//  channel mode).

/** The gateway answers this on a successful register. A producer that issues its own operation ids
 * needs it: a gateway below this version drops the field and mints one per attempt, which accepts a
 * retry as a second operation. */
export const OP_LEDGER_PROTOCOL = 1;

export const WsRegisterSchema = z.object({
	type: z.literal("register"),
	// A bare slug (host, a devcontainer project, a loose hex name) or a composite `project.session`.
	// Shell-safe so a team name can never carry a metacharacter into the daemon's launch command.
	// A live registrant is a spawn-point (arity 1) or a chat (arity 2); each segment a dotless slug.
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
	// The plugin version (package.json) the MCP process is running. Absent for
	// non-plugin registrants (e.g. the host daemon); the plugin always reports it.
	version: z.string().optional(),
	// Which delivery contract this plugin speaks. 1 means it acknowledges every channel_push, which
	// is what lets the gateway hold a message for a session that was not ready. Absent for a plugin
	// predating the acknowledgement, whose messages are retired on the write as they always were.
	deliveryProtocol: z.number().int().min(0).max(1_000).optional(),
	// The Claude Code harness session id, reported so the gateway can persist a
	// `team -> claudeSessionId` map and `claude --resume <id>` the session on a later wake.
	claudeSessionId: z.string().optional(),
	// The plugin's cwd basename, the default session label for a self-appearing (manually launched)
	// session. Bounded here; the store sanitizes and caps it to a single printable path segment.
	cwdName: z.string().max(256).optional(),
	// Shared secret the host daemon presents so a LAN peer cannot squat the reserved
	// "host" slot and drive agent terminals. Optional on the wire (only the host slot
	// sends it), but the host slot is fail-closed: a host register is refused unless the
	// gateway has HOST_WS_TOKEN set AND this token matches it.
	token: z.string().optional(),
	// The session's own binding secret, minted with its SessionRecord and delivered only through the
	// daemon's launch command. A registrant presenting the token bound to the name it claims is
	// BOUND (it owns that name and may take the remembered-lead fast path); one presenting nothing,
	// or a token for a different record, is UNBOUND and demoted - it may still operate its own
	// conversation but cannot claim a name that carries a binding. Never a rejection: a hand-launched
	// session has no token by design, and a purged DATA_DIR leaves every live session tokenless.
	sessionToken: z.string().max(256).optional(),
	// The registrant's remembered answer to a prior bridge handshake (see mcp/bridge/helpers.ts's
	// isMainOrLeadAgent cache) - true skips the handshake prompt entirely on this register. Never
	// sent as false (a worker that answered false is evicted and does not reconnect). A malformed
	// value degrades to absent (the normal handshake-prompt path) rather than failing the register.
	isMainOrLead: z.boolean().optional().catch(undefined),
	// The host daemon's own configuration, honoured only on the token-gated "host" slot. Complete
	// every time: present-but-empty affirms nothing enabled, absent leaves the last one standing.
	daemonCapabilities: z.array(EnabledPluginSchema).max(64).optional(),
	// Identifies the daemon PROCESS, not this connection. A reconnect changes which socket carries an
	// event, not which supervisor produced it, so a durable event fenced by this survives one.
	daemonInstanceId: z.string().max(64).optional(),
});
