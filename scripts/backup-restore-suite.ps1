param(
    [ValidateSet("backup", "restore", "verify", "list")]
    [string]$Action = "backup",
    [string]$BackupId,
    [int]$RetentionDays = 7,
    [switch]$IncludeRuntimeData,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    return (Split-Path -Parent $PSScriptRoot)
}

function Get-BackupRoot {
    param([string]$RepoRoot)
    return (Join-Path $RepoRoot "backups")
}

function New-DirectoryIfMissing {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-CommandAvailable {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Command not found: $Name"
    }
}

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed (exit code: $LASTEXITCODE)"
    }
}

function Get-CodeBackupItems {
    param(
        [string]$RepoRoot,
        [switch]$IncludeRuntime
    )

    $items = @(
        "backend\app",
        "backend\alembic",
        "backend\alembic.ini",
        "backend\requirements.txt",
        "backend\Dockerfile",
        "frontend\src",
        "frontend\public",
        "frontend\package.json",
        "frontend\tsconfig.json",
        "frontend\tsconfig.node.json",
        "frontend\vite.config.ts",
        "frontend\vite.config.js",
        "frontend\eslint.config.js",
        "frontend\tailwind.config.js",
        "frontend\postcss.config.js",
        "frontend\index.html",
        "frontend\nginx.conf",
        "frontend\Dockerfile",
        "frontend\Dockerfile.dist",
        "docker-compose.yml",
        "backup_script.ps1",
        "IMPLEMENTATION_PLAN.md",
        "ROLEPLAY_REFACTOR_PLAN.md",
        "UPDATE_LOG.md",
        ".env"
    )

    if ($IncludeRuntime) {
        $items += @(
            "backend\data",
            "backend\models"
        )
    }

    $existing = @()
    foreach ($rel in $items) {
        $abs = Join-Path $RepoRoot $rel
        if (Test-Path $abs) {
            $existing += $abs
        }
    }

    if ($existing.Count -eq 0) {
        throw "No backup paths found."
    }

    return $existing
}

function New-CodeConfigBackup {
    param(
        [string]$RepoRoot,
        [string]$RunDir,
        [switch]$IncludeRuntime
    )

    $archivePath = Join-Path $RunDir "code-config.zip"
    $manifestPath = Join-Path $RunDir "code-config.manifest.txt"
    $items = Get-CodeBackupItems -RepoRoot $RepoRoot -IncludeRuntime:$IncludeRuntime

    Compress-Archive -Path $items -DestinationPath $archivePath -CompressionLevel Optimal -Force

    $items |
        ForEach-Object { $_.Substring($RepoRoot.Length + 1) } |
        Out-File -FilePath $manifestPath -Encoding utf8

    return @{
        archive = $archivePath
        manifest = $manifestPath
    }
}

function Get-DbContainerId {
    param([string]$ComposeFile)
    $id = (& docker compose -f $ComposeFile ps -q db).Trim()
    if (-not $id) {
        throw "Could not resolve db container id. Is service 'db' running?"
    }
    return $id
}

function New-PostgresBackup {
    param(
        [string]$ComposeFile,
        [string]$RunDir
    )

    $containerId = Get-DbContainerId -ComposeFile $ComposeFile
    $containerDump = "/tmp/palink_backup.dump"
    $localDump = Join-Path $RunDir "postgres.dump"

    & docker compose -f $ComposeFile exec -T db sh -lc "pg_dump -U `$POSTGRES_USER -d `$POSTGRES_DB -Fc -f $containerDump"
    Assert-LastExitCode -Step "pg_dump"

    & docker cp "${containerId}:${containerDump}" $localDump
    Assert-LastExitCode -Step "docker cp postgres dump"

    & docker compose -f $ComposeFile exec -T db sh -lc "rm -f $containerDump"
    Assert-LastExitCode -Step "cleanup postgres dump in container"

    return $localDump
}

function New-SqliteBackup {
    param(
        [string]$RepoRoot,
        [string]$RunDir
    )

    $sqlitePath = Join-Path $RepoRoot "backend\data\palink.db"
    if (-not (Test-Path $sqlitePath)) {
        throw "SQLite source file not found: $sqlitePath"
    }

    $target = Join-Path $RunDir "palink.db.sqlite3"
    Copy-Item -Path $sqlitePath -Destination $target -Force
    return $target
}

function Write-BackupManifest {
    param(
        [string]$RunDir,
        [string]$BackupId,
        [int]$Retention,
        [bool]$IncludeRuntime
    )

    $artifactNames = @(
        "code-config.zip",
        "code-config.manifest.txt",
        "postgres.dump",
        "palink.db.sqlite3"
    )

    $artifacts = @()
    foreach ($name in $artifactNames) {
        $path = Join-Path $RunDir $name
        if (-not (Test-Path $path)) {
            throw "Required backup artifact missing: $name"
        }
        $artifacts += [ordered]@{
            name = $name
            path = $path
            size_bytes = (Get-Item $path).Length
            sha256 = (Get-Sha256 -Path $path)
        }
    }

    $manifest = [ordered]@{
        backup_id = $BackupId
        created_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
        retention_days = $Retention
        include_runtime_data = $IncludeRuntime
        artifacts = $artifacts
        restore_hint = "scripts/backup-restore-suite.ps1 -Action restore -BackupId $BackupId"
    }

    $manifestPath = Join-Path $RunDir "backup.manifest.json"
    $manifest | ConvertTo-Json -Depth 8 | Out-File -FilePath $manifestPath -Encoding utf8
    return $manifestPath
}

function Remove-ExpiredBackups {
    param(
        [string]$BackupRoot,
        [int]$Retention
    )

    if ($Retention -le 0) {
        return
    }

    $threshold = (Get-Date).AddDays(-$Retention)
    $dirs = Get-ChildItem -Path $BackupRoot -Directory -ErrorAction SilentlyContinue
    foreach ($dir in $dirs) {
        if ($dir.LastWriteTime -lt $threshold) {
            Remove-Item -Path $dir.FullName -Recurse -Force
            Write-Host "Removed expired backup: $($dir.Name)"
        }
    }
}

function Resolve-BackupDir {
    param(
        [string]$BackupRoot,
        [string]$BackupId
    )

    if ($BackupId) {
        $dir = Join-Path $BackupRoot $BackupId
        if (-not (Test-Path $dir)) {
            throw "Backup id not found: $BackupId"
        }
        return $dir
    }

    $latest = Get-ChildItem -Path $BackupRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $latest) {
        throw "No backup directories found in $BackupRoot"
    }

    return $latest.FullName
}

function Test-BackupIntegrity {
    param([string]$BackupDir)

    $manifestPath = Join-Path $BackupDir "backup.manifest.json"
    if (-not (Test-Path $manifestPath)) {
        throw "Manifest not found: $manifestPath"
    }

    $manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
    $allGood = $true

    foreach ($artifact in $manifest.artifacts) {
        $path = Join-Path $BackupDir $artifact.name
        if (-not (Test-Path $path)) {
            Write-Host "[MISSING] $($artifact.name)" -ForegroundColor Red
            $allGood = $false
            continue
        }

        $actual = Get-Sha256 -Path $path
        if ($actual -ne $artifact.sha256) {
            Write-Host "[HASH MISMATCH] $($artifact.name)" -ForegroundColor Red
            $allGood = $false
        } else {
            Write-Host "[OK] $($artifact.name)" -ForegroundColor Green
        }
    }

    if (-not $allGood) {
        throw "Backup verification failed."
    }

    Write-Host "Backup verified: $($manifest.backup_id)" -ForegroundColor Green
}

function Restore-PostgresBackup {
    param(
        [string]$ComposeFile,
        [string]$BackupDir,
        [switch]$Force
    )

    $dumpPath = Join-Path $BackupDir "postgres.dump"
    if (-not (Test-Path $dumpPath)) {
        throw "PostgreSQL dump not found: $dumpPath"
    }

    if (-not $Force) {
        $confirm = Read-Host "This will replace current PostgreSQL data. Type YES to continue"
        if ($confirm -ne "YES") {
            throw "Restore aborted by user."
        }
    }

    & docker compose -f $ComposeFile up -d db
    Assert-LastExitCode -Step "start db service"

    $containerId = Get-DbContainerId -ComposeFile $ComposeFile
    $containerDump = "/tmp/palink_restore.dump"

    & docker cp $dumpPath "${containerId}:${containerDump}"
    Assert-LastExitCode -Step "copy restore dump to container"

    & docker compose -f $ComposeFile exec -T db sh -lc "psql -U `$POSTGRES_USER -d `$POSTGRES_DB -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'"
    Assert-LastExitCode -Step "reset public schema"

    & docker compose -f $ComposeFile exec -T db sh -lc "pg_restore -U `$POSTGRES_USER -d `$POSTGRES_DB -v --no-owner --no-privileges $containerDump"
    Assert-LastExitCode -Step "pg_restore"

    & docker compose -f $ComposeFile exec -T db sh -lc "rm -f $containerDump"
    Assert-LastExitCode -Step "cleanup restore dump in container"

    Write-Host "Restore completed from $BackupDir" -ForegroundColor Green
}

$repoRoot = Get-RepoRoot
$backupRoot = Get-BackupRoot -RepoRoot $repoRoot
$composeFile = Join-Path $repoRoot "docker-compose.yml"

New-DirectoryIfMissing -Path $backupRoot
Test-CommandAvailable -Name docker

switch ($Action) {
    "backup" {
        $backupId = (Get-Date).ToString("yyyyMMdd-HHmmss")
        $runDir = Join-Path $backupRoot $backupId
        New-DirectoryIfMissing -Path $runDir

        New-CodeConfigBackup -RepoRoot $repoRoot -RunDir $runDir -IncludeRuntime:$IncludeRuntimeData | Out-Null
        New-PostgresBackup -ComposeFile $composeFile -RunDir $runDir | Out-Null
        New-SqliteBackup -RepoRoot $repoRoot -RunDir $runDir | Out-Null
        $manifestPath = Write-BackupManifest -RunDir $runDir -BackupId $backupId -Retention $RetentionDays -IncludeRuntime:$IncludeRuntimeData

        Test-BackupIntegrity -BackupDir $runDir

        Remove-ExpiredBackups -BackupRoot $backupRoot -Retention $RetentionDays

        Write-Host "Backup completed: $backupId" -ForegroundColor Green
        Write-Host "Backup directory: $runDir"
        Write-Host "Manifest: $manifestPath"
    }

    "verify" {
        $dir = Resolve-BackupDir -BackupRoot $backupRoot -BackupId $BackupId
        Test-BackupIntegrity -BackupDir $dir
    }

    "restore" {
        $dir = Resolve-BackupDir -BackupRoot $backupRoot -BackupId $BackupId
        Test-BackupIntegrity -BackupDir $dir
        Restore-PostgresBackup -ComposeFile $composeFile -BackupDir $dir -Force:$Force
    }

    "list" {
        Get-ChildItem -Path $backupRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object Name, LastWriteTime |
            Format-Table -AutoSize
    }
}
