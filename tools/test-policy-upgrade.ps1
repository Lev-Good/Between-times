[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Candidate,
    [ValidateSet('Clean', '1.8.4', '1.8.5')][string]$From = 'Clean',
    [string]$PreviousInstaller,
    [Parameter(Mandatory)][switch]$DisposableVM
)

$ErrorActionPreference = 'Stop'
if (-not $DisposableVM) { throw 'Run this test only in a disposable Windows VM.' }
$computer = Get-CimInstance Win32_ComputerSystem
if ($computer.Model -notmatch 'Virtual|VMware|KVM|QEMU|HVM|Standard PC') { throw 'This host was not recognized as a virtual machine.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Start PowerShell as an administrator.' }

$root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'BenHazmanim'
$settings = Join-Path $root 'settings.json'
$backup = Join-Path $root 'settings.last-good.json'
$marker = Join-Path $root 'policy-acl.json'
if (Test-Path -LiteralPath $root) { throw 'Restore a clean VM snapshot before each scenario.' }

function Install([string]$Installer) {
    $exe = (Resolve-Path -LiteralPath $Installer).Path
    $process = Start-Process -FilePath $exe -ArgumentList '/S' -PassThru
    if (-not $process.WaitForExit(240000)) { throw "Installer did not exit: $exe" }
    if ($process.ExitCode -ne 0) { throw "Installer exit code $($process.ExitCode): $exe" }
}

function Await($Condition, [string]$Failure) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        if (& $Condition) { return }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $Failure
}

if ($From -ne 'Clean') {
    if (-not $PreviousInstaller) { throw '-PreviousInstaller is required for upgrade scenarios.' }
    Install $PreviousInstaller
    Await { (Test-Path -LiteralPath $settings) -and (Test-Path -LiteralPath (Join-Path $root 'install.json')) } 'The previous build did not initialize.'
    $fixture = @{
        schemaVersion = 2; enabled = $false; mode = 'allowlist'; blockMessage = "upgrade-$From"
        pinHash = ('a' * 64)
        dailyLimit = @{ enabled = $true; minutes = 43 }; warnMinutes = 11
        week = @(
            @{ day = 0; slots = @(@{ start = 1320; end = 120; type = 'allowed' }) }
            foreach ($d in 1..6) { @{ day = $d; slots = @() } }
        )
    } | ConvertTo-Json -Depth 8 -Compress
    [IO.File]::WriteAllText($settings, $fixture)
}

Install $Candidate
Await { Test-Path -LiteralPath $marker } 'Policy migration marker is missing.'
Await {
    $infoPath = Join-Path $root 'install.json'
    if (-not (Test-Path -LiteralPath $infoPath)) { return $false }
    $installed = (Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json).exe
    $protected = Join-Path (Join-Path $root 'app') (Split-Path -Leaf $installed)
    (Test-Path -LiteralPath $protected) -and
        (Get-Item -LiteralPath $protected).VersionInfo.ProductVersion -match '^1\.8\.6(\.0)?$'
} 'The protected runtime did not upgrade to 1.8.6.'
$current = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
if ($From -ne 'Clean' -and ($current.blockMessage -ne "upgrade-$From" -or $current.dailyLimit.minutes -ne 43 -or
    $current.week[0].slots[0].start -ne 1320 -or $current.week[0].slots[0].end -ne 120)) {
    throw 'The upgrade changed existing rules.'
}
$before = (Get-FileHash -LiteralPath $settings).Hash
if ((Get-FileHash -LiteralPath $backup).Hash -ne $before) { throw 'The protected backup differs from the policy.' }

$user = 'bhzTest' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'Aa!1') -AsPlainText -Force
New-LocalUser -Name $user -Password $password | Out-Null
try {
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    $credential = [pscredential]::new("$env:COMPUTERNAME\$user", $password)
    $standard = @'
$policy = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'BenHazmanim\settings.json'
try { $null = [IO.File]::ReadAllText($policy) } catch { exit 10 }
try { $f = [IO.File]::Open($policy, 'Open', 'Write'); $f.Dispose(); exit 11 } catch [UnauthorizedAccessException] {}
try { [IO.File]::Delete($policy); exit 12 } catch [UnauthorizedAccessException] {}
try { [IO.File]::WriteAllText((Join-Path (Split-Path $policy) 'bhz-permission-test.tmp'), 'test'); exit 13 } catch [UnauthorizedAccessException] {}
exit 0
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($standard))
    $process = Start-Process powershell.exe -Credential $credential -LoadUserProfile -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -PassThru
    if (-not $process.WaitForExit(40000) -or $process.ExitCode -ne 0) { throw "Standard account ACL check failed: $($process.ExitCode)" }
    if ((Get-FileHash -LiteralPath $settings).Hash -ne $before) { throw 'The standard-account test altered the policy.' }
} finally {
    Remove-LocalUser -Name $user
}

Set-Content -LiteralPath $settings -Value 'null' -Encoding ascii -NoNewline
Await {
    (Test-Path -LiteralPath $settings) -and (Get-FileHash -LiteralPath $settings).Hash -eq $before
} 'The watchdog did not restore the protected backup.'

Write-Output "PASS $From -> 1.8.6 (installer, policy preservation, standard-account ACL, watchdog restore)"
