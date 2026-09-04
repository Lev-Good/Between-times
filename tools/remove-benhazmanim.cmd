@echo off
setlocal EnableDelayedExpansion
title BenHazmanim Emergency Removal Tool
echo ============================================================
echo   BenHazmanim (Between Times - Screen Time Manager)
echo   EMERGENCY REMOVAL TOOL
echo   Removes the app completely - WITHOUT the parent password.
echo   Requires administrator (UAC prompt will appear).
echo ============================================================
echo.

REM ---------- self-elevate via UAC ----------
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
echo Running with administrator rights.
echo.

REM ---------- 1. quit flags: stop the watchdogs / SYSTEM guard (no respawn) ----------
echo [1/8] Signaling the app to stop...
if not exist "%PROGRAMDATA%\BenHazmanim" mkdir "%PROGRAMDATA%\BenHazmanim" 2>nul
type nul > "%PROGRAMDATA%\BenHazmanim\quit.flag" 2>nul
if not exist "%APPDATA%\BenHazmanim" mkdir "%APPDATA%\BenHazmanim" 2>nul
type nul > "%APPDATA%\BenHazmanim\quit.flag" 2>nul
reg delete "HKLM\Software\BenHazmanim" /v Quit /f >nul 2>&1

REM ---------- 2. stop + delete the scheduled tasks ----------
echo [2/8] Stopping and removing scheduled tasks...
schtasks /End /TN BenHazmanimGuard >nul 2>&1
schtasks /End /TN BenHazmanim >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1
schtasks /Delete /TN BenHazmanimGuard /F >nul 2>&1
schtasks /Delete /TN BenHazmanim /F >nul 2>&1

REM ---------- 3. kill all app processes (also kills the SYSTEM guard) ----------
echo [3/8] Stopping all app processes...
call :kill_apps

REM ---------- 4. remove startup entries + registry keys ----------
echo [4/8] Removing startup entries and registry keys...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f /reg:64 >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v BenHazmanim /f /reg:32 >nul 2>&1
reg delete "HKLM\Software\BenHazmanim" /f /reg:64 >nul 2>&1
reg delete "HKLM\Software\BenHazmanim" /f /reg:32 >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.levtov.benhazmanim" /f >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1
reg delete "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\a9bfe962-9f3c-5263-9e95-4def2bc5cb87" /f >nul 2>&1

REM ---------- 5. remove the internet-block firewall rule ----------
echo [5/8] Removing the internet-block firewall rule...
netsh advfirewall firewall delete rule name=BenHazmanimNetBlock >nul 2>&1

REM ---------- 6. lift deny-delete ACLs + take ownership ----------
echo [6/8] Lifting protection ACLs...
icacls "%PROGRAMFILES%\ben-hazmanim" /remove:d *S-1-1-0 /T /C >nul 2>&1
icacls "%PROGRAMFILES(X86)%\ben-hazmanim" /remove:d *S-1-1-0 /T /C >nul 2>&1
icacls "%PROGRAMDATA%\BenHazmanim" /remove:d *S-1-1-0 /T /C >nul 2>&1
takeown /f "%PROGRAMFILES%\ben-hazmanim" /a /r /d y >nul 2>&1
takeown /f "%PROGRAMDATA%\BenHazmanim" /a /r /d y >nul 2>&1

REM ---------- 7. delete files - with retries for locked files ----------
echo [7/8] Deleting files (retrying locked files)...
set tries=0
:retry_del
set /a tries+=1
if %tries% gtr 10 goto del_giveup
call :kill_apps
timeout /t 3 /nobreak >nul 2>&1
rmdir /S /Q "%PROGRAMFILES%\ben-hazmanim" >nul 2>&1
rmdir /S /Q "%PROGRAMFILES(X86)%\ben-hazmanim" >nul 2>&1
rmdir /S /Q "%PROGRAMDATA%\BenHazmanim" >nul 2>&1
call :delete_appdata
if exist "%PROGRAMFILES%\ben-hazmanim" goto retry_del
if exist "%PROGRAMFILES(X86)%\ben-hazmanim" goto retry_del
if exist "%PROGRAMDATA%\BenHazmanim" goto retry_del
goto del_done
:del_giveup
echo   WARNING: some folders could not be deleted (files in use).
echo   Queueing the remaining files for deletion at the next reboot...
call :queue_reboot_delete
:del_done

REM ---------- 8. verify ----------
echo [8/8] Verifying...
call :verify
echo.
echo ============================================================
timeout /t 5 /nobreak >nul 2>&1
exit /b

REM ============================================================
REM  helpers
REM ============================================================

:kill_apps
REM Kill every app process by name (Hebrew, built from char codes) or by path.
powershell -NoProfile -Command "$n = -join ([char]0x05D1,[char]0x05D9,[char]0x05DF,[char]0x20,[char]0x05D4,[char]0x05D6,[char]0x05DE,[char]0x05E0,[char]0x05D9,[char]0x05DD); Get-Process | Where-Object { $_.ProcessName -eq $n -or $_.ProcessName -like ('Uninstall ' + $n) -or $_.Path -like '*ben-hazmanim*' -or $_.Path -like '*BenHazmanim*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
exit /b

:delete_appdata
REM Delete the app's data dirs (Hebrew name via char codes) for the current
REM user and, best-effort, for every user profile on the machine.
powershell -NoProfile -Command "$h = -join ([char]0x05D1,[char]0x05D9,[char]0x05DF,[char]0x20,[char]0x05D4,[char]0x05D6,[char]0x05DE,[char]0x05E0,[char]0x05D9,[char]0x05DD,[char]0x20,[char]0x2D,[char]0x20,[char]0x05E0,[char]0x05D9,[char]0x05D4,[char]0x05D5,[char]0x05DC,[char]0x20,[char]0x05D6,[char]0x05DE,[char]0x05DF,[char]0x20,[char]0x05DE,[char]0x05D7,[char]0x05E9,[char]0x05D1); $t = @(); $t += Join-Path ([Environment]::GetFolderPath('ApplicationData')) $h; $t += Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'BenHazmanim'; Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $p = Join-Path (Join-Path $_.FullName 'AppData\Roaming') $h; if (Test-Path $p) { $t += $p } }; try { $j = Get-Content (Join-Path $env:PROGRAMDATA 'BenHazmanim\install.json') -Raw -ErrorAction Stop | ConvertFrom-Json; if ($j.dir -and (Test-Path $j.dir)) { $t += $j.dir } } catch { }; foreach ($p in $t) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 600; foreach ($p in $t) { if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue } }"
exit /b

:queue_reboot_delete
REM Register remaining folders for deletion at next boot (PendingFileRenameOperations).
REM This handles files whose ACLs were corrupted by the app while it was running
REM (rare but possible) - the boot-time cleanup uses SYSTEM privileges.
powershell -NoProfile -Command "$key='HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'; $prop='PendingFileRenameOperations'; $list=New-Object System.Collections.Generic.List[string]; try { $cur=(Get-ItemProperty -Path $key -Name $prop -ErrorAction SilentlyContinue).$prop; if ($cur) { foreach ($c in $cur) { $list.Add([string]$c) } } } catch {}; foreach ($d in @('C:\Program Files\ben-hazmanim','C:\Program Files (x86)\ben-hazmanim',(Join-Path $env:PROGRAMDATA 'BenHazmanim'))) { if (Test-Path $d) { $list.Add('\??\' + $d); $list.Add('') } }; if ($list.Count -gt 0) { Set-ItemProperty -Path $key -Name $prop -Value $list.ToArray() -Type MultiString }"
echo   Remaining files will be removed automatically at the next reboot.
exit /b

:verify
powershell -NoProfile -Command "$n = -join ([char]0x05D1,[char]0x05D9,[char]0x05DF,[char]0x20,[char]0x05D4,[char]0x05D6,[char]0x05DE,[char]0x05E0,[char]0x05D9,[char]0x05DD); $bad = 0; if (Test-Path 'C:\Program Files\ben-hazmanim') { echo 'STILL PRESENT: C:\Program Files\ben-hazmanim'; $bad++ }; if (Test-Path 'C:\Program Files (x86)\ben-hazmanim') { echo 'STILL PRESENT: C:\Program Files (x86)\ben-hazmanim'; $bad++ }; if (Test-Path (Join-Path $env:PROGRAMDATA 'BenHazmanim')) { echo 'STILL PRESENT: ProgramData\BenHazmanim'; $bad++ }; if (Get-Process -Name $n -ErrorAction SilentlyContinue) { echo 'STILL RUNNING: app process'; $bad++ }; if ($bad -eq 0) { echo 'SUCCESS: BenHazmanim fully removed.' } else { echo 'NOTICE: some items remain (see above).' }"
exit /b
