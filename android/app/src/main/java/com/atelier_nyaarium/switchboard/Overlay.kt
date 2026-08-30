package com.atelier_nyaarium.switchboard

/** Every screen above the app's base layer, held as one stack: the renderer paints its top, back
 * pops it, and a notification tap clears it, so the three cannot disagree about what is showing.
 * Never saveable: an in-progress ceremony carries key material, which stays out of the Bundle. */

////////////////////////////////
//  Interfaces & Types

sealed interface Overlay {
	data object Manage : Overlay

	/** Null gatewayId shares across every gateway; the Gateways kebab scopes it to one. */
	data class Sharing(val gatewayId: String?) : Overlay

	data object AddGateway : Overlay

	data object YourDevices : Overlay

	data object Approval : Overlay

	data object HostHelp : Overlay

	data class BoardEdit(val gatewayId: String, val entryId: String) : Overlay

	/** The same entry as a modal rather than a route, for the thread's board strip: the conversation
	 * stays behind it instead of being replaced to rename a task. */
	data class BoardEntryModal(val gatewayId: String, val entryId: String) : Overlay

	data object Users : Overlay

	data object LinkWizard : Overlay

	data object HostNetworks : Overlay

	data class HostTenant(val domainId: String) : Overlay

	/** The admin leg of the in-person compare, carrying the QR blob and the peer's label. */
	data class AdminCeremony(val ctx: EnrollCeremonyContext, val inviteBlob: String, val peerLabel: String) : Overlay

	data class EnrolleeCeremony(val ctx: EnrollCeremonyContext) : Overlay
}

////////////////////////////////
//  Functions & Helpers

/** Open [overlay] above whatever is showing. A repeat of the current top is ignored, so a double tap
 * does not cost the owner two back presses to undo. */
fun List<Overlay>.pushOverlay(overlay: Overlay): List<Overlay> =
	if (lastOrNull() == overlay) this else this + overlay

/** Close the top overlay, returning to whatever it opened from. */
fun List<Overlay>.popOverlay(): List<Overlay> = if (isEmpty()) this else dropLast(1)
