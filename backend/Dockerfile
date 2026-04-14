FROM python:3.10-bullseye AS builder

WORKDIR /app

ARG INSTALL_ML_EXTRAS=0

# 1. 换 apt 源为腾讯云
RUN sed -i 's/deb.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list && \
    sed -i 's/security.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list

# 2. 构建阶段安装编译依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    libffi-dev \
    libpq-dev \
    cmake \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-ml.txt ./

# 3. 安装 Python 依赖到独立目录
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt \
    -i http://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    --default-timeout=600

# 4. 按需安装重量级 ML 依赖（默认关闭）
RUN if [ "$INSTALL_ML_EXTRAS" = "1" ]; then \
      pip install --no-cache-dir --prefix=/install -r requirements-ml.txt \
      -i http://mirrors.aliyun.com/pypi/simple/ \
      --trusted-host mirrors.aliyun.com \
      --default-timeout=600; \
    fi


FROM python:3.10-bullseye AS runtime

WORKDIR /app

# 5. 运行阶段仅保留必要系统依赖
RUN sed -i 's/deb.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list && \
    sed -i 's/security.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libpq5 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local
COPY . .

# 启动脚本会根据容器可用CPU自动计算 worker 和线程上限
CMD ["sh", "/app/start-server.sh"]