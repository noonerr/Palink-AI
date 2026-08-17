#!/bin/bash

# Palink-AI 免费 WebSearch 快速配置脚本

echo "====================="
echo "  Palink-AI 免费 WebSearch 配置向导"
echo "============================="
echo "

# 检查是否已有配置
if [ -f "backend/.env" ] && grep -q "BRAVE_API_KEY" backend/.env; then
    echo "✅ 检测到已有 Brave API Key 配置"
    echo ""
    read -p "是否要更新配置？(y/n): " update
    if [ "$update" != "y" ]; then
        echo "配置已取消"
        exit 0
    fi
fi

echo "📖 步骤 1: 获取 Brave Search API Key"
echo ""
echo "1. 访问: https://brave.com/search/api/"
echo "2. 注册并选择 Free Plan（每月 2000 次免费）"
echo "3. 获取 API Key（格式：BSA...）"
echo ""
read -p "请粘贴你的 Brave API Key: " api_key

if [ -z "$api_key" ]; then
    echo "❌ API Key 不能为空"
    exit 1
fi

# 验证 API Key 格式
if [[ ! "$api_key" =~ ^BSA ]]; then
    echo "⚠️  警告: API Key 格式可能不正确（应该以 BSA 开头）"
    read -p "是否继续？(y/n): " continue
    if [ "$continue" != "y" ]; then
        exit 1
    fi
fi

echo ""
echo "📝 步骤 2: 配置到项目"

# 创建或更新 backend/.env
if [ ! -f "backend/.env" ]; then
    echo "创建 backend/.env 文件..."
    touch backend/.env
fi

# 检查是否已有 BRAVE_API_KEY
if grep -q "BRAVE_API_KEY" backend/.env; then
    # 更新现有配置
    sed -i.bak "s/BRAVE_API_KEY=.*/BRAVE_API_KEY=$api_key/" backend/.env
    echo "✅ 已更新 Brave API Key"
else
    # 添加新配置
    echo " >> backend/.env
    echo "# Brave Search API Key（免费，每月 2000 次）" >> backend/.env
    echo "BRAVE_API_KEY=$api_key" >> backend/.env
    echo "✅ 已添加 Brave API Key"
fi

echo ""
echo "🔒 步骤 3: 确保安全"

# 确保 .env 在 .gitignore 中
if [ ! -f "backend/.gitignore" ]; then
    echo ".env" > backend/.gitignore
    echo "✅ 已创建 backend/.gitignore"
elif ! grep -q "^\.env$" backend/.gitignore; then
    echo ".env" >> backend/.gitignore
    echo "✅ 已添加 .env 到 .gitignore"
fi

echo "
echo "🚀 步骤 4: 重启后端服务"
echo ""
read -p "是否立即重启后端服务？(y/n): " restart

if [ "$restart" = "y" ]; then
    echo "重启后端服务..."
    docker-compose restart backend
    echo "✅ 后端服务已重启"
else
    echo "⚠️  请手动重启后端服务："
    echo "   docker-compose restart backend"
fi

echo ""
echo "==========================="
echo "  ✅ 配置完成！"
echo "============================"
echo ""
echo "📊 下一步："
echo "1. 登录管理后台"
echo "2. 进入 设置 → WebSearch 配置"
echo "3. 选择 Brave Search 引擎"
echo "4. 启用 WebSearch"
echo "5. 在前端测试搜索功能"
echo ""
echo "📖 详细文档: docs/FREE_WEBSEARCH_SETUP.md"
echo ""
echo "💰 免费额度: 每月 2000 次查询"
echo "📈 监控用量: https://brave.com/search/api/dashboard"
echo ""
