FROM node:20-slim

# 安装 Chromium 及依赖项
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

# Puppeteer 配置：跳过下载 Chromium，手动指定路径
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 设置工作目录
WORKDIR /usr/src/app

# 拷贝代码并安装依赖
COPY package*.json ./
RUN npm install
COPY . .

# 替换 Puppeteer 启动配置，必须带上 --no-sandbox --disable-setuid-sandbox
ENV CHROME_ARGS="--no-sandbox --disable-setuid-sandbox"

# 如果你写的代码里没有用上这些 args，请确保传入了它们：
# puppeteer.launch({ args: process.env.CHROME_ARGS.split(" "), executablePath: process.env.PUPPETEER_EXECUTABLE_PATH })

EXPOSE 3000

CMD ["node", "server_latest_new.js"]