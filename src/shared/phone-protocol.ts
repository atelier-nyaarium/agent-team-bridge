import type { ChannelFile, EffortLevel, RequestType, TeamInfo } from "./types.js";

////////////////////////////////
//  Phone bridge protocol
//
//  The Android app reaches the arbiter through evie, which relays opaque
//  envelopes between the phone connection and the existing arbiter<->evie
//  WebSocket. Evie understands none of these shapes; it pipes by (device, opId).
//  All phone/chat semantics live in the arbiter. See plans/android-channel-app.md.

export const PHONE_PROTOCOL_VERSION = 1;

////////////////////////////////
//  Ops (phone -> arbiter)

export type PhoneOpKind = "register" | "list_teams" | "send" | "respond" | "poll";

export interface PhoneRegisterOp {
	kind: "register";
}

export interface PhoneListTeamsOp {
	kind: "list_teams";
}

export interface PhoneSendOp {
	kind: "send";
	to: string;
	request_type?: RequestType;
	effort?: EffortLevel | "auto";
	body: string;
	files?: ChannelFile[];
}

export interface PhoneRespondOp {
	kind: "respond";
	session_id: string;
	status?: string;
	response?: string;
	replyAsJson?: Record<string, unknown>;
	files?: ChannelFile[];
}

export interface PhonePollOp {
	kind: "poll";
	// Highest mailbox seq the phone has already consumed. Entries at or below it
	// are acked (dropped); entries above it are returned.
	cursor?: number;
	// The mailbox epoch the cursor belongs to. The server only acks when this
	// matches the live mailbox epoch, so a cursor carried over from an evicted
	// instance can never ack away the new instance's entries.
	epoch?: number;
	// Long-poll: when the mailbox is empty, hold the op open up to this many ms
	// waiting for an append before returning. Capped server-side well under the
	// relay-chain timeouts (evie HTTP hold, apiserver proxy 60s).
	holdMs?: number;
}

export type PhoneOp = PhoneRegisterOp | PhoneListTeamsOp | PhoneSendOp | PhoneRespondOp | PhonePollOp;

////////////////////////////////
//  Relay frames (carried over the arbiter<->evie WebSocket)

export interface PhoneRelayFrame {
	type: "phone_relay";
	v: number;
	// Device identity (team name on the bridge) and the phone's stable per-install
	// conversation id. Both ride the envelope so any op can bind/route the peer,
	// not just register.
	device: string;
	conversationId: string;
	// Idempotency key for one logical op. The phone MUST reuse the same opId when
	// retrying after a lost reply; the arbiter replays the cached reply so a
	// `send`/`respond` cannot run twice (no duplicate channel_push/response_push).
	opId: string;
	op: PhoneOp;
}

export interface PhoneRelayReply {
	type: "phone_relay_reply";
	v: number;
	opId: string;
	ok: boolean;
	result?: PhoneOpResult;
	error?: string;
}

////////////////////////////////
//  Op results (arbiter -> phone)

export interface PhoneRegisterResult {
	device: string;
	// Current mailbox high-water seq so a reconnecting phone can resync its cursor.
	cursor: number;
	// Mailbox instance id. If it differs from the phone's stored epoch, the
	// mailbox was recreated and the phone must reset its cursor to 0.
	epoch: number;
}

export interface PhoneListTeamsResult {
	teams: TeamInfo[];
}

export interface PhoneSendResult {
	session_id: string;
	status: string;
}

export interface PhoneRespondResult {
	delivered: boolean;
}

export interface PhonePollResult {
	entries: MailboxEntry[];
	cursor: number;
	// Cumulative count of entries evicted by the cap before the phone read them.
	// Never reset server-side; the phone detects a new gap by comparing against
	// the previous total (or by a non-contiguous seq jump).
	dropped: number;
	// Mailbox instance id. On change the phone resets its cursor to 0 (the prior
	// mailbox was evicted and a new one started seq at 1).
	epoch: number;
}

export type PhoneOpResult =
	| PhoneRegisterResult
	| PhoneListTeamsResult
	| PhoneSendResult
	| PhoneRespondResult
	| PhonePollResult;

////////////////////////////////
//  Mailbox

// "notice" is a broadcast announcement (e.g. a cycle-end report relayed via the
// notify_human tool): delivered to every phone, threaded under the sender, and
// never respondable (its session id is not a conversation).
export type MailboxEntryKind = "message" | "reply" | "notice";

export interface MailboxEntry {
	seq: number;
	at: number;
	kind: MailboxEntryKind;
	session_id: string;
	from?: string;
	// Notification-bar line for notices; the body carries the full report.
	title?: string;
	body?: string;
	status?: string;
	replyAsJson?: Record<string, unknown>;
	question?: string;
	reason?: string;
	request_type?: RequestType;
	effort?: string;
	is_follow_up?: boolean;
	files?: ChannelFile[];
}

export type MailboxInput = Omit<MailboxEntry, "seq" | "at">;
