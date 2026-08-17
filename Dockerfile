# 阶段 1: 构建 React 应用
FROM node:18-alpine as build
WORKDIR /app

COPY package*.json ./

# --- 绝招：改用 Yarn + 淘宝源 (Yarn 比 npm 更稳更猛) ---
# 1. 设置 Yarn 为淘宝镜像源
RUN yarn config set registry https://registry.npmmirror.com

# 2. 安装依赖 (设置了超长超时时间，防止网络抖动报错)
RUN yarn install --network-timeout 1000000

COPY . .

# 3. 开始构建打包
RUN yarn build

# 阶段 2: 使用 Nginx 托管
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]