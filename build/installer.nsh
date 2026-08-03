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
