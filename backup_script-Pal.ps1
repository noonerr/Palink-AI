param(
    [switch]$IncludeRuntimeData
)

# Palink AI backup script (code/config by default)

$ErrorActionPreference = "Stop"

try {
    $repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    Set-Location $repoRoot

    $parentDir = Split-Path -Parent $repoRoot
    $backupRoot = Join-Path $parentDir "backup"
    if (-not (Test-Path $backupRoot)) {
        New-Item -ItemType Directory -Path $backupRoot | Out-Null
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupName = "Palink-AI-code-config-$timestamp.zip"
    $backupPath = Join-Path $backupRoot $backupName
    $manifestPath = Join-Path $backupRoot "Palink-AI-code-config-$timestamp.manifest.txt"

    # Default whitelist: code and config only, avoids runtime lock-file issues.
    $backupItems = @(
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

    if ($IncludeRuntimeData) {
        $backupItems += @(
            "backend\data",
            "backend\models"
        )
    }

    $existingItems = @()
    foreach ($item in $backupItems) {
        if (Test-Path $item) {
            $existingItems += $item
        }
    }

    if ($existingItems.Count -eq 0) {
        throw "No backup paths found. Ensure this script is in repo root."
    }

    Write-Host "Creating backup archive..."
    Compress-Archive -Path $existingItems -DestinationPath $backupPath -CompressionLevel Optimal -Force
    $existingItems | Out-File -FilePath $manifestPath -Encoding utf8

    if (-not (Test-Path $backupPath)) {
        throw "Backup failed: archive was not created."
    }

    $backupSize = [Math]::Round((Get-Item $backupPath).Length / 1MB, 2)
    Write-Host "Backup created: $backupName"
    Write-Host "Backup size: $backupSize MB"
    Write-Host "Backup path: $backupPath"
    Write-Host "Manifest path: $manifestPath"
    if ($IncludeRuntimeData) {
        Write-Host "Runtime data directories were included."
    } else {
        Write-Host "Runtime data directories were not included (use -IncludeRuntimeData to include)."
    }
}
catch {
    Write-Error "Backup failed: $($_.Exception.Message)"
    exit 1
}
