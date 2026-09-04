# Migration and Release Gate: 1.5.10 to 1.6.0

## Schema Migration

Version 1.6.0 introduces `schemaVersion: 2`. Loading a 1.5.10 settings file is silent and additive:

- Existing `enabled`, `mode`, `warnMinutes`, PIN records, schedule slots, overrides, allowed apps, recovery email, theme, messages, and update settings are preserved.
- New fields receive safe defaults: `studyMode.enabled=false`, empty website/profile lists, restricted explorer disabled, accountability disabled, partner approval disabled, and `coolOffMinutes=0`.
- `manualUnlockUntil` remains session-only and is cleared on startup as before.
- Legacy plaintext/encrypted recoverable password fields remain removed; PIN storage remains PBKDF2-SHA256 with a random salt.
- On an elevated managed Windows load, the normalized v2 policy is written atomically to `%ProgramData%\BenHazmanim\settings.json` and copied to the protected backup. A corrupt source still fails closed.
- Profile overlays are computed at enforcement time and are never written over the shared base policy. Sensitive fields cannot be overridden by a profile.

The migration is covered by `test/schema-v2.test.js` and the managed-load integration test in `test/main-flow.test.js`.

## New Policy Fields

```json
{
  "schemaVersion": 2,
  "studyMode": { "enabled": false, "scope": "blocked" },
  "websiteApps": [],
  "fileExplorer": {
    "enabled": false,
    "roots": ["documents", "downloads"],
    "readonlyLibrary": true,
    "hiddenTypes": [],
    "libraryPath": ""
  },
  "accountabilityEmail": "",
  "accountabilityEnabled": false,
  "accountabilityRequireApproval": false,
  "coolOffMinutes": 0,
  "profiles": [],
  "defaultProfile": null
}
```

Profiles are normalized records keyed by a stable `id`; automatic profiles also carry a lowercase Windows `user`, while manual profiles may omit it. `defaultProfile` references a profile ID.

## Release Procedure (Free & Secure via SHA-256)

1. The project uses cryptographic SHA-256 hashing and GitHub Release official origin checks for updates without requiring commercial Authenticode certificates.
2. (Optional) If an Authenticode code-signing certificate is available in the future, it can be loaded into `CSC_LINK` and `CSC_KEY_PASSWORD`, and verified.
3. Run `npm test` and require zero failures (118/118 tests).
4. Run `npm run dist`.
5. Compute SHA-256 over the installer: `(Get-FileHash .\dist\Setup.1.6.0.exe -Algorithm SHA256).Hash.ToLower()`.
6. Update `version.json` with the SHA-256, version, and notes, and push to GitHub.
7. Upload the installer to GitHub Release `v1.6.0`.
8. Installed clients automatically discover, download, verify SHA-256, install, and relaunch. See [UPDATES-AND-SECURITY.md](UPDATES-AND-SECURITY.md) for full details.

## Mandatory VM Matrix

These checks manipulate live processes, Windows sessions, UAC, firewall rules, ACLs, startup tasks, and SmartScreen. They must be performed in disposable VMs; automated mocks do not replace them.

### Windows Home stability

- Windows 10 Home and Windows 11 Home, current patches.
- Fresh install, upgrade from 1.5.10, reboot, sign out/in, sleep/resume, and uninstall from inside the app.
- Verify shared settings and protected copy are created, watchdogs recover after killing the interactive process, and no boot/login loop occurs.

### Approved Apps Only

- Test both `scope=always` and `scope=blocked`.
- Approve one signed app (publisher/product) and one unsigned app (path + SHA-256).
- Verify approved apps survive, renamed/copied substitutes are terminated, unsigned app updates fail closed until re-approved, and non-approved browsers/games close within the polling interval.
- Verify Explorer, Start menu, DWM, audio, input, Defender, logon, UAC, Settings shell, networking, printing, and shutdown/restart remain stable.
- Test an empty approved list and confirm Windows remains usable while user applications close.
- Record maximum observed launch-to-termination gap; this is a documented userland limitation.

### Multi-user sessions

- Standard user and administrator simultaneously signed in using Fast User Switching.
- Confirm each interactive process enforces only its own Windows Session and never terminates applications in the other session.
- Confirm the same shared base policy applies to administrator and standard accounts, while automatic username profiles select the correct overlay.
- Kill/restart the app independently in both sessions and verify watchdog recovery without duplicate governor actions.

### Locked sites and explorer

- Verify exact host and approved subdomain navigation; block look-alike domains, external redirects, popups, permissions, downloads, `file:`, `data:`, and `javascript:` URLs.
- Verify restricted explorer roots, nested folders, Unicode names, hidden extensions, UNC library paths, junction/symlink escape attempts, and read-only library behavior.
- Verify remote content has no preload/Node access and the explorer CSP reports no blocked executable script.

### Accountability and cool-off

- Partner disabled by default.
- Recovery code reaches both configured addresses when enabled; unlock approval reaches only the partner.
- Partner approval code is one-time and expires; PIN changes/recovery notify the partner without exposing a password.
- Cool-off remains blocked until expiry, survives sleep/resume in the same process, and is cancelled by a new manual lock.

### Signing and SmartScreen

- Verify installer and installed executable signatures, timestamp validity, publisher display in UAC, and no unknown-publisher prompt.
- Test download/run from Edge on a clean VM. Record SmartScreen result; a valid signature improves identity/reputation but does not guarantee immediate reputation for a new certificate.

## Automated Gate

Current automated command:

```powershell
npm test
```

It covers scheduler/schema migration, profile overlays, PowerShell quoting, recovery regex, accountability, cool-off, governor process classification, locked-site hardening, explorer sandbox/hidden types, Authenticode update rejection, IPC sender validation, and the existing Electron block-screen E2E flow.
