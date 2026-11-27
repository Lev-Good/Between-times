$ErrorActionPreference = 'Stop'
$migration = Join-Path $PSScriptRoot '..\build\protect-policy.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('bhz-policy-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)

# Run the real Windows file operations without changing ownership of the test
# process's files. The VM integration test checks effective NTFS permissions.
$acls = @{}
function Set-Acl($LiteralPath, $AclObject) { $acls[$LiteralPath] = $AclObject }
function Get-Acl($LiteralPath) { return $acls[$LiteralPath] }
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected $Expected, got $Actual" }
}
function Get-Text($Base, $Name) { return [IO.File]::ReadAllText((Join-Path $Base $Name)) }

try {
    $fresh = Join-Path $root 'fresh'
    & $migration -Root $fresh
    Assert-Equal (Get-Text $fresh 'settings.json') '{}'
    Assert-Equal (Get-Text $fresh 'settings.last-good.json') '{}'
    Assert-Equal (Get-Text $fresh 'policy-acl.json') '{"version":1}'

    foreach ($version in '1.8.4','1.8.5') {
        $legacy = Join-Path $root $version
        [void][IO.Directory]::CreateDirectory($legacy)
        [void][IO.Directory]::CreateDirectory((Join-Path $legacy 'app'))
        $data = '{ "schemaVersion": 2, "enabled": false, "mode": "allowlist", "blockMessage": "' + $version + '", "dailyLimit": {"enabled":true,"minutes":43}, "pinHash": "fixture" }'
        [IO.File]::WriteAllText((Join-Path $legacy 'settings.json'), $data)
        [IO.File]::WriteAllText((Join-Path $legacy 'app\settings.backup.json'), '{"enabled":true}')
        & $migration -Root $legacy
        Assert-Equal (Get-Text $legacy 'settings.json') $data
        Assert-Equal (Get-Text $legacy 'settings.last-good.json') $data
        & $migration -Root $legacy
        Assert-Equal (Get-Text $legacy 'settings.json') $data

        [IO.File]::WriteAllText((Join-Path $legacy 'settings.json'), 'null')
        $locked = [IO.File]::Open((Join-Path $legacy 'settings.json'), 'Open', 'Read', 'ReadWrite')
        $failed = $false
        try { & $migration -Root $legacy } catch { $failed = $true } finally { $locked.Dispose() }
        Assert-Equal $failed $true
        Assert-Equal (Get-Text $legacy 'settings.last-good.json') $data
        & $migration -Root $legacy
        Assert-Equal (Get-Text $legacy 'settings.json') $data
    }

    $unrecoverable = Join-Path $root 'unrecoverable'
    [void][IO.Directory]::CreateDirectory($unrecoverable)
    [IO.File]::WriteAllText((Join-Path $unrecoverable 'settings.json'), 'null')
    $failed = $false
    try { & $migration -Root $unrecoverable } catch { $failed = $true }
    Assert-Equal $failed $true
    Assert-Equal (Get-Text $unrecoverable 'settings.json') 'null'
    if ([IO.File]::Exists((Join-Path $unrecoverable 'policy-acl.json'))) { throw 'Migration marked a failed upgrade as successful' }
} finally {
    [IO.Directory]::Delete($root, $true)
}
