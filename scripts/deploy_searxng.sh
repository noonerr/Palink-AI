#!/bin/bash

# Palink-AI SearXNG 部署脚本（香港服务器）

set -e

echo "=============================="
echo "  SearXNG 部署向导"
echo "===================="
echo ""

# 检查是否为 root
if [ "$EUID" -ne 0 ]; then
    echo "❌ 请使用 root 权限运行此脚本"
    echo "   sudo bash $0"
    exit 1
fi

# 检查 Docker
echo "📦 检查 Docker..."
if ! command -v docker &> /dev/null; then
    echo "⚠️  Docker 未安装，正在安装..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "✅ Docker 安装完成"
else
    echo "✅ Docker 已安装"
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "⚠️  Docker Compose 未安装，正在安装..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "✅ Docker Compose 安装完成"
else
  echo "✅ Docker Compose 已安装"
fi

# 创建工作目录
SEARXNG_DIR="/opt/searxng"
echo ""
echo "📁 创建工作目录: $SEARXNG_DIR"
mkdir -p $SEARXNG_DIR
cd $SEARXNG_DIR

# 生成随机密钥
SECRET_KEY=$(openssl rand -hex 32)

# 创建 docker-compose.yml
echo ""
echo "📝 创建 docker-compose.yml..."
cat > docker-compose.yml <<EOF
version: '3.7'

services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    ports:
      - "8888:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://\${SERVER_IP}:8888/
      - SEARXNG_SECRET=\${SECRET_KEY}
    networks:
      - searxng

  redis:
    image: redis:alpine
    container_name: searxng-redis
    restart: unless-stopped
    command: redis-server --save 30 1 --loglevel warning
    volumes:
      - redis-data:/data
    networks:
      - searxng

networks:
  searxng:

volumes:
  redis-data:
EOF

# 创建配置目录
mkdir -p searxng

# 创建 settings.yml
echo ""
echo "📝 创建 settings.yml..."
cat > searxng/settings.yml <<EOF
use_default_settings: true

general:
  debug: false
  instance_name: "Palink-AI Search"
  contact_url: false
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: "google"
  default_lang: "zh-CN"
  formats:
    - html
    - json

server:
  secret_key: "$SECRET_KEY"
  limiter: true
  image_proxy: true
  method: "GET"

  # CORS 配置（允许 Palink-AI 访问）
  http_protocol_version: "1.1"

ui:
  static_use_hash: true
  default_locale: "zh-CN"
  query_in_title: true
  infinite_scroll: false
  center_alignment: false
  default_theme: simple
  theme_args:
    simple_style: auto

redis:
  url: redis://redis:6379/0

enabled_plugins:
  - 'Hash plugin'
  - 'Self Information'
  - 'Tracker URL remover'
  - 'Ahmia blacklist'

engines:
  - name: google
    engine: google
    shortcut: go
    use_mobile_ui: false

  - name: bing
    engine: bing
    shortcut: bi

  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg

  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    base_url: 'https://{language}.wikipedia.org/'

  - name: github
    engine: github
    shortcut: gh

  - name: stackoverflow
    engine: stackoverflow
    shortcut: so

  - name: baidu
    engine: baidu
    shortcut: bd
    disabled: false

  - name: bing images
    engine: bing_images
    shortcut: bii

  - name: google images
    engine: google_images
    shortcut: goi
EOF

# 创建 .env 文件
echo ""
echo "📝 创建环境变量..."

# 获取服务器 IP
SERVER_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || echo "104.208.99.17")

cat > .env <<EOF
SERVER_IP=$SERVER_IP
SECRET_KEY=$SECRET_KEY
EOF

echo "✅ 服务器 IP: $SERVER_IP"
echo "✅ 密钥已生成"

# 启动服务
echo ""
echo "🚀 启动 SearXNG..."
docker-compose up -d

# 等待服务启动
echo ""
echo "⏳ 等待服务启动（30秒）..."
sleep 30

# 检查服务状态
echo ""
echo "🔍 检查服务状态..."
if docker ps | grep -q searxng; then
    echo "✅ SearXNG 容器运行中"
else
    echo "❌ SearXNG 容器未运行"
    docker-compose logs
    exit 1
fi

# 测试服务
echo ""
echo "🧪 测试服务..."
if curl -s "http://localhost:8888" > /dev/null; then
    echo "✅ SearXNG 服务正常"
else
    echo "❌ SearXNG 服务无响应"
    exit 1
fi

# 配置防火墙
echo ""
echo "🔒 配置防火墙..."
if command -v ufw &> /dev/null; then
    ufw allow 8888/tcp
    echo "✅ UFW 防火墙已配置"
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=8888/tcp
    firewall-cmd --reload
    echo "✅ Firewalld 防火墙已配置"
else
    echo "⚠️  未检测到防火墙，请手动开放 8888 端口"
fi

echo ""
echo "=============================="
echo "  ✅ 部署完成！"
echo "================================"
echo ""
echo "📊 服务信息："
echo "   URL: http://$SERVER_IP:8888"
echo "   容器: searxng, searxng-redis"
echo "   配置: $SEARXNG_DIR/searxng/settings.yml"
echo "🔧 管理命令："
echo "   查看日志: docker-compose -f $SEARXNG_DIR/docker-compose.yml logs -f"
echo "   重启服务: docker-compose -f $SEARXNG_DIR/docker-compose.yml restart"
echo "   停止服务: docker-compose -f $SEARXNG_DIR/docker-compose.yml down"
echo "   更新服务: docker-compose -f $SEARXNG_DIR/docker-compose.yml pull && docker-compose -f $SEARXNG_DIR/docker-compose.yml up -d"
echo ""
echo "📝 下一步："
echo "   1. 测试搜索: curl 'http://$SERVER_IP:8888/search?q=test&format=json'"
echo "   2. 配置 Palink-AI 后端"
echo "   3. 在管理后台选择 SearXNG 引擎"
echo ""
