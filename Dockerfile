# ============================================
# Stage 1: 构建
# ============================================
FROM node:20-alpine AS builder

WORKDIR /app

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
FROM nginx:stable-alpine

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 确保静态资源权限正确
RUN chmod -R 755 /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
