[CmdletBinding()]
param([Parameter(Mandatory)][string]$Root)

$ErrorActionPreference = 'Stop'

function Assert-PlainPath($Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Policy location contains a reparse point: $Path"
    }
}

function Set-PolicyAcl($Path, [bool]$Directory) {
    Assert-PlainPath $Path
    $sections = [Security.AccessControl.AccessControlSections]'Owner,Access'
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $descriptor = 'O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $descriptor = 'O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)'
    }
    $acl.SetSecurityDescriptorSddlForm($descriptor, $sections)
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or
        $actual.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne
        $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) {
        throw "Unexpected ACL on $Path"
    }
}

function Read-Policy($Path, [switch]$Private) {
    Assert-PlainPath $Path
    if (-not [IO.File]::Exists($Path)) { return $null }
    if (-not $Private) { Set-PolicyAcl $Path $false }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = [IO.File]::ReadAllText($Path)
    try { $data = ConvertFrom-Json -InputObject $text -ErrorAction Stop } catch { return $null }
    if ($data -isnot [pscustomobject] -or $text.TrimStart()[0] -ne '{') { return $null }
    if ($data.schemaVersion -and [int]$data.schemaVersion -gt 2) { throw "Unsupported policy schema: $($data.schemaVersion)" }
    return ,$bytes
}

function Publish-Policy($Path, [byte[]]$Bytes) {
    Assert-PlainPath $Path
    $temporary = Join-Path (Split-Path -Parent $Path) ('.policy-' + [Guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        Set-PolicyAcl $temporary $false
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temporary, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
        Set-PolicyAcl $Path $false
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

$root = [IO.Path]::GetFullPath($Root)
Assert-PlainPath (Split-Path -Parent $root)
Assert-PlainPath $root
[void][IO.Directory]::CreateDirectory($root)
Set-PolicyAcl $root $true

$primary = Join-Path $root 'settings.json'
$backup = Join-Path $root 'settings.last-good.json'
$marker = Join-Path $root 'policy-acl.json'
$appDir = Join-Path $root 'app'
Assert-PlainPath $appDir
$legacyBackup = Join-Path $appDir 'settings.backup.json'
Assert-PlainPath $marker

# These files affect elevated startup and must not retain explicit legacy grants.
foreach ($name in @('install.json', 'main-task.xml', 'guard-task.xml')) {
    $file = Join-Path $root $name
    Assert-PlainPath $file
    if ([IO.File]::Exists($file)) { Set-PolicyAcl $file $false }
}

$current = Read-Policy $primary
$saved = Read-Policy $backup
if ($null -ne $current) {
    # Refresh the most recent good backup without rewriting the existing policy.
    Publish-Policy $backup $current
} else {
    if ($null -eq $saved -and -not [IO.File]::Exists($marker)) {
        $saved = Read-Policy $legacyBackup -Private
    }
    if ($null -eq $saved) {
        if ([IO.File]::Exists($primary) -or [IO.File]::Exists($backup) -or
            [IO.File]::Exists($marker) -or [IO.File]::Exists((Join-Path $root 'install.json')) -or
            [IO.Directory]::Exists($appDir)) {
            throw 'No valid existing policy or backup was found'
        }
        $saved = [Text.Encoding]::UTF8.GetBytes('{}')
    }
    Publish-Policy $backup $saved
    Publish-Policy $primary $saved
}
Publish-Policy $marker ([Text.Encoding]::UTF8.GetBytes('{"version":1}'))
