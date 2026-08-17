# Build stage
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
RUN awk 'NR==1{sub(/^\xef\xbb\xbf/,"")}1' /etc/nginx/conf.d/default.conf > /tmp/nginx.tmp && mv /tmp/nginx.tmp /etc/nginx/conf.d/default.conf
RUN awk 'NR==1{sub(/^\xef\xbb\xbf/,"")}1' /etc/nginx/security-headers.conf > /tmp/sh.tmp && mv /tmp/sh.tmp /etc/nginx/security-headers.conf
RUN adduser -D -u 1000 appuser && \
    chown -R appuser:appuser /usr/share/nginx/html && \
    chown -R appuser:appuser /var/cache/nginx && \
    chown -R appuser:appuser /var/log/nginx && \
    mkdir -p /run && \
    chown -R appuser:appuser /run && \
    sed -i '/^user /d' /etc/nginx/nginx.conf && \
    sed -i 's|/var/run/nginx.pid|/run/nginx.pid|g' /etc/nginx/nginx.conf
# Brotli 模块安装当前 DISABLED：2026-08-17 实测 apk 包 nginx-mod-http-brotli 与
# nginx:alpine 1.28.3-r7 版本冲突（breaks: nginx=1.28.3-r7），镜像构建失败，曾导致
# 前端容器持续崩溃（nginx.conf 中 brotli 指令无法识别）。恢复方式：先解决模块与
# 基镜像版本匹配（如固定 nginx 版本），再取消下面 3 行注释并同步启用 nginx.conf
# 中的 brotli 指令。
# RUN apk add --no-cache nginx-mod-http-brotli && \
#     sed -i '1i load_module /usr/lib/nginx/modules/ngx_http_brotli_static_module.so;' /etc/nginx/nginx.conf && \
#     sed -i '1i load_module /usr/lib/nginx/modules/ngx_http_brotli_filter_module.so;' /etc/nginx/nginx.conf
EXPOSE 8080 8081
USER appuser
CMD ["nginx", "-g", "daemon off;"]
