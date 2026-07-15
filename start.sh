#!/bin/sh
# 启动通知代理服务（后台）
node /app/server/proxy.mjs &

# 启动 nginx（前台）
nginx -g 'daemon off;'
