$ErrorActionPreference = "Stop"
$backup = "backups/20260430-082846"

# Copy frontend source
Write-Host "Copying frontend/src..."
Copy-Item "$backup/frontend/src" "frontend/src" -Recurse -Force
Write-Host "Copying frontend/public..."
Copy-Item "$backup/frontend/public" "frontend/public" -Recurse -Force

# Copy backend source
Write-Host "Copying backend/app..."
Copy-Item "$backup/backend/app" "backend/app" -Recurse -Force

# Copy config files
$configs = @(
    @("$backup/frontend/index.html", "frontend/index.html"),
    @("$backup/frontend/nginx.conf", "frontend/nginx.conf"),
    @("$backup/frontend/tailwind.config.js", "frontend/tailwind.config.js"),
    @("$backup/frontend/tsconfig.json", "frontend/tsconfig.json"),
    @("$backup/frontend/vite.config.js", "frontend/vite.config.js"),
    @("$backup/frontend/package.json", "frontend/package.json"),
    @("$backup/frontend/Dockerfile", "frontend/Dockerfile"),
    @("$backup/backend/Dockerfile", "backend/Dockerfile"),
    @("$backup/backend/requirements.txt", "backend/requirements.txt"),
    @("$backup/docker-compose.yml", "docker-compose.yml"),
    @("$backup/backup_script.ps1", "backup_script.ps1")
)
foreach ($c in $configs) {
    if (Test-Path $c[0]) {
        Copy-Item $c[0] $c[1] -Force
        Write-Host "Copied: $($c[1])"
    }
}

Write-Host "`nRestore complete!"
