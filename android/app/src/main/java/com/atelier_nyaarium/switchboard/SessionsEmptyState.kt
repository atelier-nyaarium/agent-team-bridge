package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

////////////////////////////////
//  Functions & Helpers

/**
 * Whether [EmptyBoard] has a real not-yet-working state to report, rather than its bare "nothing here
 * yet" fallback.
 *
 * The sessions board asks before drawing an admitted-but-idle Gateway's section: those states are
 * exactly the ones where a Create button would offer an action that cannot be delivered. Lives beside
 * EmptyBoard and mirrors its own branch order, so a new cause is added to both at once.
 */
internal fun emptyBoardHasCause(state: ChatState): Boolean =
	state.noGatewayState != NoGatewayState.NONE ||
		state.status == "error" ||
		state.enrollingSince != 0L ||
		!state.connected ||
		state.pollFailStreak > 0

////////////////////////////////
//  Composables

/** The single status surface when the board has no sessions (HealthHeader is hidden in this state);
 * exactly one branch renders, keyed on connection state. A terminal cause is checked before the spinners. */
@Composable
internal fun EmptyBoard(
	state: ChatState,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onRefresh: () -> Unit,
	onVerifyEnroll: (() -> Unit)? = null,
	// Reaching a self-hosted Router is a precondition for having any Gateway at all, so the entry
	// point belongs here too and not only behind Settings.
	onRouterEndpoint: (() -> Unit)? = null,
) {
	Column(
		Modifier.fillMaxSize().padding(32.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		when {
			// A friend who just first-rooted has no host of their own yet (the invite omits gateway
			// ids by design), and the admin's own fresh provision first-roots too - so both land
			// here. Add a Gateway goes straight to the scanner; the friend with no computer yet still has
			// the body's "set up a computer" guidance.
			state.noGatewayState == NoGatewayState.AWAITING_HOST -> {
				Text("You're all set up", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("Your Domain is ready. Set up a computer to run your agents, then add its Gateway here.")
				// An outstanding in-person trust compare (the admin who invited you is waiting) takes the
				// primary slot; adding a Gateway becomes the secondary step.
				if (onVerifyEnroll != null) {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onVerifyEnroll)) { Text("Verify with the admin") }
					Spacer(Modifier.height(4.dp))
					TextButton(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				} else {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				}
			}
			// No Gateway admitted yet: the primary onboarding step goes straight to the scanner, with the
			// setup manual as the secondary step.
			state.noGatewayState == NoGatewayState.NEEDS_GATEWAY -> {
				Text("No Gateways yet", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("The computer that runs your agents.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onHostHelp)) { Text("Running Gateway Setup") }
				if (onRouterEndpoint != null) {
					TextButton(onClick = hapticClick(onRouterEndpoint)) { Text("Set the Router address") }
				}
			}
			// A terminal failure that will not self-heal (secure storage, 401, admission rejected, or
			// an enrollment that gave up past the grace window). Name the actual cause from `error`
			// and offer a way forward - never "see the banner above", which is not on screen here.
			state.status == "error" -> {
				Text("Can't connect", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody(state.error ?: "Couldn't reach your Gateway.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onRefresh)) { Text("Try again") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onManage)) { Text("Gateways") }
			}
			// Mid-enrollment, still self-healing: the poll loop keeps retrying and clears it on the
			// first success; past the grace window it escalates into the terminal branch above.
			state.enrollingSince != 0L -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Setting up...", style = MaterialTheme.typography.titleMedium)
				Spacer(Modifier.height(4.dp))
				BoardBody("Finishing enrollment with your Gateway.")
			}
			// Establishing the connection for the first time. A transient cause (no network, server
			// unreachable) is set on state.error by classifyConnError; surface it under the spinner so
			// a fresh friend with no network sees "Offline - no network", not a bare endless spinner.
			!state.connected -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Connecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
				state.error?.takeIf { it.isNotBlank() }?.let {
					Spacer(Modifier.height(8.dp))
					BoardBody(it)
				}
			}
			// Connected but the recent polls failed: online-ish, quietly reconnecting. Show the
			// classified cause when one is set, so a transient stall is named rather than silent.
			state.pollFailStreak > 0 -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Reconnecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
				state.error?.takeIf { it.isNotBlank() }?.let {
					Spacer(Modifier.height(8.dp))
					BoardBody(it)
				}
			}
			// Connected and healthy, just nothing here yet.
			else -> Text("No active sessions yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** Centered, muted body copy shared by the empty-board states. */
@Composable
private fun BoardBody(text: String) {
	Text(
		text,
		style = MaterialTheme.typography.bodyMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		textAlign = TextAlign.Center,
	)
}
