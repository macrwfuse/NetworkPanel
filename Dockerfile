# ============================================
# Stage 1: 构建
# ============================================
FROM docker.1ms.run/node:20-alpine AS builder

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# 先复制依赖文件，利用 Docker 缓存层
COPY package.json pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制所有源码
COPY . .

# 构建（包含所有模块、字体、音效、节点配置）
RUN pnpm run build

# ============================================
# Stage 2: 运行
# ============================================
FROM docker.1ms.run/node:20-alpine

WORKDIR /app

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache nginx

# 安装 nginx
RUN apk add --no-cache nginx

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/http.d/default.conf

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 复制代理服务
COPY server /app/server

# 复制启动脚本
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# 确保静态资源权限正确
RUN chmod -R 755 /usr/share/nginx/html

EXPOSE 80

CMD ["/app/start.sh"]
