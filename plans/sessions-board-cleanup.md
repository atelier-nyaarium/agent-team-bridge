# Sessions board cleanup

## Questionaire

**1. Does the create-icon swap apply to every gateway header, or just your own?**

Recommended: only the local gateway header (e.g. "Sakura"); peer/friend gateway headers keep the plain online/offline text, no create icon.

Answer: confirmed as recommended. "no plus icon for their Gateway, you can have the 'online' text."

**2. What populates the new dialog's project select box?**

- A) Host + every devcontainer project currently in the catalog (awake or asleep).
- B) Same as A, plus orphan projects (devcontainer not currently registered).

Answer: **A**. You can't spawn into a project the gateway doesn't currently know about; orphan projects keep showing their existing sessions but aren't offered as a spawn target.

**3. Which status signals go ambient (title color/motion) vs. stay explicit chips?**

Recommendation: split by kind, not frequency - presence states (`live`/`available`/`verifying`/`ended`) collapse fully into title color (grey when `ended`) plus a shared motion cue for busy states; `check terminal` (needs-login alert) and the version-mismatch chip stay as explicit chips since they aren't presence.

Answer: confirmed as recommended. ("sounds good, lock it in")

**4. How prominent should the working/waking pulse be?**

- A) A soft gradient wash across the whole card background.
- B) A slim animated accent bar reusing the existing amber `0xFFD29922` token.

Answer: **B**. ("Sure B")

**Follow-up refinements from the Designer review:**
- Drop the "loose" section label on flat (non-project-prefixed) sessions - it read as its own category outside any gateway. They sit directly under their gateway's other groups instead, un-indented, with no separating label.
- "Waking up" (`verifying`) uses the *same* amber pulse bar as `working`, not a separate spinner - one motion cue total.
- The gateway row's create affordance is a contained pill button ("+ Create"), not a bare icon - reads as tappable without needing a text hint.
- The new-session dialog's session-name field starts genuinely empty (no placeholder value).

## Plan

All changes are in `android/app/src/main/java/com/atelier_nyaarium/switchboard/MainActivity.kt`.

**1. `GatewayHeader`** (~line 1434)
- Add `showCreate: Boolean` and `onCreate: (() -> Unit)?` params.
- When `showCreate`, render a contained pill button ("+ Create") in place of the "online"/"offline" `Text`. Otherwise unchanged (peer gateways always pass `showCreate = false`).

**2. Sessions board grouping block** (~line 1140-1239)
- `showCreate` computed the same way `hostInjected` is today: `!isPeer && key.gatewayId == state.localGatewayId`.
- The devcontainer project list (`spawnPoints`, `localName`) currently lives inside the `if (!collapsed) { ... }` block (line 1173+), but `GatewayHeader` is instantiated unconditionally above it (line 1165-1172). Hoist the `spawnPoints`/`localName` computation above the collapse gate so it's in scope for `onCreate` regardless of collapsed state - the heavier per-project grouping used only for rendering nested cards stays gated behind `!collapsed` as today.
- `onCreate` opens the new dialog with the project list `listOf("host") + spawnPoints.map { localName(it) }.filterNot { it == "host" }` (host first, then catalog devcontainer projects, awake or asleep) - the `filterNot` guards against a real devcontainer project literally named "host" producing a duplicate entry, mirroring the existing `orphanProjects` exclusion at line 1226.
- The synthetic "host" spawn-point header itself is unchanged in shape (still rendered, still shows its nested sessions indented) - it just loses its own create affordance, same as every other spawn-point header below.
- Remove the "loose" section label ahead of `flatLoose`'s `items(...)` call (line 1232) - those sessions render directly after the gateway's other groups, un-indented, with nothing implying they belong to a separate category.

**3. `SpawnPointHeader`** (~line 1460)
- Remove the `onSpawn` param, the `hapticClickable` modifier, and the leading `Add` icon. Becomes a plain, non-interactive row: project name + "awake"/"asleep" text only.

**4. `SessionCard`** (~line 1497)
- Collapse to 2 rows:
  - Row 1: title (monospace, single line, ellipsis, `weight(1f)`) - followed by whichever of `check terminal` / version chip apply, right-aligned - followed by the unread badge, pinned farthest right.
  - Row 2: snippet (`weight(1f)`, ellipsis) with relative time right-aligned.
- Title color: normal (`onSurface`) when `live`, `verifying`, or `working`; grey (`onSurfaceVariant`) when `available` (asleep) or `ended` (down) - matching "grey out the title if it's down or asleep" literally: only a connected-or-busy session keeps full-color text, everything else reads muted. (The first plan draft only greyed `ended`, silently dropping `available` into full color - a real gap the audit caught, not an intentional call.)
- Remove the primary status chip (`StatusChip(statusWord, statusColor)`) and the `verifying` `CircularProgressIndicator` entirely.
- Accessibility: attach a `contentDescription`/semantics label mirroring the removed chip's text (e.g. "live", "available", "check terminal") to the title or card root, so TalkBack still announces presence now that it's colour-only. Removing the text chip must not remove the information entirely for screen-reader users.
- Add a new small `PulseBar()` composable (slim animated accent bar, sweeping the existing amber `Color(0xFFD29922)` token - reuse the constant, don't introduce a new amber shade) shown whenever `team.status == "verifying"` or `(live && state.working(team.name))` - the one shared motion cue for both busy states. Implementation notes:
  - Drive it from a single shared animation (one `rememberInfiniteTransition` hoisted at the Sessions-board composable, its phase passed down or read via a small shared holder) rather than one independent infinite transition per card - a board with several simultaneously-working sessions shouldn't spin up N separate animation loops for the same visual effect.
  - Read the animated phase in the draw phase (`Modifier.drawWithCache` / `Canvas` capturing the animated value by reference), not directly in `PulseBar`'s composable body, so a running pulse invalidates only that node's draw rather than recomposing the card every frame while the list scrolls.
- Row 1 crowding (title + up to 2 chips + badge, worst case) is accepted as standard ellipsis-on-overflow; no structural change - this combination (long title, needs-login, version mismatch, and double-digit unread all at once) is rare enough not to warrant a 3rd row.

**5. New `CreateSessionDialog` composable** (replaces the `spawnProject: String?` trigger and `SpawnDialog`'s fixed-project shape)
- State becomes something like `createDialogProjects: List<String>?` (non-null shows the dialog, holding the selectable project list built in item 2).
- Internal `selectedProject` state inside the dialog, defaulting to `"host"`. Project selector via `ExposedDropdownMenuBox` + read-only `OutlinedTextField` + `ExposedDropdownMenu`/`DropdownMenuItem`, mirroring the existing pattern already used for the variant/voice menus (~line 2612).
- Pass the dialog the raw `state.pendingSpawns: Set<Pair<String, String>>` (not a pre-filtered `Set<String>` the way `SpawnDialog` gets it today) - the dialog derives `pendingLabels = pendingSpawns.filter { it.first == selectedProject }.mapTo(HashSet()) { it.second }` reactively off its own `selectedProject`. This is the one functionally-critical fix from the audit: since project selection now happens *inside* the dialog instead of being fixed by which header was tapped, the duplicate-spawn guard has to move with it - otherwise switching the dropdown either falsely blocks a free name or silently lets a real duplicate through, which `ChatRepository.spawnSession`'s own guard then no-ops with no user-visible error.
- Session-name field: same free-form `OutlinedTextField` as today's `SpawnDialog`, starts empty.
- Spawn/Cancel buttons call the existing `onSpawn(project, session)` callback unchanged - no protocol/wire changes needed anywhere.
- Implementation-time check (not a design change): confirm a back-press while the project dropdown is open closes just the menu, not the whole dialog - this is the first place this dropdown pattern sits alongside a free-text field with something to lose.

No changes needed outside this one file - purely a rendering/interaction change, the underlying spawn call and Team/session data model are untouched.

## Audit (plan-refinement cycle)

Ran a 5-dimension parallel audit against this plan and the current codebase (code accuracy, UX edge cases, Compose state correctness, pulse-bar performance, requirements completeness). 15 findings surfaced; folded into the Plan section above:
- **Real gaps fixed:** the collapsed-gateway scoping bug (`spawnPoints` was out of scope for `onCreate`), the missing "loose"-label removal (locked in the questionnaire but absent from the numbered plan items), the `pendingLabels` duplicate-spawn guard not re-scoping to the dialog's own project selection (silent no-op bug), the title-color rule under-scoping "asleep" (only `ended` was grey, contradicting the original "down or asleep" wording), and no accessibility label replacing the removed status chip.
- **Adopted implementation guidance:** `PulseBar` reads its animated value in the draw phase (not recomposition) and shares one animation source across cards instead of one per card; the "host" name-collision dedupe in the project list; citing the exact `0xFFD29922` token.
- **Confirmed intentional, not re-opened:** `working` gaining continuous animation where it was previously static is the explicit result of the locked Q4 answer, not a bug.
- **Accepted as-is:** row-1 chip crowding in the rare worst case is normal ellipsis behavior, not worth a structural change.

Two pre-existing bugs (unrelated to this plan, confirmed unchanged in the diff) surfaced during red-team and are tracked separately, not fixed here: a LazyColumn duplicate item-key crash when two Gateways/peers share a project name, and `GatewayHeader.onToggle` capturing a stale `collapsed` snapshot. Both are recorded as phren findings/tasks for `switchboard`.

## Painpoints

Found during a crust-collection sweep of the sessions-board area and its immediate neighbors. Not fixed here - candidates for a future pass.

- `MainActivity.kt : ThreadScreen : attachments` - the picked-but-unsent attachment list is `remember`-ed without keying on `team`, unlike the adjacent `draft`/`terminalMode` state which are explicitly `remember(team)`-keyed. Switching threads with unsent attachments picked may leak them into the wrong thread.
- `MainActivity.kt : SessionsScreen : isPeer/adminDomainId` - `adminDomainId` derives from the first session matching the local gateway id, so it's empty whenever the board currently shows zero sessions on your own Gateway (e.g. right after enrollment). An empty `adminDomainId` forces `isPeer = false` for every group, including genuine peer Domains, in that window.
- `MainActivity.kt : (top-level) : canRename` - computed two different ways: the ThreadScreen call site uses `kind == "loose"`, the SessionActionsDialog call site uses `kind != "devcontainer"`. For a team of kind `"console"` these disagree, so Rename shows on the board's long-press menu but not in the open thread's kebab menu for the same session.
- `ConsoleClient.kt : ConsoleClient` - never implements the `reload_plugins` console op, despite CLAUDE.md documenting it as available "the same way" as peek/tmux_send/create_session, and the server side (`consoleHandler.ts`, `hostOpRunner.ts`, `hostDaemon.ts`) fully implementing and testing it. No client wrapper, no call site, no UI affordance exists in the Android app.
- `ChatRepository.kt : ChatState : sessions` - the `localGatewayId` parameter is never referenced in the function body; every call site passes it as if it scopes the result, but it's silently discarded.
- `ChatRepository.kt : ChatState : label` - same pattern: `localGatewayId` is accepted but never used by the delegate calls, despite 11+ call sites passing `state.localGatewayId` as if it disambiguates.
- `MainActivity.kt : (top-level) : statusWord` - the KDoc block describing `presenceColor` ("Chip color for the board/thread presence vocabulary.") is misattached above `statusWord` instead, leaving `presenceColor` undocumented and `statusWord`'s doc nonsensical.
