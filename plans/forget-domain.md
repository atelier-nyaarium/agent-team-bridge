# Forget this Domain

A local-only wipe in the app, reachable by everyone, so a phone can take a new setup code after
`setup.sh` option 0 (Purge Federation) without clearing the app's storage from Android Settings, and
so a second device can leave a Domain without deleting it.

## Why it was missing

- `MainActivity.kt:170` imports a scanned setup code only while `!state.provisioned`.
- The only wipe in the app was behind "Revoke and Delete Domain" (`SettingsSystem.kt`), gated by
  `canDeleteOwnDomain()` = `!isAdmin() && confirmedDomainId() != null`. Hidden from admins on purpose:
  it also owner-signs a `delete_domain` op, and setup.sh is the admin's purge path.
- So after option 0 an admin's phone was stranded, and option 0 printed "Clear storage".

## The fact that shapes the dialog

The owner key is generated on the first phone (`FederationManager.ownerIdentity`) and the ONLY other
way one reaches a device is `importOwnerBackup` with a passphrase. Add-a-device (`DeviceApprovalOps`)
hands the new device a console admission and the keyring, never the owner key. So:

- On the first phone (or one that imported the backup), Forget destroys the only private key unless a
  backup exists. Done BEFORE option 0, it leaves a rooted Domain on the Router that nobody can sign
  for: no admits, no revokes, and Router Setup reads it as "already set up" and emits a code with no
  `pendingTenant`, which a fresh phone cannot first-root. The way out is option 0 (which finds the
  Domain from the Router's own mark since 8.3.27) or a restored backup.
- On an admitted second console there is no owner key to lose, and nothing about the Domain changes.

The dialog branches on that, through `FederationManager.holdsDomainOwnerKey()`: the stored owner
identity, read WITHOUT minting (`ownerIdentity()` seats a throwaway root on an absent key, which is
exactly the second-console case), compared against the keyring's own root so a throwaway already
minted does not count as holding it. A stored key with no stored snapshot answers HOLDER: that is the
first phone before its first keyring sync (a second console is handed its snapshot at approval), and
the wrong answer there would show the harmless warning over the only copy of the key.

## What

**Settings > System > Danger > "Forget this Domain"**, unconditional: the screen exists only on a
provisioned app. Revoke and Delete keeps its own gate beside it for app-only owners.

Subtitle: "Wipes this phone only. The Domain, your gateways and your other devices are untouched.
Voice settings are kept."

Tap, then `requireOwnerPresent(biometricLock, activity)` on confirm (the same gate as every owner-key
action), then `repo.domainAdmin.forgetDomain()` = `repo.clearAll()` on IO and nothing else. No wire
op, no signature, no new schema. Then the same `onClear` (`MainActivity.kt`) that Delete Domain uses.

The dialog, common part: this wipes the app on this phone (history, drafts, board cache, downloaded
files, speech cache); nothing is deleted from the Router. Holder branch: the owner key lives on this
phone plus any exported backup; without a copy nothing new can ever be owner-signed for this Domain;
run Purge Federation on the Router machine or export a backup first (Settings > Domain & Trust >
Federation > Owner key backup). Non-holder branch: this phone does not hold the owner key, nothing
about the Domain changes, the device stays listed under Your devices until removed there.

## What the wipe covers

`clearAll` (`ChatRepositoryDomainLink.kt`): `drain.stopAndJoin()`, `clearProvisioning` (exactly
`PROVISIONING_KEYS`), every `ClearsOnReprovision` holder, TTS cache, attachment bytes, state reset,
scheduled-send alarm. Settings-owned prefs survive by omission (lock, STTS, plugin toggles, playback
prefs, save folder). Outside it, `onClear` runs the plugin `accountWipeHandlers` (the Designer index).

Two things the wipe did NOT cover before this, fixed alongside since both wipe paths share them:

- **Playback.** `PlaybackOps` was not a `ClearsOnReprovision`: the queue kept the old owner's entries
  and every transport surface drew them. It is one now; `clearInMemory` empties the queue, the markers
  and the pause flag under the advance mutex, and the engine is silenced by `stts.purgeAll()` in the
  same wipe.
- **Notifications.** The service stops itself on `!provisioned` BEFORE its reconcile runs, so a wiped
  phone kept message notifications that opened threads it no longer had. `onClear` now cancels the
  message and scheduled-send-failure id ranges. Never `cancelAll()`: the foreground status
  notification and the playback transport live outside both ranges and are the service's to end.
  Found while checking that claim: the transport id was 4271, INSIDE the team range, so the existing
  reconcile sweep already cancelled the lockscreen transport on every unread change until the next
  playback event re-posted it. It is 2 now, and `ServiceNotifications`' init check pins both ids
  below the range.

## Sequencing with option 0

Either order works and both must happen. Option 0 names the button, keeping the Clear storage line
as the fallback for an app older than 8.3.28, since the script and the app update on separate triggers.

## Not doing

- **Auto-offering it when polls fail after a purge.** The Router answers a deleted Domain, a revoked
  key and a bad signature with one opaque error on purpose (`routerServer.ts`), so the app cannot
  tell "purged" from "transport broken", and an offer on a transient outage invites wiping a healthy
  phone.
- **Self-revoking this device's console admission before the wipe.** The admission is inert once its
  signing key is destroyed with the device (`KEY_IDENTITY` is in `PROVISIONING_KEYS`); it matters
  only against recovery of the wiped key, which is a device-compromise story. A best-effort revoke
  would need a Router round trip that hangs offline, and "wipe anyway on failure" defeats its point.
  The admission is removable from Your devices.

## Verification

- `ClearsOnReprovisionTest.everyRepositoryFieldDeclaringAWipeIsInTheRoster` pins `PlaybackOps` into
  the roster.
- The emulator cannot run on the build machine (no `/dev/kvm` permission for the user), so the screen
  was verified by compile and review, not a screenshot. Check on device: Settings > System shows
  Forget; the dialog's owner-key paragraph appears on the admin phone; tapping Forget lands on the
  onboarding screen with an empty shade and no transport control.
