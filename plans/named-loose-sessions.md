# Named / dynamic loose sessions + terminal for all

Vision (human, 2026-06-27): once the host daemon is in perfect order it becomes the capture
poller and reports ALL sessions - host-loose and the loose sessions of devcontainers. Mirror
how the host's fixed `claude` session was eliminated in favour of dynamic loose peers: the
devcontainer also demotes its fixed session to loose sessions. UX changes - tapping an
"available" devcontainer no longer jumps to chat; it shows a "session name" dialog, then wakes
and spawns a tmux of that name, restoring the Claude session if it exists.

Phased delivery (each phase gets its own `/questionaire` + Workflows fan-out, verified one at a time):
- **P0** - map the substrate (no code). <- current
- **P1** - enumerate all sessions (host daemon as capture poller, read-only listing).
- **P2** - de-hardcode the session name (thread a name through peek/tmux_send/reload/create_session + both gates).
- **P3** - demote the devcontainer fixed session to loose (mirror the host precedent).
- **P4** - the new wake UX (tap available -> session-name dialog -> wake + spawn named tmux -> restore if exists).
- **P5** - surface host-loose sessions in the app.

## Questionaire

### P0 - map the substrate

(Phase under questionaire now. Structural answers captured below as they come in.)
