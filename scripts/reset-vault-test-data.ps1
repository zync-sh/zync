<#
Usage:
  .\scripts\reset-vault-test-data.ps1 -Mode clear-vault -Force
  .\scripts\reset-vault-test-data.ps1 -Mode restore-pre-vault -Force
  .\scripts\reset-vault-test-data.ps1 -Mode hard-auth-reset -Force
  .\scripts\reset-vault-test-data.ps1 -Mode full-local-reset -Force
  .\scripts\reset-vault-test-data.ps1 -DataDir "D:\path\to\zync\data" -Mode hard-auth-reset -Force

Modes:
  clear-vault        Remove vault/sync files only. Safe default for vault-only cleanup.
  restore-pre-vault  Remove vault files and restore connections.json from the pre-secure backup.
  hard-auth-reset    Remove vault files and strip authRef/privateKeyPath/password from live connections.json.
  full-local-reset   Remove vault files and replace connections/folders with empty arrays.

Notes:
  - This script does not remove Google refresh tokens from the OS keychain.
  - Use hard-auth-reset when you want a true "nothing can still connect" local test state.
#>

param(
    [string]$DataDir,
    [ValidateSet('clear-vault', 'restore-pre-vault', 'hard-auth-reset', 'full-local-reset')]
    [string]$Mode = 'clear-vault',
    [switch]$DeleteConnectionsBackup,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CandidateDataDirs {
    $candidates = @()

    if ($env:APPDATA) {
        $nativeSettingsDir = Join-Path $env:APPDATA 'Zync\User'
        $nativeSettingsPath = Join-Path $nativeSettingsDir 'settings.json'
        if (Test-Path -LiteralPath $nativeSettingsPath) {
            try {
                $settings = Get-Content -LiteralPath $nativeSettingsPath -Raw | ConvertFrom-Json
                if ($settings.dataPath) {
                    $candidates += $settings.dataPath
                }
            } catch {
                # Ignore invalid settings.json and continue with fallbacks.
            }
        }
    }

    if ($env:APPDATA) {
        $candidates += (Join-Path $env:APPDATA 'Zync\User')
        $candidates += (Join-Path $env:APPDATA 'zync')
        $candidates += (Join-Path $env:APPDATA 'com.zync.desktop')
    }

    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Zync\User')
        $candidates += (Join-Path $env:LOCALAPPDATA 'com.zync.desktop')
        $candidates += (Join-Path $env:LOCALAPPDATA 'zync')
    }

    return $candidates | Select-Object -Unique
}

function Resolve-DataDir {
    param([string]$RequestedDataDir)

    if ($RequestedDataDir) {
        return (Resolve-Path -LiteralPath $RequestedDataDir).Path
    }

    $candidates = Get-CandidateDataDirs

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw @"
Could not auto-detect the Zync data directory.
Re-run with -DataDir 'C:\path\to\your\zync\data'
"@
}

function Remove-IfExists {
    param([string]$PathToDelete)
    if (Test-Path -LiteralPath $PathToDelete) {
        Remove-Item -LiteralPath $PathToDelete -Force
        Write-Host "Removed: $PathToDelete"
    } else {
        Write-Host "Missing:  $PathToDelete"
    }
}

function Rewrite-ConnectionsJson {
    param(
        [string]$ConnectionsFile,
        [scriptblock]$Transform,
        [string]$SuccessMessage
    )

    if (-not (Test-Path -LiteralPath $ConnectionsFile)) {
        Write-Warning "Connections file not found: $ConnectionsFile"
        return
    }

    $raw = Get-Content -LiteralPath $ConnectionsFile -Raw
    $json = $raw | ConvertFrom-Json
    if ($null -eq $json.connections) {
        Write-Warning "Connections file does not contain a connections array: $ConnectionsFile"
        return
    }

    foreach ($connection in $json.connections) {
        & $Transform $connection
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $ConnectionsFile,
        ($json | ConvertTo-Json -Depth 100),
        $utf8NoBom
    )
    Write-Host $SuccessMessage
}

$resolvedDataDir = Resolve-DataDir -RequestedDataDir $DataDir

$targets = @(
    'vault.redb',
    'vault.redb.pre-import',
    'vault.redb.tmp-pre-import',
    'vault.redb.sync-tmp',
    'vault.redb.download-tmp',
    'sync-google.json',
    'sync-google-tokens.json',
    'sync-profiles.json'
)

$targetPatterns = @(
    'sync-collection-*.json'
)

$connectionsBackup = Join-Path $resolvedDataDir 'connections.json.pre-secure-to-vault'
$legacyConnectionsBackup = Join-Path $resolvedDataDir 'connections.json.pre-vault-migration'
$connectionsPath = Join-Path $resolvedDataDir 'connections.json'

Write-Host "Target data dir: $resolvedDataDir"
Write-Host ''
Write-Host "Reset mode: $Mode"
Write-Host ''
Write-Host 'This script will remove vault-related local test data:'
foreach ($name in $targets) {
    Write-Host " - $(Join-Path $resolvedDataDir $name)"
}
foreach ($pattern in $targetPatterns) {
    $matchedFiles = Get-ChildItem -LiteralPath $resolvedDataDir -Filter $pattern -File -ErrorAction SilentlyContinue
    if ($matchedFiles) {
        foreach ($match in $matchedFiles) {
            Write-Host " - $($match.FullName)"
        }
    } else {
        Write-Host " - $(Join-Path $resolvedDataDir $pattern) (no matches)"
    }
}
if ($DeleteConnectionsBackup) {
    Write-Host " - $connectionsBackup"
    if ($legacyConnectionsBackup -ne $connectionsBackup) {
        Write-Host " - $legacyConnectionsBackup"
    }
}
switch ($Mode) {
    'restore-pre-vault' {
        Write-Host " - restore $connectionsBackup (or legacy backup) -> $connectionsPath"
    }
    'hard-auth-reset' {
        Write-Host " - clear authRef/privateKeyPath/password inside $connectionsPath"
    }
    'full-local-reset' {
        Write-Host " - replace $connectionsPath with empty connections/folders arrays"
    }
}
Write-Host ''
Write-Host 'Note: This does NOT remove Google refresh tokens from the OS keychain.'
Write-Host 'Use the app Disconnect action or remove the keyring entry manually if needed.'
Write-Host 'Modes:'
Write-Host ' - clear-vault: remove vault/sync files only (default; does not change live connection auth fields)'
Write-Host ' - restore-pre-vault: remove vault files and restore connections.json from pre-secure backup'
Write-Host ' - hard-auth-reset: remove vault files and strip authRef/privateKeyPath/password from live connections.json'
Write-Host ' - full-local-reset: remove vault files and empty local hosts/folders for full restore testing'
Write-Host ''

if (-not $Force) {
    $confirmation = Read-Host 'Proceed? [y/N]'
    if ($confirmation -notin @('y', 'Y', 'yes', 'YES')) {
        Write-Host 'Aborted.'
        exit 1
    }
}

foreach ($name in $targets) {
    Remove-IfExists -PathToDelete (Join-Path $resolvedDataDir $name)
}

foreach ($pattern in $targetPatterns) {
    Get-ChildItem -LiteralPath $resolvedDataDir -Filter $pattern -File -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-IfExists -PathToDelete $_.FullName }
}

switch ($Mode) {
    'restore-pre-vault' {
        if (Test-Path -LiteralPath $connectionsBackup) {
            Copy-Item -LiteralPath $connectionsBackup -Destination $connectionsPath -Force
            Write-Host "Restored connections backup: $connectionsBackup -> $connectionsPath"
        } elseif (Test-Path -LiteralPath $legacyConnectionsBackup) {
            Copy-Item -LiteralPath $legacyConnectionsBackup -Destination $connectionsPath -Force
            Write-Host "Restored legacy connections backup: $legacyConnectionsBackup -> $connectionsPath"
        } else {
            Write-Warning "Cannot restore connections: no pre-secure backup found at $connectionsBackup or $legacyConnectionsBackup"
        }
    }
    'hard-auth-reset' {
        # Intentionally clears both vault refs and direct auth fields so hosts
        # cannot silently keep connecting through an old PEM path or password.
        Rewrite-ConnectionsJson -ConnectionsFile $connectionsPath -SuccessMessage 'Stripped authRef/privateKeyPath/password from live connections.json.' -Transform {
            param($connection)
            foreach ($name in @('authRef', 'privateKeyPath', 'password')) {
                if ($connection.PSObject.Properties.Name -contains $name) {
                    $connection.$name = $null
                } else {
                    Add-Member -InputObject $connection -NotePropertyName $name -NotePropertyValue $null
                }
            }
        }
    }
    'full-local-reset' {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $emptyPayload = @{
            connections = @()
            folders = @()
        } | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($connectionsPath, $emptyPayload, $utf8NoBom)
        Write-Host "Reset local hosts/folders: $connectionsPath"
    }
}

if ($DeleteConnectionsBackup) {
    Remove-IfExists -PathToDelete $connectionsBackup
    Remove-IfExists -PathToDelete $legacyConnectionsBackup
}

Write-Host ''
Write-Host 'Vault test reset complete.'
