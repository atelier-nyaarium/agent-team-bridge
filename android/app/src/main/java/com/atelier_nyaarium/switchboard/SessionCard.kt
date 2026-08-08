package com.atelier_nyaarium.switchboard

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.board.BoardLiveLine

////////////////////////////////
//  Composables

/** One shared 0f-1f sweep phase driving every SessionCard's working/verifying pulse bar, so a board
 * with several busy sessions runs one animation loop instead of one per card. */
@Composable
internal fun rememberSessionsPulsePhase(): State<Float> {
	val transition = rememberInfiniteTransition(label = "sessionsPulse")
	return transition.animateFloat(
		initialValue = 0f,
		targetValue = 1f,
		animationSpec = infiniteRepeatable(animation = tween(1600, easing = LinearEasing)),
		label = "pulsePhase",
	)
}

/** Slim animated accent bar for a "verifying" or "working" session. Reads `phase` inside `drawBehind`'s
 * draw-phase callback rather than the composable body, so it repaints just this bar, not the whole card. */
@Composable
private fun PulseBar(phase: State<Float>, modifier: Modifier = Modifier) {
	val amber = presenceColor("working...")
	Box(
		modifier
			.fillMaxWidth()
			.height(3.dp)
			.clip(MaterialTheme.shapes.extraSmall)
			.background(amber.copy(alpha = 0.18f))
			.drawBehind {
				val highlightWidth = size.width * 0.4f
				val x = -highlightWidth + phase.value * (size.width + highlightWidth * 2f)
				drawRect(
					brush = Brush.horizontalGradient(
						colors = listOf(Color.Transparent, amber, Color.Transparent),
						startX = x,
						endX = x + highlightWidth,
					),
				)
			},
	)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionCard(
	state: ChatState,
	team: Team,
	nested: Boolean = false,
	pulsePhase: State<Float>,
	// The board's live line, when this session has unfinished board work. sessionCardPreview decides
	// what it does to the ladder; null means this session has no board work to show.
	boardLine: BoardLiveLine? = null,
	// The branch that line sits in. Null falls back to drawing the line alone.
	boardBranch: com.atelier_nyaarium.switchboard.board.CardBranch? = null,
	onClick: () -> Unit,
	onLongPress: () -> Unit,
) {
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	val display = state.label(team.name)
	val unread = state.unread[team.name] ?: 0
	val live = team.status == "online"
	val statusWord = statusWord(team.status)
	// The board tile reads the presence plane directly (Team.working/needsLogin, daemon-derived and
	// pushed on the poll response) rather than this device's own peek - a board session has no peek
	// stream of its own. Null means unknown (never observed, or
	// derivation just became impossible), never false - a tile shows no pulse rather than a stale
	// frozen one, so both chips are gated on an explicit `== true`, not a null-as-false fallback.
	val checkTerminal = live && team.needsLogin == true
	val limitHit = live && team.limitBlocked == true
	// "working" and "verifying" are one busy state sharing a single pulse bar. A limit-blocked session
	// is stopped rather than busy, so it must not pulse even if the frame that derived it caught a
	// spinner still on screen.
	val busy = statusWord == "verifying" || (live && team.working == true && !limitHit)
	// Ambient presence: full color while connected or busy, muted once asleep or gone ("down or
	// asleep" both read the same muted way - only a connected/busy session keeps full-color text).
	val titleColor =
		if (statusWord == "available" || statusWord == "ended") {
			MaterialTheme.colorScheme.onSurfaceVariant
		} else {
			MaterialTheme.colorScheme.onSurface
		}
	// Presence is colour/motion only on the title, so a screen reader needs it spelled out here.
	val presenceDescription =
		if (limitHit) "session limit hit"
		else if (checkTerminal) "check terminal"
		else if (busy) "working"
		else statusWord
	// The clip keeps the ripple inside the card's rounded corners. A nested session card indents
	// under its spawn-point header.
	Card(
		modifier = Modifier.fillMaxWidth().padding(start = if (nested) 16.dp else 0.dp).clip(CardDefaults.shape).combinedClickable(
			onClick = {
				haptics.performHapticFeedback(HapticFeedbackType.LongPress)
				onClick()
			},
			onLongClick = {
				strong()
				onLongPress()
			},
		),
	) {
		Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
				Text(
					display,
					style = MaterialTheme.typography.titleMedium,
					fontFamily = FontFamily.Monospace,
					color = titleColor,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
					modifier = Modifier.weight(1f).clearAndSetSemantics { contentDescription = "$display, $presenceDescription" },
				)
				if (limitHit) StatusChip("limit hit", presenceColor("limit hit"))
				if (checkTerminal) StatusChip("check terminal", presenceColor("check terminal"))
				// Visible from the board without opening the thread. The dock inside the thread is
				// still the sole edit/cancel surface, this is read-only.
				if (state.scheduledSends.containsKey(team.name)) {
					Icon(
						Icons.Default.Schedule,
						contentDescription = "Scheduled send pending",
						tint = MaterialTheme.colorScheme.onSurfaceVariant,
						modifier = Modifier.size(16.dp),
					)
				}
				// Plugin-version chip: shown only when the agent's running plugin differs from
				// this app's expected version (BuildConfig.VERSION_NAME, derived from the same
				// package.json the build reads). Not a warning - the host auto-updates daily, so
				// a lag is benign and self-correcting. Neutral color, version only, no label.
				team.version?.let { v ->
					if (v != BuildConfig.VERSION_NAME) StatusChip("v$v", MaterialTheme.colorScheme.outline)
				}
				if (unread > 0) Badge { Text("$unread") }
			}
			if (busy) PulseBar(pulsePhase)
			// The ladder, top down: the session's own last reply headline, then its unfinished board
			// work, then the thread's newest row. sessionCardPreview owns which of those show and what
			// each is stamped with; this only paints what it answered.
			val preview = sessionCardPreview(state, team.name, boardLine, boardBranch)
			preview.headline?.let { headline ->
				Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
					Text(
						headline,
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
						modifier = Modifier.weight(1f),
					)
					preview.headlineAt?.let {
						Text(
							relativeTime(it),
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
			val liveBoardWork = preview.boardWork
			if (liveBoardWork != null) {
				// The branch when there is one, else the single line it replaces. The count rides the FIRST
				// row either way, and counts the whole session rather than the shown branch, so it does not
				// change meaning with which branch happens to be current.
				val branch = preview.boardBranch
				if (branch == null) {
					BoardCardRow(liveBoardWork.state, liveBoardWork.title, depth = 0) {
						BoardCardCount(liveBoardWork)
					}
				} else {
					branch.rows.forEachIndexed { index, row ->
						BoardCardRow(row.entry.state, oneLine(row.entry.title).orEmpty(), row.depth) {
							if (index == 0) BoardCardCount(liveBoardWork)
						}
					}
					if (branch.hidden > 0) {
						Text(
							"+${branch.hidden} more",
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
							modifier = Modifier.padding(start = 19.dp),
						)
					}
				}
			}
			val snippet = preview.snippet
			val timeShown = preview.snippetAt
			if (snippet != null || timeShown != null) {
				Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
					if (snippet != null) {
						Text(
							snippet,
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
							maxLines = 1,
							overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
							modifier = Modifier.weight(1f),
						)
					} else {
						Spacer(Modifier.weight(1f))
					}
					timeShown?.let {
						Text(
							relativeTime(it),
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
		}
	}
}

/** One board row on a session card. Indented a little tighter than the thread strip's, since a card
 * has a narrower column and the depth only has to be readable, not measured. */
@Composable
private fun BoardCardRow(state: String, title: String, depth: Int, trailing: @Composable () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(start = (depth * 13).dp),
		horizontalArrangement = Arrangement.spacedBy(7.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		com.atelier_nyaarium.switchboard.board.StateMark(state)
		Text(
			title,
			style = MaterialTheme.typography.bodySmall,
			textDecoration = if (state == "cancelled") TextDecoration.LineThrough else null,
			maxLines = 1,
			overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		trailing()
	}
}

@Composable
private fun BoardCardCount(line: com.atelier_nyaarium.switchboard.board.BoardLiveLine) {
	Text(
		"${line.finished}/${line.total}",
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}
