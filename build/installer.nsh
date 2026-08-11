; BenHazmanim - custom NSIS installer script
; ---------------------------------------------------------------------------
; Why this exists:
;   The app runs a watchdog that respawns it within seconds if killed, and it
;   may run elevated (admin) - so a normal installer's taskkill cannot stop it.
;   The app cooperates with a "quit.flag" file: when the flag exists, both the
;   main process and the watchdog exit silently on their own.
;
;   IMPORTANT: electron-builder checks whether the app is running BEFORE our
;   customInit macro runs (allowOnlyOneInstallerInstance), and if the kill
;   fails it shows "cannot be closed" and aborts. So we must write quit.flag
;   in preInit - which runs BEFORE that check - and then give the app a few
;   seconds to notice it and exit on its own.
;
;   Also: the flag must be written to EVERY location the app checks. The app
;   resolves its userData dir from the FULL productName in package.json
;   ("בין הזמנים - ניהול זמן מחשב"), while the NSIS ${PRODUCT_NAME} comes
;   from the build config ("בין הזמנים"). We write to both, plus a stable
;   ASCII path (%APPDATA%\BenHazmanim) that newer versions always check.
;
; NOTE: this file is UTF-8 with BOM so the Hebrew path compiles correctly.

!macro preInit
  ; write quit.flag into every location the app may check, BEFORE
  ; electron-builder tries to close the running app (preInit runs before
  ; allowOnlyOneInstallerInstance).
  CreateDirectory "$APPDATA\BenHazmanim"
  FileOpen $0 "$APPDATA\BenHazmanim\quit.flag" w
  FileWrite $0 "installer"
  FileClose $0
  CreateDirectory "$APPDATA\בין הזמנים - ניהול זמן מחשב"
  FileOpen $0 "$APPDATA\בין הזמנים - ניהול זמן מחשב\quit.flag" w
  FileWrite $0 "installer"
  FileClose $0
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $0 "$APPDATA\${PRODUCT_NAME}\quit.flag" w
  FileWrite $0 "installer"
  FileClose $0
  ; also stop the SYSTEM watchdog (BenHazmanimGuard, runs from the protected
  ; copy in %ProgramData%\BenHazmanim\app) so it won't restore files/tasks
  ; while the installer is replacing them
  ReadEnvStr $R0 "PROGRAMDATA"
  CreateDirectory "$R0\BenHazmanim"
  FileOpen $0 "$R0\BenHazmanim\quit.flag" w
  FileWrite $0 "installer"
  FileClose $0
  ; The SYSTEM guard is a separate process and is not covered by the normal
  ; app wait loop. End its scheduled instance before replacing the protected
  ; copy; otherwise it can keep files locked during an upgrade.
  nsExec::Exec 'schtasks /End /TN BenHazmanimGuard'
  ; give the app (checks the flag every ~3s) time to exit on its own, so the
  ; installer's own kill-loop finds it already stopped. Only wait while the
  ; process actually exists (up to ~8s), so fresh installs are not slowed down.
  StrCpy $R4 0
  WaitAppExit:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R5
    ${If} $R5 != 0
      Goto AppExited
    ${EndIf}
    IntOp $R4 $R4 + 1
    ${If} $R4 >= 16
      Goto AppExited
    ${EndIf}
    Sleep 500
    Goto WaitAppExit
  AppExited:
!macroend

; On uninstall: clean up everything the app created outside its install dir.
; The app also triggers this uninstaller itself (password-protected) after it
; has already stopped its watchdog and removed the startup entries - these
; lines are the safety net for uninstalls done from Control Panel / Settings.
!macro customUnInstall
  ; write quit.flag so the watchdog won't respawn the app during uninstall
  ; (also covers uninstalls done from Control Panel / Settings)
  CreateDirectory "$APPDATA\BenHazmanim"
  FileOpen $0 "$APPDATA\BenHazmanim\quit.flag" w
  FileWrite $0 "uninstaller"
  FileClose $0
  CreateDirectory "$APPDATA\בין הזמנים - ניהול זמן מחשב"
  FileOpen $0 "$APPDATA\בין הזמנים - ניהול זמן מחשב\quit.flag" w
  FileWrite $0 "uninstaller"
  FileClose $0
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $0 "$APPDATA\${PRODUCT_NAME}\quit.flag" w
  FileWrite $0 "uninstaller"
  FileClose $0
  ; stop the SYSTEM watchdog too (it monitors %ProgramData%\BenHazmanim)
  ReadEnvStr $R0 "PROGRAMDATA"
  CreateDirectory "$R0\BenHazmanim"
  FileOpen $0 "$R0\BenHazmanim\quit.flag" w
  FileWrite $0 "uninstaller"
  FileClose $0
  ; Stop and remove the SYSTEM guard before deleting its protected copy.
  ; /Delete alone does not reliably terminate an already-running instance.
  nsExec::Exec 'schtasks /End /TN BenHazmanimGuard'
  nsExec::Exec 'schtasks /Delete /TN BenHazmanimGuard /F'
  ; remove the shared per-machine settings (%ProgramData%\BenHazmanim)
  ; ($PROGRAMDATA / $COMMONAPPDATA are not available in the NSIS version
  ; bundled with electron-builder 26, so expand the env var through cmd)
  nsExec::Exec 'cmd /c rmdir /s /q "%PROGRAMDATA%\BenHazmanim"'
  ; remove startup entries created by the app (Run keys + scheduled task)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BenHazmanim"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "BenHazmanim"
  nsExec::Exec 'schtasks /Delete /TN BenHazmanim /F'
  ; remove the internet-block firewall rule created by the app (if any),
  ; so uninstalling never leaves the machine with no internet
  nsExec::Exec 'netsh advfirewall firewall delete rule name=BenHazmanimNetBlock'
  ; undo the "hide accounts page" policy applied at runtime when elevated
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" "SettingsPageVisibility"
  ; clean up the quit flags we wrote (and any stale ones)
  Delete "$APPDATA\BenHazmanim\quit.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\quit.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\quit.flag"
  ; clean up any leftover relaunch flags (no app left to clear them)
  Delete "$APPDATA\BenHazmanim\relaunch.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\relaunch.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\relaunch.flag"
!macroend

; After a SILENT install (/S) NSIS skips its own "run after finish" step, so
; the updated app would never reopen on its own. The app writes relaunch.flag
; (next to quit.flag, in the same stable paths) right before it triggers the
; update; if we find it here - after the new files are in place - we launch the
; freshly installed app ourselves and clean the flag up. Runs inside the
; install section, after installApplicationFiles, so $launchLink is valid.
!macro customInstall
  IfFileExists "$APPDATA\BenHazmanim\relaunch.flag" 0 relaunchDone
    Delete "$APPDATA\BenHazmanim\relaunch.flag"
    Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\relaunch.flag"
    Delete "$APPDATA\${PRODUCT_NAME}\relaunch.flag"
    ExecShell "" "$launchLink"
  relaunchDone:
!macroend
