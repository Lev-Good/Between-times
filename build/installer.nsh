; BenHazmanim - custom NSIS installer script
; ---------------------------------------------------------------------------
; Why this exists:
;   The app runs a watchdog that respawns it within seconds if killed, and it
;   may run elevated (admin) - so a normal installer's taskkill cannot stop it.
;   The app already cooperates with a "quit.flag" file: when the flag exists,
;   both the main process and the watchdog exit silently on their own.
; Fix:
;   Before the installer tries to close the running app, write quit.flag into
;   the app's userData dir (%APPDATA%\<PRODUCT_NAME>). The app sees it within
;   ~1-3 seconds and exits cleanly, so the update install succeeds even while
;   the old version is still running in the background.
; NOTE: keep this file ASCII-only (no Hebrew) - NSIS encoding pitfalls.

!macro customInit
  ; write quit.flag so the watchdog won't respawn the app during install
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $0 "$APPDATA\${PRODUCT_NAME}\quit.flag" w
  FileWrite $0 "installer"
  FileClose $0
!macroend

; On uninstall: clean up everything the app created outside its install dir.
; The app also triggers this uninstaller itself (password-protected) after it
; has already stopped its watchdog and removed the startup entries - these
; lines are the safety net for uninstalls done from Control Panel / Settings.
!macro customUnInstall
  ; write quit.flag so the watchdog won't respawn the app during uninstall
  ; (also covers uninstalls done from Control Panel / Settings)
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $0 "$APPDATA\${PRODUCT_NAME}\quit.flag" w
  FileWrite $0 "uninstaller"
  FileClose $0
  ; remove the shared per-machine settings (%ProgramData%\BenHazmanim)
  ; ($PROGRAMDATA / $COMMONAPPDATA are not available in the NSIS version
  ; bundled with electron-builder 26, so expand the env var through cmd)
  nsExec::Exec 'cmd /c rmdir /s /q "%PROGRAMDATA%\BenHazmanim"'
  ; remove startup entries created by the app (Run keys + scheduled task)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BenHazmanim"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "BenHazmanim"
  nsExec::Exec 'schtasks /Delete /TN BenHazmanim /F'
  ; undo the "hide accounts page" policy applied at runtime when elevated
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" "SettingsPageVisibility"
!macroend
