# 使用 Debian-slim 版本，兼容 Puppeteer 和 Chromium
FROM node:20-slim

# 安装 Chromium 所需依赖
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libgbm1 \
    libxshmfence1 \
    libglu1-mesa \
    chromium \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 设置 Puppeteer 不自动下载 Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 设置工作目录
WORKDIR /usr/src/app

# 拷贝项目代码
COPY package*.json ./
RUN npm install
COPY . .

# 暴露端口（如果你的服务监听 3000）
EXPOSE 3000

# 启动服务
CMD ["node", "server_latest_new.js"]
