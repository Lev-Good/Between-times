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

; ============================================================================
; מניפסט ההרשאה של המתקין: asInvoker — נקבע **בזמן הקומפילציה**
; ----------------------------------------------------------------------------
; למה asInvoker: התוכנה מפעילה את המתקין בעצמה בסגירתה ('עדכן'). גרסה ותיקה של
; התוכנה עושה זאת ב-spawn רגיל, כלומר CreateProcess — וזה **אינו** מרים הרשאות:
; הפעלה של קובץ עם מניפסט requireAdministrator נכשלת מיד (שגיאה 740) בלי חלון
; UAC ובלי חלון שגיאה. זו התקלה שבגללה 'עדכן' סגר את התוכנה ולא התקין דבר.
; ב-1.7.1 התיקון היה בצד התוכנה (elevate.exe, ראו main.js launchElevated), אבל
; הוא לא עוזר למי שעוד תקוע בגרסה ותיקה — שהרי היא זו שמפעילה את המתקין.
; לכן המתקין עצמו מופץ עם asInvoker, עולה מכל הקשר, ומרים את עצמו ב-preInit
; שלהלן (ExecShell runas) — שהוא הנתיב היחיד שמציג את חלון ה-UAC.
;
; **ומה שאסור בתכלית האיסור:** לתקן את המניפסט אחרי הבנייה, בנגיעה בבתים של
; ה-EXE. זה מה שנעשה ב-1.7.2 (scripts/patch-installer-manifest.js) — ומבחן
; מבוקר הראה שכל שינוי בית בודד במתקין (בכל מקום בקובץ) מפיל אותו לגמרי: הוא
; יוצא מיד עם קוד 2, בלי חלון, בלי שגיאה ובלי התקנה — כלומר ממש אותה תקלה,
; רק גרועה ממנה. הסיבה: NSIS בודק את שלמות המתקין שלו בזמן ההרצה. לכן מתקין
; 1.7.2 ששוחרר היה חסר תועלת בכל מחשב, גם בהתקנה ידנית.
; (אפשר לעקוף את הבדיקה עם /NCRC, אבל אין לסמוך על זה ואין להפיץ כך מתקין.)
;
; איפה נקבע המניפסט
; ------------------
; התבנית של electron-builder מנפיקה 'RequestExecutionLevel admin' כש-perMachine
; פעיל, ואין לה מתג לכך. לכן scripts/patch-nsis-template.js משנה את קובץ
; המקור של התבנית (השורה ההיא הופכת ל-'user') **לפני** הבנייה — וזה בטוח,
; כי זו עריכת קלט הבנייה ולא של הקובץ שנבנה. ההחלה רצה ב-postinstall ואוטומטית
; ב-npm run dist, והיא נאכפת ע"י scripts/verify-installer-manifest.js: השורה
; שחסרה בתבנית מפילה את הבנייה בקול, והמניפסט של הקובץ שנבנה נבדק אחריה.
;
; מה שנבדק ולא עובד (כדי שלא ינסו שוב):
;   • nsis.script — עותק של התבנית שלנו. הנתיב הזה מבטל את בניית המסיר של
;     electron-builder, וההתקנה נכשלת עם ${UNINSTALLER_OUT_FILE} ריק.
;   • '!define admin user' בקובץ הזה — מעבד המקדים של NSIS מחליף סמל שהוגדר
;     ב-!define רק בראש שורה (הגדרת פקודה), ולא כארגומנט של פקודה. המניפסט נשאר
;     requireAdministrator בשקט (אומת בבנייה אמיתית ב-23/9/2026).
;   • שורה משלו במקום הזה — הקובץ נכלל לפני התבנית, ולכן היא חסרת תוקף.
;
; ההתקנה נשארת ברמת המחשב לכל דבר: perMachine, $PROGRAMFILES64\ben-hazmanim,
; המשימות והקיצורים לא השתנו; רק מי שמבקש את ההרשאה השתנה — המתקין, ולא Windows.
; ============================================================================

!macro customInit
  ; The app hardens its install dir with deny-delete ACLs (even for admins).
  ; The installer replaces files there — lift the deny BEFORE replacing, so
  ; upgrades keep working. In customInit, $INSTDIR is resolved and valid.
  ${If} "$INSTDIR" != ""
  ${AndIf} ${FileExists} "$INSTDIR\*.*"
    nsExec::Exec 'cmd /c icacls "$INSTDIR" /remove:d *S-1-1-0 /T /C'
  ${EndIf}
  ; Allow uninstaller of previous version to run during upgrade by creating the token temporarily
  ReadEnvStr $R0 "PROGRAMDATA"
  CreateDirectory "$R0\BenHazmanim"
  FileOpen $0 "$R0\BenHazmanim\uninstall.token" w
  FileWrite $0 "installer"
  FileClose $0
!macroend

; ============================================================================
; עצירת התוכנה בזמן התקנה/עדכון — בלי WMI ובלי tasklist
; ----------------------------------------------------------------------------
; למה זה כאן ולא רק אצל electron-builder: הבדיקה המובנית שלהם (`FIND_PROCESS`,
; `KILL_PROCESS`) מבוססת על `tasklist`/`Get-CimInstance` — כלומר על WMI. במחשב
; שה-WBEM בו פגום (נפוץ אחרי שדרוגי Windows) שתי הפקודות נכשלות בשקט
; ("Invalid class"), המתקין "לא רואה" את התוכנה, ממשיך להעתיק לתוך קבצים
; נעולים, ואז — בהתקנה שקטה — עובר למסלול שמתעלם משגיאות. התוצאה: התוכנה
; נסגרת, המתקין מדווח הצלחה, והגרסה לא מתעדכנת. זו בדיוק התקלה שדווחה
; (23/9/2026): "מוריד וסוגר את התוכנה אבל לא מתקין".
; `Get-Process` (להבדיל מ-`Get-CimInstance`) אינו תלוי ב-WMI ולכן עובד גם שם.
; ============================================================================

; כתיבת דגלי העצירה בכל הנתיבים שהתוכנה והשומר בודקים. התוכנה והשומר יוצאים
; לבד כשהם רואים את הדגל; זה הנתיב ה"מנומס", ולכן הוא ראשון.
; ============================================================================
; יומן אבחון של המתקין — נכתב תמיד, גם בהתקנה שקטה
; ----------------------------------------------------------------------------
; למה זה קיים: כשל בהתקנה שקטה הוא שקט מטבעו. המתקין יוצא בלי חלון ובלי שגיאה,
; ובמחשב של המשתמש אין שום דרך לדעת היכן הוא נעצר (23/9/2026: "מוריד וסוגר אבל
; לא מתקין"). כל שלב — הרמה, עצירת התוכנה, החלפת קבצים, אימות — נרשם כאן עם
; pid, כדי שאפשר יהיה לאבחן כשל עתידי מהמחשב של המשתמש עצמו.
; הקובץ: %TEMP%\BenHazmanim-Update.log (שורה אחת לכל שלב).
; ============================================================================
!include "LogicLib.nsh" ; נדרש: קוד שאינו מאקרו בקובץ הזה משתמש ב-${If}

!macro BENHAZ_LOG stage
  Push $0
  Push $R5
  Push $R6
  Push $R7
  ClearErrors
  ReadEnvStr $R6 "TEMP"
  ${If} $R6 == ""
    ReadEnvStr $R6 "LOCALAPPDATA"
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i .R7'
  ClearErrors
  System::Call 'kernel32::GetTickCount() i .R5'
  FileOpen $0 "$R6\BenHazmanim-Update.log" a
  ${IfNot} ${Errors}
    FileSeek $0 0 END
    FileWrite $0 "[${stage}] pid=$R7 tick=$R5 v=${VERSION}$\r$\n"
    FileClose $0
  ${EndIf}
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $0
!macroend

!macro BENHAZ_QUIT_FLAGS
  Push $0
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
  ReadEnvStr $R6 "PROGRAMDATA"
  CreateDirectory "$R6\BenHazmanim"
  FileOpen $0 "$R6\BenHazmanim\quit.flag" w
  FileWrite $0 "installer"
  FileClose $0
  Pop $0
!macroend

; עצירת התוכנה: מחסל כל תהליך שנתיבו בתיקיית ההתקנה או בעותק המוגן, וממתין
; עד שכולם נעלמו. הלוגיקה ב-PowerShell בקובץ נפרד ($PLUGINSDIR) כדי להימנע
; מכל בעיית ציטוט בין NSIS ל-PowerShell, ולהעביר את הנתיבים כפרמטרים.
; בשקט ובסבלנות (עד 15 שניות): שומר-שער יכול להעלות את התוכנה מחדש, ולכן
; אנחנו חוזרים ומחסלים עד שהתיקייה נקייה.
; פונקציה (ולא מאקרו): היא נקראת גם מבדיקת "התוכנה רצה" וגם מתיקון ההתקנה,
; ומאקרו עם תוויות היה מתנגש בעצמו בשתי ההזמנות. שני עותקים — installer ו-un.
; (ב-makensis של המסיר נדרש שם שמתחיל ב-un.) רק אחד מהם נבנה בכל מעבר.
!macro BENHAZ_STOPAPP_BODY
  InitPluginsDir
  Push $0
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ; קוד היציאה של ה-PowerShell: 1 = אין יותר תהליכים כאלה.
  FileOpen $0 "$PLUGINSDIR\bh-stop.ps1" w
  FileWrite $0 'param([string]$$dir, [string]$$dir2)$\r$\n'
  FileWrite $0 '$$p = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $$dir -or $$_.Path -like $$dir2 })$\r$\n'
  FileWrite $0 'if ($$p.Count -gt 0) { $$p | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0 }$\r$\n'
  FileWrite $0 'exit 1$\r$\n'
  FileClose $0
  ReadEnvStr $R6 "PROGRAMDATA"
  StrCpy $R8 0
  BenhazStopLoop:
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\bh-stop.ps1" -dir "$INSTDIR\*" -dir2 "$R6\BenHazmanim\app\*"'
    Pop $R7 ; קוד יציאה
    Pop $R9 ; פלט
    ; פקודות NSIS בסיסיות (ולא LogicLib): הפונקציה הזו נכתבת בקובץ ההרחבה
    ; לפני שהתבנית של electron-builder טוענת את LogicLib.
    StrCmp $R7 "1" BenhazStopDone
    IntOp $R8 $R8 + 1
    IntCmp $R8 15 BenhazStopDone 0 BenhazStopDone
    Sleep 1000
    Goto BenhazStopLoop
  BenhazStopDone:
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $0
!macroend

!ifndef BUILD_UNINSTALLER
Function BENHAZ_StopApp
  !insertmacro BENHAZ_STOPAPP_BODY
FunctionEnd
!else
Function un.BENHAZ_StopApp
  !insertmacro BENHAZ_STOPAPP_BODY
FunctionEnd
!endif

!macro BENHAZ_STOP_APP
  !ifdef BUILD_UNINSTALLER
    Call un.BENHAZ_StopApp
  !else
    Call BENHAZ_StopApp
  !endif
!macroend

; קובץ "התקנה בעיצומה": התוכנה קוראת אותו באתחול ויוצאת מיד, כדי שגם אם
; מישהו מפעיל אותה (או השומר מקפיץ אותה) בזמן ההחלפה — היא לא תנעל את הקבצים
; ותגרום להעתקה חלקית. pid של המתקין: כשהמתקין מת, הקובץ מתבטל מעצמו.
!macro BENHAZ_WRITE_PROGRESS
  Push $0
  Push $R6
  Push $R7
  ReadEnvStr $R6 "PROGRAMDATA"
  CreateDirectory "$R6\BenHazmanim"
  System::Call 'kernel32::GetCurrentProcessId() i .R7'
  FileOpen $0 "$R6\BenHazmanim\update-in-progress.json" w
  FileWrite $0 '{"pid":$R7,"version":"${VERSION}"}'
  FileClose $0
  Pop $R7
  Pop $R6
  Pop $0
!macroend

; דוח התוצאה של ההתקנה — הקובץ שהתוכנה קוראת באתחול הבא ומדווחת ממנו
; למשתמש (בעברית) אם העדכון לא הושלם. לפני התיקון הזה, כשל חלקי היה שקט
; לחלוטין: המתקין "הצליח", התוכנה עלתה מחדש, והמשתמש לא ידע דבר.
!macro BENHAZ_WRITE_RESULT ok stage
  Push $0
  Push $R6
  ReadEnvStr $R6 "PROGRAMDATA"
  CreateDirectory "$R6\BenHazmanim"
  FileOpen $0 "$R6\BenHazmanim\update-result.json" w
  FileWrite $0 '{"version":"${VERSION}","ok":${ok},"stage":"${stage}"}'
  FileClose $0
  Pop $R6
  Pop $0
!macroend

; ============================================================================
; אימות ההתקנה ותיקון עצמי — לב התיקון
; ----------------------------------------------------------------------------
; electron-builder מחלץ את החבילה ל-$PLUGINSDIR\7z-out ומעתיק משם ל-$INSTDIR
; בהעתקה "אטומית" עם 5 נסיונות (CopyFiles + IfErrors). אם ההעתקה נכשלת — קובץ
; נעול — הוא **מוחק את 7z-out** וחולץ ישירות ל-$INSTDIR תוך התעלמות משגיאות.
; כלומר: אפשר לזהות בוודאות שההעתקה האטומית נכשלה — 7z-out חסר. ואז:
;   1. לעצור את התוכנה שוב (מי שהפריע להעתקה הראשונה),
;   2. לחלץ את החבילה מחדש מתוך המתקין עצמו (app-*.7z נשאר ב-$PLUGINSDIR),
;   3. להעתיק שוב, בנסיונות חוזרים, ולאמת את גודל app.asar בהתקנה מול המקור.
;   4. אם גם זה נכשל — להיכשל **בקול רם** (הודעה + דוח), ולא להעמיד פנים שהצלחנו.
; ============================================================================
!macro BENHAZ_VERIFY_INSTALL
  Push $0
  Push $1
  Push $R2
  Push $R3
  Push $R4
  Push $R6
  Push $R7
  ${If} ${FileExists} "$PLUGINSDIR\7z-out\*.*"
    ; מסלול נקי: ההעתקה האטומית הצליחה — כל הקבצים הוחלפו.
    !insertmacro BENHAZ_LOG "verify-atomic-ok"
    !insertmacro BENHAZ_WRITE_RESULT true atomic
    Goto BenhazVerifyDone
  ${EndIf}
  ; ההעתקה נכשלה (התוכנה רצה בזמן ההעתקה) — מתקנים כאן.
  !insertmacro BENHAZ_LOG "verify-needs-repair"
  !insertmacro BENHAZ_STOP_APP
  StrCpy $R6 ""
  FindFirst $0 $1 "$PLUGINSDIR\app-*.7z"
  ${If} $1 != ""
    StrCpy $R6 "$PLUGINSDIR\$1"
  ${EndIf}
  FindClose $0
  ${If} $R6 == ""
    !insertmacro BENHAZ_WRITE_RESULT false no-payload
    Goto BenhazVerifyFail
  ${EndIf}
  RMDir /r "$PLUGINSDIR\bh-repair"
  CreateDirectory "$PLUGINSDIR\bh-repair"
  ClearErrors
  Push $OUTDIR
  SetOutPath "$PLUGINSDIR\bh-repair"
  Nsis7z::Extract "$R6"
  Pop $R7
  Pop $OUTDIR
  SetOutPath $OUTDIR
  StrCpy $R2 0
  BenhazRepairLoop:
    !insertmacro BENHAZ_STOP_APP
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\bh-repair\*" "$INSTDIR"
    IfErrors 0 BenhazRepairCopied
    IntOp $R2 $R2 + 1
    ${If} $R2 < 3
      Sleep 2000
      Goto BenhazRepairLoop
    ${EndIf}
    !insertmacro BENHAZ_WRITE_RESULT false locked
    Goto BenhazVerifyFail
  BenhazRepairCopied:
  ; אימות: גודל app.asar שהותקן זהה לזה שבחבילה שחולצה.
  StrCpy $R3 ""
  StrCpy $R4 ""
  ClearErrors
  FileOpen $0 "$INSTDIR\resources\app.asar" r
  ${IfNot} ${Errors}
    FileSeek $0 0 END $R3
    FileClose $0
  ${EndIf}
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\bh-repair\resources\app.asar" r
  ${IfNot} ${Errors}
    FileSeek $0 0 END $R4
    FileClose $0
  ${EndIf}
  ${If} $R3 == ""
  ${OrIf} $R4 == ""
  ${OrIf} $R3 != $R4
    !insertmacro BENHAZ_WRITE_RESULT false verify
    Goto BenhazVerifyFail
  ${EndIf}
  !insertmacro BENHAZ_LOG "verify-repaired-ok"
  !insertmacro BENHAZ_WRITE_RESULT true repaired
  ; הניקוי מתבצע רק בסיום מוצלח — כדי לאפשר נסיון תיקון חוזר.
  RMDir /r "$PLUGINSDIR\bh-repair"
  Goto BenhazVerifyDone
  BenhazVerifyFail:
    !insertmacro BENHAZ_LOG "verify-FAIL"
    ; כישלון גלוי. MessageBox בלי /SD מוצג גם בהתקנה שקטה (זו התנהגות NSIS),
    ; וזה מכוון: עדיף שהמשתמש יראה שהעדכון לא הותקן מאשר שיסתמך על גרסה
    ; שלא התעדכנה בלי לדעת.
    MessageBox MB_ICONSTOP|MB_OK "העדכון של 'בין הזמנים' לא הושלם.$\r$\n$\r$\nהתוכנה (או שומר-השער שלה) הייתה פתוחה בזמן החלפת הקבצים, ולכן חלק מקבצי הגרסה החדשה לא הוחלפו.$\r$\n$\r$\nסגרו את התוכנה לגמרי (קליק ימני על סמל המנעול שבמגש המערכת ובחירת יציאה) והריצו שוב את העדכון. הגרסה שהורדה נשמרה במלואה."
  BenhazVerifyDone:
  Pop $R7
  Pop $R6
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $1
  Pop $0
!macroend

; הבדיקה של electron-builder (האם התוכנה רצה) — מוחלפת בגרסה שלא תלויה ב-WMI.
!macro customCheckAppRunning
  !insertmacro BENHAZ_LOG "app-check-running"
  !insertmacro BENHAZ_QUIT_FLAGS
  !insertmacro BENHAZ_STOP_APP
!macroend

!macro preInit
  ; ---------------------------------------------------------------------------
  ; הרמה עצמית — הדבר הראשון שרץ, לפני כל השאר.
  ;
  ; המתקין מופץ עם מניפסט asInvoker (ראו "!define admin user" בראש הקובץ)
  ; ולא עם requireAdministrator, כי הפעלה של קובץ שדורש הרשאות מנהל מתהליך
  ; שאינו מוגבר נכשלת מיד (שגיאה 740) בלי חלון UAC ובלי הודעה — וזה בדיוק
  ; מה שהשאיר את עדכון-מתוך-התוכנה בלי התקנה. לכן המתקין מרים את עצמו כאן:
  ; מפעיל מחדש את עצמו בפעולה "runas" (ShellExecuteEx) — הנתיב היחיד שמציג
  ; את חלון ה-UAC — ומעביר הלאה את כל הארגומנטים (למשל /S בהתקנת עדכון
  ; שקטה), כדי שסוג ההתקנה לא ישתנה בדרך.
  ;
  ; חשוב: זה רץ **לפני** כתיבת דגלי quit.flag. superviseWatchdog של התוכנה
  ; סוגר אותה ברגע שהדגל נראה — ולכן אם נכתוב אותו כאן, ביטול חלון ה-UAC
  ; היה מותיר את המשתמש בלי תוכנה ובלי התקנה. כאן, אם האישור לא ניתן,
  ; התוכנה נשארת פתוחה ורק מוצגת הודעה.
  ; ---------------------------------------------------------------------------
  !ifndef BUILD_UNINSTALLER
    !insertmacro BENHAZ_LOG "preinit-start"
    ${IfNot} ${UAC_IsAdmin}
      ${If} ${UAC_IsInnerInstance}
        !insertmacro BENHAZ_LOG "preinit-inner-no-admin"
        ; הופעלנו על ידי תהליך מרים ולא קיבלנו הרשאות (למשל סיסמת מנהל שגויה)
        MessageBox MB_ICONSTOP|MB_OK "כדי להתקין את 'בין הזמנים' נדרש חשבון מנהל. ההתקנה לא בוצעה."
        Quit
      ${EndIf}
      ClearErrors
      ${GetParameters} $R9
      ExecShell "runas" "$EXEPATH" "$R9"
      ${IfNot} ${Errors}
        !insertmacro BENHAZ_LOG "preinit-elevate-dispatched"
        Quit ; התהליך המורם ממשיך את ההתקנה במקומנו
      ${EndIf}
      !insertmacro BENHAZ_LOG "preinit-elevate-failed"
      MessageBox MB_ICONSTOP|MB_OK "כדי להתקין את 'בין הזמנים' יש לאשר את בקשת ההרשאה של Windows.$\r$\n$\r$\nהאישור לא ניתן, ולכן ההתקנה לא בוצעה. נסו שוב ואשרו את החלון."
      Quit
    ${EndIf}

    !insertmacro BENHAZ_LOG "preinit-proceed-elevated"
  ; write quit.flag into every location the app may check, BEFORE
  ; electron-builder tries to close the running app (preInit runs before
  ; allowOnlyOneInstallerInstance). גם מסמן "התקנה בעיצומה" — כדי שהתוכנה
  ; לא תעלה מחדש (ע"י המשתמש או ע"י השומר) בזמן החלפת הקבצים ותנעל אותם.
  !insertmacro BENHAZ_QUIT_FLAGS
  !insertmacro BENHAZ_WRITE_PROGRESS
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
  ; give the app time to exit on its own before we try to extract files.
  ; nsProcess::_FindProcess sometimes fails to find Hebrew process names,
  ; so we unconditionally wait to prevent silent extraction failures.
  Sleep 4000
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
  !insertmacro BENHAZ_LOG "preinit-app-wait-done"
  !endif ; !BUILD_UNINSTALLER — בבניית המסיר אין תוכנה שצריך לעצור ואין דגלים
         ; לכתוב: בנייה במחשב שבו התוכנה מותקנת לא תסגור אותה יותר.
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
  ; If uninstaller is called during an upgrade (--updated), allow it
  ${If} ${isUpdated}
    Goto TokenOk
  ${EndIf}
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
  nsExec::Exec 'cmd /c icacls "$R1\BenHazmanim" /grant *S-1-5-32-545:(OI)(CI)M /C'
  nsExec::Exec 'cmd /c icacls "$R1\BenHazmanim\settings.json" /grant *S-1-5-32-545:(M)'

  ; ---------------------------------------------------------------------------
  ; אימות ההתקנה ותיקון קבצים נעולים — לפני שמסירים את דגלי העצירה ומפעילים
  ; את התוכנה. אם ההעתקה האטומית נכשלה, כאן משלימים אותה (או נכשלים בגלוי).
  ; ---------------------------------------------------------------------------
  !insertmacro BENHAZ_LOG "install-section"
  !insertmacro BENHAZ_VERIFY_INSTALL
  ; ההתקנה הסתיימה — "התקנה בעיצומה" מוסר כדי שהתוכנה תעלה מחדש.
  Push $R2
  ReadEnvStr $R2 "PROGRAMDATA"
  Delete "$R2\BenHazmanim\update-in-progress.json"
  Pop $R2
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
  ; Clean up the temporary uninstall token created in customInit
  Delete "$R1\BenHazmanim\uninstall.token"

  ${If} $R0 == "0"
    IfSilent skipInstallNotice 0
      MessageBox MB_ICONINFORMATION|MB_OK "התקנת 'בין הזמנים' הושלמה בהצלחה!$\r$\n$\r$\nשימו לב: התוכנה פועלת כעת ברקע במגש המערכת (ליד השעון).$\r$\n$\r$\nכדי לפתוח אותה ולהגדיר סיסמה וזמנים:$\r$\n• לחצו על סמל המנעול ליד השעון למטה (קליק ימני/שמאלי), או$\r$\n• פתחו את 'בין הזמנים' מתפריט ההתחלה או משולחן העבודה."
    skipInstallNotice:
  ${EndIf}
  ; clean up all the relaunch flags we know about
  Delete "$APPDATA\BenHazmanim\relaunch.flag"
  Delete "$APPDATA\בין הזמנים - ניהול זמן מחשב\relaunch.flag"
  Delete "$APPDATA\${PRODUCT_NAME}\relaunch.flag"
  Delete "$R1\BenHazmanim\relaunch.flag"
  ; מפעילים את **קובץ ההרצה ישירות** — ולא דרך קיצור הדרך.
  ;
  ; למה זה קריטי: ההרצה הזו היא הרצה המוגבת היחידה שיש אחרי התקנה/עדכון,
  ; והיא זו שמרעננת את העותק המוגן ב-%ProgramData% (ומשם גם יוצרת את משימת
  ; הכניסה ברמת HIGHEST ואת משימת שומר-השער). הפעלה של קיצור דרך (‏.lnk)
  ; יוצאת דרך ה-shell דרך COM, ושם התהליך יכול לאבד את ההרשאות — ואז ההרצה
  ; שאחרי ההתקנה אינה מוגבת, ההגדרה המוגבת לא מתבצעת, ומשימת הכניסה ושומר-השער
  ; ממשיכים להריץ את הגרסה הישנה (שזו הסיבה שהעותק המוגן נשאר על גרסה עתיקה
  ; בעוד ההתקנה כבר התעדכנה). הפעלה ישירה של ה-EXE מהמתקין המוגבה יוצרת תהליך
  ; מוגבה בכל מחשב.
  ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
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