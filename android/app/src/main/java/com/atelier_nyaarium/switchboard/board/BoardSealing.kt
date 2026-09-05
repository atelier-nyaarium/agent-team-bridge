package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.PhoneAmbient
import com.atelier_nyaarium.switchboard.PhoneBootstrap
import com.atelier_nyaarium.switchboard.crypto.BOARD_BODY_KIND
import com.atelier_nyaarium.switchboard.crypto.BOARD_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.ContentSealing
import com.atelier_nyaarium.switchboard.crypto.boardTextAadKind

const val BOARD_KIND_TITLE = BOARD_TITLE_KIND
const val BOARD_KIND_BODY = BOARD_BODY_KIND

// Match boardTextAadKind byte for byte; revision stays unbound.
open class BoardSealing(
	boot: PhoneBootstrap,
	ambient: PhoneAmbient,
	onMissingEpoch: (Int) -> Unit,
) : ContentSealing(boot, ambient, { kind, entryId -> boardTextAadKind(kind, entryId) }, onMissingEpoch)
