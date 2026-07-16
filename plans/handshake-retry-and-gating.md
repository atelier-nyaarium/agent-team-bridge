# Handshake gap: no recovery when the `hs-*` id is lost

## Symptom (hit live, 2026-07-15)

A channel session received a work message on `host.575175` and tried to answer with
`channel_reply`. The gateway rejected it: *"Your bridge handshake is still pending. Reply to the
handshake session first with channel_reply_structured, then resend this reply."* But the session
had **no `hs-*` id to answer with** - the handshake notification was never in the LLM's reachable
context (this is a long, previously-compacted session). Every subsequent `channel_reply` is then
permanently refused: the outbound reply deadlocks with no recovery path.

## Root cause

The lead/worker handshake assumes the LLM reliably sees and retains the handshake notification. It
does not survive a missed/aged-out notification:

- `src/gateway/websocket.ts : sendHandshake` mints `hsSessionId = ` `` `hs-${crypto.randomUUID().slice(0, 8)}` `` and
  stores it ONLY in the in-memory `handshakePending` map. It is random (not derivable) and never
  persisted.
- `src/mcp/bridge/helpers.ts` auto-answers a handshake only when the `handshakeRole` cache is
  non-null. On a fresh process the cache is null, so it "falls through" and emits the handshake as
  a channel notification, relying on the LLM to answer it with `channel_reply_structured`.
  `noteReceived(hsSessionId)` records the id inside the cache, but there is no path to answer it
  WITHOUT the LLM supplying the id back.
- If that notification is missed - dropped, delivered in the same turn batch as a work message and
  overlooked, or (as here) aged out of a compacted session's context - the LLM no longer has the id.
- `src/gateway/routes.ts : respond()`'s reply gate then rejects every `channel_reply` to the real
  work session, and (deliberately, per the shipped red-team fix that removed hs-id disclosure to
  close a spoofing hole) the 409 does NOT name the pending id. So the legitimate self-caller cannot
  learn the id it needs, and cannot answer.

Net: `hsSessionId` is random + in-memory-only + withheld from the 409 + answerable only through the
LLM's own transient context. Lose that context once and the session can never send another reply.
The client `handshakeRole` cache never fills (it only fills when the LLM successfully answers a
handshake), so the auto-reply branch never kicks in either - a permanent deadlock, not a one-turn
bounce.

## Fix direction (not yet built)

The MCP process already holds the pending `hs-*` id(s) it received (`handshakeRole`'s internal
`noteReceived` set). Recovery should be MCP-side and id-free, since the LLM losing the id is the
whole failure mode:

- **Option A (preferred): auto-resolve a held handshake on outbound reply.** When
  `channel_reply`/`channel_reply_structured` targets a non-`hs-*` session and this process has a
  received-but-unanswered handshake, resolve it first (default the primary session to
  `isMainOrLead: true`) and retry the reply, instead of letting the gateway 409 bubble up as a dead
  end. The process knows it is the registered lead socket; it does not need the LLM to re-supply the
  id.
- **Option B: let the LLM confirm without the id.** A small reply affordance ("confirm my pending
  handshake as lead") that the MCP maps to whatever `hs-*` it is holding. Weaker than A - it still
  costs an LLM turn and assumes the LLM realizes it is stuck.
- Keep the 409's id-withholding (that spoofing fix stays); recovery must NOT come from echoing the
  id back over the wire.

Cross-check when building: the delegated-worker hazard the shipped design guarded against (a lead
delegating a structured reply to a separate-harness worker must not poison the worker's cache to
lead). Auto-resolving in Option A must stay gated to handshakes THIS process received as its own
registration, matching the existing `noteReceived` scoping.

## Provenance

This file previously held the shipped "remember the answer, stop re-asking" design (one LLM
handshake per process, silent reconnects, the reply-gate, the red-team hs-id-disclosure fix). That
work shipped and its writeup lives in git history for this path. This is a fresh gap the shipped
design did not cover: it optimized the happy path (answer once, cache it) but left no recovery for a
session that never got to answer even once.
