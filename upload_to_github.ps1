# PowerShell 脚本：自动创建 GitHub 仓库并上传代码
# 运行前请确保已安装 Git 并配置了 GitHub 凭据

$repoName = "tokensales-webhook"
$repoDescription = "Webhook server for TokenSales"
$localPath = "F:\OpenClawData\.openclaw\workspace\tokensales-webhook"

Write-Host "🚀 开始创建 GitHub 仓库并上传代码..." -ForegroundColor Green

# 检查是否在正确的目录
Set-Location $localPath

# 初始化 Git 仓库
Write-Host "📁 初始化本地 Git 仓库..." -ForegroundColor Cyan
if (Test-Path ".git") {
    Remove-Item -Recurse -Force ".git"
}
git init

# 添加所有文件
Write-Host "📄 添加文件到 Git..." -ForegroundColor Cyan
git add .

# 提交
Write-Host "💾 提交更改..." -ForegroundColor Cyan
git commit -m "Initial commit"

# 创建 GitHub 仓库（使用 gh CLI）
Write-Host "🌐 创建 GitHub 仓库..." -ForegroundColor Cyan
$createResult = gh repo create $repoName --public --description $repoDescription --source=. --remote=origin --push 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 仓库创建成功并上传完成！" -ForegroundColor Green
    Write-Host ""
    Write-Host "仓库地址: https://github.com/$(gh api user -q .login)/$repoName" -ForegroundColor Yellow
} else {
    Write-Host "❌ 创建失败，尝试备用方案..." -ForegroundColor Red
    Write-Host $createResult
    
    # 备用方案：手动创建仓库后推送
    Write-Host ""
    Write-Host "请手动执行以下步骤：" -ForegroundColor Yellow
    Write-Host "1. 访问 https://github.com/new" -ForegroundColor Cyan
    Write-Host "2. 仓库名称: $repoName" -ForegroundColor Cyan
    Write-Host "3. 选择 Public" -ForegroundColor Cyan
    Write-Host "4. 不要勾选 README" -ForegroundColor Cyan
    Write-Host "5. 创建后复制仓库地址" -ForegroundColor Cyan
    Write-Host "6. 运行: git remote add origin <仓库地址>" -ForegroundColor Cyan
    Write-Host "7. 运行: git push -u origin main" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
