package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.PhoneAmbient
import com.atelier_nyaarium.switchboard.PhoneBootstrap
import com.atelier_nyaarium.switchboard.crypto.ContentSealing
import com.atelier_nyaarium.switchboard.crypto.vaultAadKind

/** Sole sealer and opener of vault fields on the phone; `id` is the entry id, or the request id for a typed value. */
open class VaultSealing(
	boot: PhoneBootstrap,
	ambient: PhoneAmbient,
	onMissingEpoch: (Int) -> Unit,
) : ContentSealing(boot, ambient, ::vaultAadKind, onMissingEpoch)
