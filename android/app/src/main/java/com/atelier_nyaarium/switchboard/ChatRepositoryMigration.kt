package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import com.atelier_nyaarium.switchboard.proto.parseTarget
import kotlinx.coroutines.flow.update

// Cursor translation and self-migration wiring.

internal fun ChatRepository.wireMigration() {
	cursorTranslation = CursorTranslationOps(
		coordinator = transportCoordinator,
		journal = mutationJournal,
		address = { "owner:${localDomain()}/${federation.ownerSignPub()}" },
		heldCursor = { mailboxSync.pollParams().epoch to mailboxSync.pollParams().cursor },
		sign = { op, opId -> ownerOps.sign(op, opId) },
		send = { client().postOwnerOp(it) },
		reportError = { message -> _state.update { it.copy(error = message) } },
		commit = { gen, cursor, epoch -> socket.commitTranslation(gen, cursor, epoch) },
		ambient = ambient,
	)
	selfMigration = SelfMigration(
		records = { _state.value.scheduledSends },
		readAnchors = { _state.value.readAnchors },
		journal = mutationJournal,
		domainId = { localDomain() },
		ownerSignPub = { federation.ownerSignPub() },
		conversationId = { client().transport.credentials.conversationId },
		contentKeyring = { federation.contentKeyring() },
		target = { team, _ ->
			val parsed = parseTarget(team, localDomain(), homeGatewayId) as Address
			ScheduledTarget(parsed.domain, parsed.gateway, parsed.spawn + "." + parsed.session)
		},
		uploadFile = { file -> client().uploadBlob(Attachments.fileFor(filesDir, file.src) ?: error("missing scheduled file")) },
		sign = { op, opId -> ownerOps.sign(op, opId) },
		send = { client().postOwnerOp(it) },
		reportRead = { team, anchor ->
			val signed = ownerOps.sign(composeReportRead(team, anchor, System.currentTimeMillis()))
			if (signed == null) null else client().postOwnerOp(signed)
		},
		reportError = { message -> _state.update { it.copy(error = message) } },
		releaseLocal = { team, opId ->
			scheduled.releaseMigrated(
				team,
				opId,
				{ scheduled.scheduledSendScheduler?.cancelNext() },
				{ target ->
					_state.update { it.copy(scheduledSends = it.scheduledSends - target) }
					persistence.persistScheduledSends(_state.value.scheduledSends)
					scheduled.rearmAfterMigration()
				},
			)
		},
	)
}
