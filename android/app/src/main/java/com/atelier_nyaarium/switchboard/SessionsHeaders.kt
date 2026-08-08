package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceSession

////////////////////////////////
//  Composables

@Composable
fun HealthHeader(state: ChatState) {
	val (dot, label) = when {
		// Enrolled but no Gateway admitted yet is an ONBOARDING state, not a red error: the board
		// body owns the Add-a-Gateway CTA, so the header stays a calm positive status (no duplicate).
		state.needsGateway -> Color(0xFF0969DA) to "Enrolled"
		state.health == ChatState.Health.ONLINE -> STATUS_GREEN to "Bridge online"
		// Calm blue while a fresh enrollment's allowlist is still syncing to its Gateway -
		// a normal, self-healing window, not an error.
		state.health == ChatState.Health.SYNCING -> Color(0xFF0969DA) to (state.error ?: "Finishing enrollment...")
		// Show the SPECIFIC classified cause (set by classifyConnError) rather than a
		// blanket label, so the header tells the human exactly what to fix.
		state.health == ChatState.Health.DEGRADED -> STATUS_AMBER to (state.error ?: "Reconnecting...")
		else -> Color(0xFFCF222E) to (state.error ?: "Offline")
	}
	Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
			Spacer(Modifier.width(8.dp))
			Text(label, style = MaterialTheme.typography.labelLarge)
			Spacer(Modifier.width(6.dp))
			// This app's own version, right by the status, so the running build is visible at a glance.
			Text(
				"v${BuildConfig.VERSION_NAME}",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				fontFamily = FontFamily.Monospace,
			)
			Spacer(Modifier.weight(1f))
			if (state.deviceName.isNotEmpty()) {
				Text(
					state.deviceName,
					style = MaterialTheme.typography.labelMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					fontFamily = FontFamily.Monospace,
				)
			}
		}
	}
}

////////////////////////////////
//  Functions & Helpers

/** The base board/thread word for a wire status, before any working/waking/login refinement. The
 * single owner of the status-word vocabulary; pair with presenceColor for the chip color. */
internal fun statusWord(status: String): String = when (status) {
	"online" -> "live"
	"verifying" -> "verifying"
	"available" -> "available"
	else -> "ended"
}

// Shared status-color tokens: presenceColor, HealthHeader, and crossDomainFreshnessColor all converge
// on live/caution semantics - named once so a future rebrand can't update one copy and miss another.
private val STATUS_GREEN = Color(0xFF2EA043)
private val STATUS_AMBER = Color(0xFFD29922)

////////////////////////////////
//  Composables

/** Chip color for the board/thread presence vocabulary. */
@Composable
internal fun presenceColor(presence: String): Color = when (presence) {
	"live" -> STATUS_GREEN
	"working...", "waking...", "verifying" -> STATUS_AMBER
	"available" -> Color(0xFF0969DA)
	"check terminal", "limit hit" -> Color(0xFFDA3633)
	else -> MaterialTheme.colorScheme.outline
}

@Composable
internal fun StatusChip(text: String, color: Color) {
	Surface(color = color.copy(alpha = 0.16f), shape = MaterialTheme.shapes.small) {
		Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.size(7.dp).clip(CircleShape).background(color))
			Spacer(Modifier.width(5.dp))
			Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
		}
	}
}

/** A chevron-driven, collapsible section header with a trailing slot the caller owns entirely (a
 * Create button, online/offline label, freshness chip). Shared by GatewayHeader and LinkedFriendHeader. */
@Composable
private fun CollapsibleSectionHeader(
	name: String,
	collapsed: Boolean,
	onToggle: () -> Unit,
	trailing: @Composable () -> Unit,
) {
	Row(
		Modifier
			.fillMaxWidth()
			.clip(MaterialTheme.shapes.small)
			.hapticClickable(onClick = onToggle)
			.padding(horizontal = 4.dp, vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		// Down when open, right when collapsed: the chevron points at where the content is, or at
		// where it would appear. Auto-mirrored so it points left in an RTL layout.
		Icon(
			if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Default.ExpandMore,
			contentDescription = if (collapsed) "Expand" else "Collapse",
			tint = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Spacer(Modifier.width(10.dp))
		Text(
			name,
			style = MaterialTheme.typography.titleMedium,
			fontFamily = FontFamily.Monospace,
			maxLines = 1,
			overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		trailing()
	}
}

@Composable
internal fun GatewayHeader(
	name: String,
	online: Boolean,
	collapsed: Boolean,
	onToggle: () -> Unit,
	showCreate: Boolean = false,
	onCreate: (() -> Unit)? = null,
) {
	CollapsibleSectionHeader(name, collapsed, onToggle) {
		if (showCreate && onCreate != null) {
			// Your own Gateway only - a contained button (not a bare icon) reads as tappable on sight.
			// Its own click region wins over the row's collapse-toggle for taps landing inside it.
			Button(onClick = hapticClick(onCreate)) {
				Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
				Spacer(Modifier.width(6.dp))
				Text("Create")
			}
		} else {
			Text(
				if (online) "online" else "offline",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

////////////////////////////////
//  Functions & Helpers

private fun crossDomainFreshnessColor(freshness: CrossDomainFreshness): Color =
	when (freshness) {
		CrossDomainFreshness.FRESH -> STATUS_GREEN
		CrossDomainFreshness.STALE -> STATUS_AMBER
		CrossDomainFreshness.UNKNOWN -> Color(0xFF8B949E) // neutral gray - not yet judgeable, not a warning
	}

private fun crossDomainFreshnessLabel(freshness: CrossDomainFreshness): String =
	when (freshness) {
		CrossDomainFreshness.FRESH -> "fresh"
		CrossDomainFreshness.STALE -> "stale"
		CrossDomainFreshness.UNKNOWN -> "unknown"
	}

////////////////////////////////
//  Composables

/** A linked friend Domain's collapsible header - the freshness-chip analog of GatewayHeader's binary
 * online/offline text, since a friend's currency is a 3-state judgment (fresh/stale/unknown), not up-or-down. */
@Composable
internal fun LinkedFriendHeader(name: String, freshness: CrossDomainFreshness, collapsed: Boolean, onToggle: () -> Unit) {
	CollapsibleSectionHeader(name, collapsed, onToggle) {
		StatusChip(crossDomainFreshnessLabel(freshness), crossDomainFreshnessColor(freshness))
	}
}

/** One of a linked friend's shared sessions - display-only (no click-through; this board section
 * shows what a friend has shared, it does not open a chat with their session). */
@Composable
internal fun LinkedFriendSessionRow(session: CrossDomainPresenceSession) {
	Row(
		Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Column(Modifier.weight(1f)) {
			Text(
				session.sessionLabel ?: session.team,
				style = MaterialTheme.typography.bodyMedium,
				maxLines = 1,
				overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			)
			session.description?.let {
				Text(
					it,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
				)
			}
		}
		Text(
			statusWord(session.status),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
}

/** A devcontainer project's spawn-point row: a purely informational display. Creating a session
 * happens via the Gateway row's Create button. The project itself is never a chat (clean break). */
@Composable
internal fun SpawnPointHeader(project: String, online: Boolean) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text(project, style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace)
		Spacer(Modifier.weight(1f))
		Text(
			if (online) "awake" else "asleep",
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
}

@Composable
fun SectionLabel(text: String) {
	Text(
		text.uppercase(),
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		letterSpacing = androidx.compose.ui.unit.TextUnit(1.5f, androidx.compose.ui.unit.TextUnitType.Sp),
		modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 2.dp),
	)
}
