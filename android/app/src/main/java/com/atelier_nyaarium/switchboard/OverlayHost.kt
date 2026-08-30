package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.Composable
import com.atelier_nyaarium.switchboard.board.BoardEditScreen
import com.atelier_nyaarium.switchboard.board.BoardEntryDialog

/** Paints the overlay on top of the stack. Every variant closes by popping and opens by pushing,
 * so a screen can only dismiss itself and always keeps the way back. */
@Composable
fun OverlayHost(
	overlay: Overlay,
	repo: ChatRepository,
	state: ChatState,
	open: (Overlay) -> Unit,
	close: () -> Unit,
) {
	when (overlay) {
		is Overlay.AdminCeremony ->
			EnrollCeremonyScreen(
				repo = repo,
				ctx = overlay.ctx,
				inviteBlob = overlay.inviteBlob,
				peerLabel = overlay.peerLabel.ifEmpty { "the new user" },
				onDone = close,
				onCancel = close,
			)

		is Overlay.EnrolleeCeremony ->
			EnrollCeremonyScreen(
				repo = repo,
				ctx = overlay.ctx,
				inviteBlob = null,
				peerLabel = "the admin",
				onDone = {
					repo.ceremony.markEnrolleeCeremonyDone()
					close()
				},
				onCancel = close,
			)

		Overlay.LinkWizard -> LinkWizard(repo = repo, onDone = close, onCancel = close)

		is Overlay.HostTenant ->
			HostedTenantDetailScreen(
				repo = repo,
				domainId = overlay.domainId,
				onBack = close,
				onRemoved = close,
				onLink = { open(Overlay.LinkWizard) },
				onVerify = { blob, label ->
					repo.ceremony.adminEnrollContext(overlay.domainId)?.let {
						open(Overlay.AdminCeremony(it, blob, label))
					}
				},
			)

		Overlay.HostNetworks ->
			HostNetworksScreen(repo = repo, onBack = close, onTenant = { open(Overlay.HostTenant(it)) })

		Overlay.Users ->
			UsersScreen(
				repo = repo,
				onBack = close,
				onEnrollUser = { open(Overlay.HostNetworks) },
				onLink = { open(Overlay.LinkWizard) },
				onHostNetworks = { open(Overlay.HostNetworks) },
				onAddGateway = { open(Overlay.AddGateway) },
			)

		Overlay.Approval -> ApprovalWindowScreen(repo = repo, onBack = close)

		Overlay.YourDevices ->
			YourDevicesScreen(repo = repo, onBack = close, onAddDevice = { open(Overlay.Approval) })

		Overlay.AddGateway -> AddGatewayScreen(repo = repo, onBack = close, onDone = close)

		Overlay.HostHelp -> HostSetupHelpScreen(onBack = close)

		is Overlay.Sharing -> SharingScreen(repo = repo, gatewayId = overlay.gatewayId, onBack = close)

		Overlay.Manage ->
			GatewaysScreen(
				repo = repo,
				teams = state.teams,
				onBack = close,
				onAddGateway = { open(Overlay.AddGateway) },
				onManageSharing = { gid -> open(Overlay.Sharing(gid)) },
			)

		is Overlay.BoardEdit ->
			BoardEditScreen(
				repo = repo,
				gatewayId = overlay.gatewayId,
				entryId = overlay.entryId,
				onClose = close,
			)

		is Overlay.BoardEntryModal ->
			BoardEntryDialog(
				repo = repo,
				gatewayId = overlay.gatewayId,
				entryId = overlay.entryId,
				onClose = close,
			)
	}
}
