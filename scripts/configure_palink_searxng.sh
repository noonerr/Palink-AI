#!/bin/bash

# Palink-AI 配置 SearXNG 脚本

echo "==========================="
echo "  Palink-AI SearXNG 配置向导"
echo "========================"
echo "

# 获取 SearXNG URL
read -p "请输入 SearXNG 服务器地址（例如: http://104.208.99.17:8080）: " searxng_url

if [ -z "$searxng_url" ]; then
    echo "❌ URL 不能为空"
    exit 1
fi

# 验证 URL 格式
if [[ ! "$searxng_url" =~ ^https?:// ]]; then
    echo "❌ URL 格式错误，应该以 http:// 或 https:// 开头"
    exit 1
fi

# 测试连接
echo ""
echo "🧪 测试连接到 SearXNG..."
if curl -s --max-time 10 "$searxng_url" > /dev/null; then
    echo "✅ 连接成功"
else
    echo "❌ 无法连接到 SearXNG"
    echo "   请检查："
    echo "   1. 服务器是否运行"
    echo "   2. 防火墙是否开放 8080 端口"
    echo "   3. URL 是否正确"
    exit 1
fi

# 测试搜索功能
echo ""
echo "🔍 测试搜索功能..."
search_result=$(curl -s --max-time 10 "$searxng_url/search?q=test&format=json")
if echo "$search_result" | grep -q "results"; then
    echo "✅ 搜索功能正常"
else
    echo "⚠️  搜索功能可能异常，但继续配置"
fi

# 配置 Palink-AI
echo ""
echo "📝 配置 Palink-AI..."

# 检查是否在项目根目录
if [ ! -f "backend/app/services/web_search.py" ]; then
    echo "❌ 请在 Palink-AI 项目根目录运行此脚本"
    exit 1
fi

# 创建配置文件
mkdir -p backend/data
cat > backend/data/web_search.json <<EOF
{
  "enabled": true,
  "engine": "searxng",
  "searxng_url": "$searxng_url",
  "brave_api_key": "",
  "baidu_cookie": "",
  "custom_url": "",
  "custom_engine": "searxng"
}
EOF

echo "✅ 配置文件已创建: backend/data/web_search.json"

# 重启后端服务
echo ""
read -p "是否重启后端服务？(y/n): " restart

if [ "$restart" = "y" ]; then
    if command -v docker-compose &> /dev/null; then
        echo "🔄 重启后端服务..."
        docker-compose restart backend
        echo "✅ 后端服务已重启"
    else
        echo "⚠️  未检测到 docker-compose，请手动重启后端服务"
    fi
else
    echo "⚠️  请手动重启后端服务："
    echo "   docker-compose restart backend"
fi

echo ""
echo "======================="
echo "  ✅ 配置完成！"
echo "============="
echo ""
echo "📊 配置信息："
echo "   引擎: SearXNG"
echo "   URL: $searxng_url"
echo "   状态: 已启用"
echo ""
echo "🧪 测试步骤："
echo "   1. 打开 Palink-AI 前端"
echo "   2. 启用 WebSearch 开关"
echo "   3. 发送消息: '搜索一下 React 19'"
echo "   4. 检查是否返回搜索结果"
echo ""
echo "📝 查看日志："
echo "   docker logs palink-ai-backend-1 --tail 50 -f"
echo ""
