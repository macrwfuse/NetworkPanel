# 网络面板 NetworkPanel

测试您的网速，多出口查询您的ip地址。支持定时测速、2GB流量限制、多通道告警（Slack / 钉钉 / 飞书）。

## ✨ 功能特性

- 🚀 网速测试 + 多出口 IP 查询
- ⏰ 完整 Cron 定时调度（分 时 日 月 周，16 种快捷预设）
- 📊 测速结果以结构化格式告警到 IM 通道
- 💬 多通道告警：Slack / 钉钉(DingTalk) / 飞书(Feishu/Lark)
- 🔄 Slack 告警代理转发（自动转发到钉钉/飞书）
- 📏 单次测速 2GB 流量上限，自动停止
- 🧵 多线程测速，适配 iOS 后台运行
- 🏆 榜单功能（需后端支持）
- 📱 PWA 支持，可添加到主屏幕

## 📖 编译方法

### 环境要求

- **Node.js** >= 18
- **pnpm** >= 8（推荐）或 npm

### 使用 pnpm 编译（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/macrwfuse/NetworkPanel.git
cd NetworkPanel

# 2. 安装 pnpm（如果没有）
npm i -g pnpm

# 3. 安装依赖
pnpm install

# 4. 构建生产版本
pnpm run build

# 构建产物在 dist/ 目录
ls dist/
```

### 使用 npm 编译

```bash
# 1. 克隆项目
git clone https://github.com/macrwfuse/NetworkPanel.git
cd NetworkPanel

# 2. 安装依赖
npm install --legacy-peer-deps

# 3. 构建生产版本（直接 vite build，跳过类型检查）
npx vite build

# 构建产物在 dist/ 目录
ls dist/
```

### 本地开发

```bash
# 安装依赖后，启动通知代理（另开终端）
node server/proxy.mjs

# 启动开发服务器
pnpm run dev
# 或
npm run dev

# 访问 http://localhost:3005
```

> 开发模式下，Vite 会自动将 `/proxy` 请求代理到 `localhost:3001`。

### 部署静态文件

构建完成后，将 `dist/` 目录部署到任意静态服务器：

```bash
# Nginx 示例
cp -r dist/* /var/www/html/

# 或使用 Python 快速预览
cd dist && python3 -m http.server 8080
```

## 🐳 Docker 部署

### 快速启动

```bash
# 拉取镜像（GitHub Container Registry）
docker pull ghcr.io/macrwfuse/networkpanel:latest

# 运行
docker run -d --rm --name network-panel -p 8080:80 ghcr.io/macrwfuse/networkpanel:latest

# 访问 http://localhost:8080
```

### 本地构建镜像

```bash
# 克隆项目
git clone https://github.com/macrwfuse/NetworkPanel.git
cd NetworkPanel

# 构建镜像（多阶段构建，自动编译+打包）
docker build -t network-panel .

# 运行
docker run -d --rm --name network-panel -p 8080:80 network-panel
```

### Docker Compose

```yaml
version: '3'
services:
  network-panel:
    build: .
    # 或使用镜像: image: ghcr.io/macrwfuse/networkpanel:latest
    ports:
      - "8080:80"
    restart: unless-stopped
```

```bash
docker-compose up -d
```

### Docker 镜像说明

镜像采用多阶段构建：

| 阶段 | 基础镜像 | 作用 |
|------|----------|------|
| Stage 1 (builder) | `node:20-alpine` | 安装依赖、编译前端 |
| Stage 2 (runtime) | `node:20-alpine` | nginx + 通知代理服务 |

镜像内置：
- ✅ nginx（静态文件服务 + SPA 路由 + gzip 压缩）
- ✅ Node.js 通知代理服务（解决浏览器 CORS 限制）
- ✅ 所有前端资源（Vue/Element Plus/ECharts/字体/音效/节点配置）

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | `3001` | 通知代理服务端口 |

## 🔔 告警配置

### 钉钉(DingTalk)

1. 群设置 → 智能群助手 → 添加机器人 → 自定义
2. 安全设置选择"加签"，复制 `SEC` 开头的密钥
3. 在面板告警设置中填入 Webhook URL 和加签密钥

### 飞书(Feishu/Lark)

1. 群设置 → 群机器人 → 添加机器人 → 自定义机器人
2. 安全设置可选"签名校验"，复制密钥
3. 在面板告警设置中填入 Webhook URL 和签名密钥

### Slack

1. 创建 Incoming Webhook（设置 → 应用 → Incoming Webhooks）
2. 复制 Webhook URL 到面板

### Slack 代理转发

启用后，Slack 告警会自动转发到已配置的钉钉和/或飞书通道。

## ⏰ Cron 定时调度

标准 5 字段格式：`分 时 日 月 周`

```
*    *    *    *    *
│    │    │    │    │
│    │    │    │    └── 星期 (0=周日, 1-6=周一到周六)
│    │    │    └────── 月份 (1-12)
│    │    └─────────── 日 (1-31)
│    └──────────────── 时 (0-23)
└───────────────────── 分 (0-59)
```

**常用示例：**

| 表达式 | 说明 |
|--------|------|
| `* * * * *` | 每分钟 |
| `*/5 * * * *` | 每 5 分钟 |
| `0 * * * *` | 每小时整点 |
| `0 */2 * * *` | 每 2 小时 |
| `0 0 * * *` | 每天 0 点 |
| `0 8 * * 1-5` | 工作日 8 点 |
| `0 0 1 * *` | 每月 1 号 0 点 |
| `0 0 1 1 *` | 每年 1 月 1 日 0 点 |

**语法支持：** `*` 任意值、`,` 列表、`-` 范围、`/` 步长

## 📦 技术栈

- **前端**：Vue 3 + TypeScript + Vite
- **UI**：Element Plus
- **图表**：ECharts
- **代理**：Node.js HTTP Server
- **服务器**：Nginx
- **容器**：Docker (Alpine)

## 📄 License

MIT License
