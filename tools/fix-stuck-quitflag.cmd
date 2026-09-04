@echo off
echo === lift deny-delete on quit.flag ===
icacls "C:\ProgramData\BenHazmanim\quit.flag" /remove:d *S-1-1-0 /C >nul 2>&1
icacls "C:\ProgramData\BenHazmanim" /remove:d *S-1-1-0 /C >nul 2>&1
echo === delete quit.flag ===
del /F /Q "C:\ProgramData\BenHazmanim\quit.flag" >nul 2>&1
if exist "C:\ProgramData\BenHazmanim\quit.flag" (
  echo STILL EXISTS - trying rename trick
  ren "C:\ProgramData\BenHazmanim\quit.flag" "quit.flag.bak" >nul 2>&1
  del /F /Q "C:\ProgramData\BenHazmanim\quit.flag.bak" >nul 2>&1
)
echo === registry Quit cleanup ===
reg delete "HKLM\Software\BenHazmanim" /v Quit /f >nul 2>&1
if exist "C:\ProgramData\BenHazmanim\quit.flag" (
  echo FAILED: flag still present
) else (
  echo SUCCESS: quit.flag removed
)
