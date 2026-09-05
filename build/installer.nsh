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
  ; The app hardens its install dir with deny-delete ACLs (even for admins).
  ; The installer replaces files there — lift the deny BEFORE replacing, so
  ; upgrades keep working. The app re-applies the hardening on its first
  ; elevated run after the update.
  nsExec::Exec 'cmd /c icacls "$INSTDIR" /remove:d *S-1-1-0 /T /C'
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
  ; ---------------------------------------------------------------------------
  ; Removal is allowed ONLY from inside the app itself. The app verifies the
  ; parent password and writes a one-time token file right before spawning
  ; this uninstaller. Without a valid token the uninstaller refuses to run,
  ; so uninstalling via Control Panel / Settings / double-clicking
  ; Uninstall.exe is impossible. (The app also removes the "Add/Remove
  ; Programs" registry entry on every elevated launch, so the app is not
  ; even listed there.) This check runs FIRST — before any cleanup.
  ; ---------------------------------------------------------------------------
  ReadEnvStr $R0 "PROGRAMDATA"
  IfFileExists "$R0\BenHazmanim\uninstall.token" 0 UninstallBlocked
  Goto TokenOk
  UninstallBlocked:
    MessageBox MB_ICONSTOP|MB_OK "ההסרה אפשרית רק מתוך התוכנה (הגדרות → הסרת התוכנה)."
    Abort
  TokenOk:
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
  ; the app hardens the install dir and the protected copy with deny-delete
  ; ACLs (even for admins) — lift them so the uninstaller can remove the files
  nsExec::Exec 'cmd /c icacls "$INSTDIR" /remove:d *S-1-1-0 /T /C'
  nsExec::Exec 'cmd /c icacls "%PROGRAMDATA%\BenHazmanim\app" /remove:d *S-1-1-0 /T /C'
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
  ; The application no longer changes Windows account-page policy.
  ; clean up the quit flags we wrote (and any stale ones)
  Delete "$APPDATA\BenHazmanim\quit.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\quit.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\quit.flag"
  ; clean up any leftover relaunch flags (no app left to clear them)
  Delete "$APPDATA\BenHazmanim\relaunch.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\relaunch.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\relaunch.flag"
  Delete "$R0\BenHazmanim\relaunch.flag"
!macroend

; After a SILENT install (/S) NSIS skips its own "run after finish" step, so
; the updated app would never reopen on its own. The app writes relaunch.flag
; (next to quit.flag, in the same stable paths) right before it triggers the
; update; if we find it here - after the new files are in place - we launch the
; freshly installed app ourselves and clean the flag up. Runs inside the
; install section, after installApplicationFiles, so $launchLink is valid.
;
; The flag is checked in BOTH the user profile (%APPDATA%) and the shared
; per-machine dir (%PROGRAMDATA%\BenHazmanim), because the app may have run
; elevated (scheduled task) while the installer runs in another context - and
; in that case $APPDATA alone would miss the flag and the app would stay closed.
!macro customInstall
  StrCpy $R0 "0"
  IfFileExists "$APPDATA\BenHazmanim\relaunch.flag" 0 RelaunchCheckMachine
    StrCpy $R0 "1"
  RelaunchCheckMachine:
  ReadEnvStr $R1 "PROGRAMDATA"
  IfFileExists "$R1\BenHazmanim\relaunch.flag" 0 RelaunchCheckDone
    StrCpy $R0 "1"
  RelaunchCheckDone:
  ; Fix #5: create settings file with write access for everyone so any user can save settings
  CreateDirectory "$R1\BenHazmanim"
  IfFileExists "$R1\BenHazmanim\settings.json" SettingsExists
    FileOpen $0 "$R1\BenHazmanim\settings.json" w
    FileWrite $0 "{}"
    FileClose $0
  SettingsExists:
  nsExec::Exec 'cmd /c icacls "$R1\BenHazmanim\settings.json" /grant *S-1-5-32-545:(M)'

  ; preInit writes quit.flag so the running copy can exit. Remove it before
  ; relaunching; a normal user cannot delete the protected ProgramData copy.
  Delete "$APPDATA\BenHazmanim\quit.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\quit.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\quit.flag"
  Delete "$R1\BenHazmanim\quit.flag"
  ; An elevated update may also have set the SYSTEM guard's registry stop flag.
  ; Leaving it behind would make the new guard exit immediately after update.
  DeleteRegValue HKLM "Software\BenHazmanim" "Quit"
  nsExec::Exec 'schtasks /Run /TN BenHazmanimGuard'
  ${If} $R0 == "0"
    IfSilent skipInstallNotice 0
      MessageBox MB_ICONINFORMATION|MB_OK "התקנת 'בין הזמנים' הושלמה בהצלחה!$\r$\n$\r$\nשימו לב: התוכנה פועלת כעת ברקע במגש המערכת (ליד השעון).$\r$\n$\r$\nכדי לפתוח אותה ולהגדיר סיסמה וזמנים:$\r$\n• לחצו על סמל המנעול ליד השעון למטה (קליק ימני/שמאלי), או$\r$\n• פתחו את 'בין הזמנים' מתפריט ההתחלה או משולחן העבודה."
    skipInstallNotice:
    Goto relaunchDone
  ${EndIf}
  ; clean up all the relaunch flags we know about
  Delete "$APPDATA\BenHazmanim\relaunch.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\relaunch.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\relaunch.flag"
  Delete "$R1\BenHazmanim\relaunch.flag"
  ; launch the freshly installed app (fallback: the exe directly if the
  ; Start-menu shortcut is missing for any reason)
  ${If} ${FileExists} "$launchLink"
    ExecShell "" "$launchLink"
  ${Else}
    ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
  relaunchDone:
!macroend
; ---------------------------------------------------------------------------
; Custom License Code Verification Page (Forum Registration & Profile Code)
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
!ifndef StrContains
  !include "StrContains.nsh"
!endif

Var LicenseDialog
Var LicenseInput
Var LicenseHelpLabel
Var LicenseLink
Var LicenseErrorLabel

Function TrimString
  Exch $R0
  Push $R1
  loop_lead:
    StrCpy $R1 $R0 1
    StrCmp $R1 " " 0 check_tab_lead
    StrCpy $R0 $R0 "" 1
    Goto loop_lead
  check_tab_lead:
    StrCmp $R1 "$\t" 0 done_lead
    StrCpy $R0 $R0 "" 1
    Goto loop_lead
  done_lead:
  loop_trail:
    StrCpy $R1 $R0 1 -1
    StrCmp $R1 " " 0 check_tab_trail
    StrCpy $R0 $R0 -1
    Goto loop_trail
  check_tab_trail:
    StrCmp $R1 "$\t" 0 done_trail
    StrCpy $R0 $R0 -1
    Goto loop_trail
  done_trail:
  Pop $R1
  Exch $R0
FunctionEnd

Function OpenForumLink
  ExecShell "open" "https://editorforum.levtov.uk"
FunctionEnd

Function LicensePageCreate
  ; If silent installation, skip the interactive license page
  IfSilent SkipLicensePage 0

  ; Upgrades / Reinstall: if this PC already has a valid license, skip asking again
  ReadEnvStr $R1 "PROGRAMDATA"
  ${If} ${FileExists} "$R1\BenHazmanim\license.json"
    ClearErrors
    FileOpen $0 "$R1\BenHazmanim\license.json" r
    ${IfNot} ${Errors}
      FileRead $0 $1
      FileClose $0
      ${StrContains} $2 '"ok":true' $1
      ${If} $2 != ""
        Goto SkipLicensePage
      ${EndIf}
    ${EndIf}
  ${EndIf}

  nsDialogs::Create 1018
  Pop $LicenseDialog
  ${If} $LicenseDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "ברוכים הבאים להתקנת 'בין הזמנים - ניהול זמן מחשב'!$\r$\nהתוכנה מיועדת לחברי פורום העורכים התורניים בלבד."
  Pop $0

  ${NSD_CreateLabel} 0 32u 100% 32u "כדי להפעיל את ההתקנה עליך להזין את קוד הרישיון האישי שלך.$\r$\nאם אינך רשום עדיין, הירשם לפורום (ללא עלות). לאחר ההתחברות, קוד הרישיון יופיע בדף הפרופיל האישי שלך תחת 'רישיונות תוכנה'."
  Pop $LicenseHelpLabel

  ${NSD_CreateLink} 0 68u 100% 12u "לחץ כאן לפתיחת פורום העורכים התורניים (editorforum.levtov.uk)"
  Pop $LicenseLink
  ${NSD_OnClick} $LicenseLink OpenForumLink

  ${NSD_CreateLabel} 0 86u 100% 12u "הזן את קוד הרישיון האישי שלך (16 תווים):"
  Pop $0

  ${NSD_CreateText} 0 100u 100% 14u ""
  Pop $LicenseInput

  ${NSD_CreateLabel} 0 120u 100% 20u ""
  Pop $LicenseErrorLabel

  nsDialogs::Show
  Return

  SkipLicensePage:
    Abort
FunctionEnd

Function LicensePageLeave
  ${NSD_GetText} $LicenseInput $0

  Push $0
  Call TrimString
  Pop $R2

  ${If} $R2 == ""
    ${NSD_SetText} $LicenseErrorLabel "שגיאה: חובה להזין קוד רישיון כדי להמשיך בהתקנה."
    Abort
  ${EndIf}

  ${NSD_SetText} $LicenseErrorLabel "מאמת את קוד הרישיון מול שרת הפורום..."

  InitPluginsDir
  Delete "$PLUGINSDIR\license_resp.json"
  Delete "$PLUGINSDIR\req.json"

  FileOpen $1 "$PLUGINSDIR\req.json" w
  FileWrite $1 '{"code":"$R2","app":"ben-hazmanim"}'
  FileClose $1

  ; Run curl with --ssl-no-revoke to guarantee compatibility with NetFree / kosher internet
  nsExec::ExecToStack 'curl.exe -s --ssl-no-revoke -X POST https://editorforum.levtov.uk/api/ben-hazmanim/verify -H "Content-Type: application/json" -d "@$PLUGINSDIR\req.json" -o "$PLUGINSDIR\license_resp.json" --max-time 10'
  Pop $R3

  ${IfNot} ${FileExists} "$PLUGINSDIR\license_resp.json"
    ${NSD_SetText} $LicenseErrorLabel "שגיאת תקשורת: לא ניתן להתחבר לשרת האימות. ודא חיבור תקין לאינטרנט ונסה שוב."
    Abort
  ${EndIf}

  ClearErrors
  FileOpen $1 "$PLUGINSDIR\license_resp.json" r
  ${If} ${Errors}
    ${NSD_SetText} $LicenseErrorLabel "שגיאה בקריאת תשובת השרת. אנא נסה שוב."
    Abort
  ${EndIf}
  FileRead $1 $4
  FileClose $1

  ${StrContains} $5 '"ok":true' $4
  ${If} $5 == ""
    ${NSD_SetText} $LicenseErrorLabel "קוד הרישיון אינו תקין או שאינו פעיל. בדוק את הקוד בפרופיל הפורום ונסה שוב."
    Abort
  ${EndIf}

  ; Success: save license to %ProgramData%\BenHazmanim\license.json
  ReadEnvStr $R1 "PROGRAMDATA"
  CreateDirectory "$R1\BenHazmanim"
  CopyFiles /SILENT "$PLUGINSDIR\license_resp.json" "$R1\BenHazmanim\license.json"
  nsExec::Exec 'cmd /c icacls "$R1\BenHazmanim\license.json" /grant *S-1-5-32-545:(M)'
FunctionEnd

!macro customPageAfterChangeDir
  Page custom LicensePageCreate LicensePageLeave
!macroend
!endif
