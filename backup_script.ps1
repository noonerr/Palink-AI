# Palink AI 备份脚本
# 备份数据库、配置文件、上传文件和代码

# 使用当前工作目录
$backupDir = Get-Location
$timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$backupName = "Palink-AI-Backup-$timestamp.zip"
$backupPath = Join-Path $backupDir $backupName

# 备份内容列表
$backupItems = @(
    "backend\data",
    "backend\app\data",
    "backend\app\main.py",
    "backend\app\database.py",
    "backend\Dockerfile",
    "backend\requirements.txt",
    "frontend\src",
    "frontend\Dockerfile",
    "frontend\package.json",
    "frontend\nginx.conf",
    "docker-compose.yml",
    ".env"
)

# 使用PowerShell内置命令创建备份
try {
    Write-Host "开始创建备份..."
    
    # 执行备份
    Compress-Archive -Path $backupItems -DestinationPath $backupPath -Force

    if (Test-Path $backupPath) {
        $backupSize = (Get-Item $backupPath).Length / 1MB
        Write-Host "备份成功创建: $backupName"
        Write-Host "备份大小: $backupSize MB"
        Write-Host "备份路径: $backupPath"
    } else {
        Write-Host "备份创建失败"
    }
} catch {
    Write-Host "备份过程中出错: $_"
}