@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title BenHazmanim Emergency Removal Tool
echo ============================================================
echo   BenHazmanim - EMERGENCY REMOVAL TOOL (Live Windows + WinRE)
echo   Removes the app completely - WITHOUT the parent password.
echo ============================================================
echo.

REM Detect environment: WinRE / WinPE always runs from the X: RAM drive.
if /i "%SystemDrive%"=="X:" goto :mode_winre

REM =============================================================
REM  LIVE WINDOWS MODE
REM =============================================================
:mode_online
echo [Mode] Live Windows session.
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" >nul 2>&1
  if errorlevel 1 (
    echo ERROR: Administrator rights are required.
    echo Right-click this file and choose "Run as administrator".
    pause
  )
  exit /b
)

echo [1/7] Signaling the guards to stop...
if not exist "%ProgramData%\BenHazmanim" mkdir "%ProgramData%\BenHazmanim" >nul 2>&1
type nul > "%ProgramData%\BenHazmanim\quit.flag" 2>nul
if not exist "%APPDATA%\BenHazmanim" mkdir "%APPDATA%\BenHazmanim" >nul 2>&1
type nul > "%APPDATA%\BenHazmanim\quit.flag" 2>nul
reg add "HKLM\Software\BenHazmanim" /v Quit /t REG_SZ /d 1 /f >nul 2>&1

echo [2/7] Stopping and removing scheduled tasks...
schtasks /End /TN BenHazmanimGuard >nul 2>&1
schtasks /End /TN BenHazmanim >nul 2>&1
call :sleep 3
schtasks /Delete /TN BenHazmanimGuard /F >nul 2>&1
schtasks /Delete /TN BenHazmanim /F >nul 2>&1
call :kill_apps

echo [3/7] Removing startup entries and registry keys...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f /reg:64 >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f /reg:32 >nul 2>&1
reg delete "HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\Schedule" /f >nul 2>&1
reg delete "HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\Schedule" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.levtov.benhazmanim" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1
reg delete "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1

echo [4/7] Removing the internet-block firewall rule...
netsh advfirewall firewall delete rule name=BenHazmanimNetBlock >nul 2>&1

echo [5/7] Lifting protection ACLs...
call :unlock_dir "%ProgramFiles%\ben-hazmanim"
call :unlock_dir "%ProgramFiles(x86)%\ben-hazmanim"
call :unlock_dir "%ProgramData%\BenHazmanim"

echo [6/7] Deleting files (retrying locked files)...
set /a tries=0
:retry_del
set /a tries+=1
call :kill_apps
rmdir /S /Q "%ProgramFiles%\ben-hazmanim" >nul 2>&1
rmdir /S /Q "%ProgramFiles(x86)%\ben-hazmanim" >nul 2>&1
rmdir /S /Q "%ProgramData%\BenHazmanim" >nul 2>&1
call :remaining "%SystemDrive%"
if "!LEFT!"=="0" goto :online_appdata
if !tries! geq 5 goto :online_appdata
call :sleep 3
goto :retry_del

:online_appdata
call :delete_appdata "%SystemDrive%"
reg delete "HKLM\Software\BenHazmanim" /f /reg:64 >nul 2>&1
reg delete "HKLM\Software\BenHazmanim" /f /reg:32 >nul 2>&1

echo [7/7] Verifying...
call :remaining "%SystemDrive%"
goto :report

REM =============================================================
REM  WINRE / WINPE MODE (offline Windows on another drive letter)
REM =============================================================
:mode_winre
echo [Mode] Windows Recovery Environment (WinRE / WinPE).
echo Scanning drives for the Windows installation...
set "T="
for %%d in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do (
  if not defined T if exist "%%d:\Windows\System32\config\SYSTEM" if exist "%%d:\ProgramData\BenHazmanim" set "T=%%d:"
)
for %%d in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do (
  if not defined T if exist "%%d:\Windows\System32\config\SYSTEM" if exist "%%d:\Program Files\ben-hazmanim" set "T=%%d:"
)
if not defined T (
  echo ERROR: Could not find a Windows drive with BenHazmanim installed.
  echo If the drive is encrypted with BitLocker, unlock it first:
  echo   manage-bde -unlock C: -RecoveryPassword YOUR-48-DIGIT-KEY
  pause
  exit /b 1
)
echo Found Windows on drive %T%

echo [1/5] Removing scheduled task definitions...
del /f /q "%T%\Windows\System32\Tasks\BenHazmanim" >nul 2>&1
del /f /q "%T%\Windows\System32\Tasks\BenHazmanimGuard" >nul 2>&1

echo [2/5] Loading offline registry hives...
reg unload HKLM\BHZ_SYS >nul 2>&1
reg unload HKLM\BHZ_SOFT >nul 2>&1
reg load HKLM\BHZ_SYS "%T%\Windows\System32\config\SYSTEM" >nul 2>&1
reg load HKLM\BHZ_SOFT "%T%\Windows\System32\config\SOFTWARE" >nul 2>&1

echo [3/5] Cleaning offline registry...
for %%c in (ControlSet001 ControlSet002 ControlSet003) do (
  reg delete "HKLM\BHZ_SYS\%%c\Control\SafeBoot\Minimal\Schedule" /f >nul 2>&1
  reg delete "HKLM\BHZ_SYS\%%c\Control\SafeBoot\Network\Schedule" /f >nul 2>&1
)
set "TC=HKLM\BHZ_SOFT\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache"
for %%n in (BenHazmanim BenHazmanimGuard) do (
  for /f "tokens=3" %%g in ('reg query "%TC%\Tree\%%n" /v Id 2^>nul ^| findstr /i "REG_SZ"') do (
    for %%k in (Tasks Boot Logon Plain) do reg delete "%TC%\%%k\%%g" /f >nul 2>&1
  )
  reg delete "%TC%\Tree\%%n" /f >nul 2>&1
)
reg delete "HKLM\BHZ_SOFT\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f >nul 2>&1
reg delete "HKLM\BHZ_SOFT\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f >nul 2>&1
reg delete "HKLM\BHZ_SOFT\BenHazmanim" /f >nul 2>&1
reg delete "HKLM\BHZ_SOFT\WOW6432Node\BenHazmanim" /f >nul 2>&1
reg delete "HKLM\BHZ_SOFT\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1
reg delete "HKLM\BHZ_SOFT\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1
reg unload HKLM\BHZ_SYS >nul 2>&1
reg unload HKLM\BHZ_SOFT >nul 2>&1

echo [4/5] Lifting protection ACLs and deleting program files...
call :unlock_dir "%T%\Program Files\ben-hazmanim"
call :unlock_dir "%T%\Program Files (x86)\ben-hazmanim"
call :unlock_dir "%T%\ProgramData\BenHazmanim"
rmdir /S /Q "%T%\Program Files\ben-hazmanim" >nul 2>&1
rmdir /S /Q "%T%\Program Files (x86)\ben-hazmanim" >nul 2>&1
rmdir /S /Q "%T%\ProgramData\BenHazmanim" >nul 2>&1

echo [5/5] Cleaning user data of all profiles...
call :delete_appdata "%T%"
call :remaining "%T%"
goto :report

REM =============================================================
REM  REPORT
REM =============================================================
:report
echo.
echo ============================================================
if "!LEFT!"=="0" (
  echo   SUCCESS: BenHazmanim was removed completely.
) else (
  echo   NOTICE: some program folders could not be deleted ^(see above^).
  echo   The app can no longer start, but to finish the cleanup:
  echo   restart the computer and run this tool again.
)
if /i "%SystemDrive%"=="X:" echo   Type EXIT and choose "Continue" to start Windows.
echo ============================================================
pause
exit /b 0

REM =============================================================
REM  HELPERS (pure cmd - no PowerShell, works inside WinRE)
REM =============================================================
:unlock_dir
if not exist "%~1" exit /b 0
REM Locale-independent ownership (Administrators) + reset ACLs to inherited.
REM This removes the "deny delete for Everyone" ACE the app applies.
icacls "%~1" /setowner *S-1-5-32-544 /T /C /Q >nul 2>&1
icacls "%~1" /reset /T /C /Q >nul 2>&1
attrib -r -s -h "%~1\*" /S /D >nul 2>&1
exit /b 0

:kill_apps
taskkill /F /T /IM "בין הזמנים.exe" >nul 2>&1
taskkill /F /T /IM "Uninstall בין הזמנים.exe" >nul 2>&1
taskkill /F /T /IM "ben-hazmanim.exe" >nul 2>&1
exit /b 0

:delete_appdata
for /d %%u in ("%~1\Users\*") do (
  rmdir /S /Q "%%u\AppData\Roaming\BenHazmanim" >nul 2>&1
  rmdir /S /Q "%%u\AppData\Local\Programs\ben-hazmanim" >nul 2>&1
  rmdir /S /Q "%%u\AppData\Roaming\בין הזמנים" >nul 2>&1
  rmdir /S /Q "%%u\AppData\Roaming\בין הזמנים - ניהול זמן מחשב" >nul 2>&1
)
exit /b 0

:remaining
set "LEFT=0"
for %%p in ("%~1\Program Files\ben-hazmanim" "%~1\Program Files (x86)\ben-hazmanim" "%~1\ProgramData\BenHazmanim") do (
  if exist "%%~p" (
    echo   STILL PRESENT: %%~p
    set /a LEFT+=1
  )
)
exit /b 0

:sleep
ping -n %~1 127.0.0.1 >nul 2>&1
exit /b 0
