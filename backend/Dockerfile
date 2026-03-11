# 使用 python:3.10-bullseye (Debian 11 完整版)
FROM python:3.10-bullseye

WORKDIR /app

# 1. 换 apt 源为腾讯云
RUN sed -i 's/deb.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list && \
    sed -i 's/security.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list

# 2. 安装系统依赖
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    libssl-dev \
    libffi-dev \
    libpq-dev \
    cmake \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# 3. 安装依赖 (使用阿里云 HTTP 源)
# --trusted-host: 避开 SSL 验证
RUN pip install --no-cache-dir -r requirements.txt \
    -i http://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    --default-timeout=600

COPY . .

# 增加uvicorn的最大请求大小限制到10GB
# 注意：uvicorn没有直接的max-request-size参数，需要通过FastAPI的配置来设置
# 这里我们增加超时时间以支持大文件上传
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "600", "--timeout-graceful-shutdown", "600", "--timeout-server", "600"]