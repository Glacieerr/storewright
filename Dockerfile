# 自托管实时后端（含员工作业端）。数据放在 /data（嵌入式 PGlite）；设置 DATABASE_URL 时改用 PostgreSQL。
#   docker build -t storewright .
#   docker run -p 8787:8787 -v storewright-data:/data storewright
# 非演示部署请设置 DEMO=0 和 CONSOLE_KEY；手机摄像头扫码需要 HTTPS（反向代理或 HTTPS=1）。
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci && npm run build:associate && npm cache clean --force
ENV PORT=8787 HOST=0.0.0.0 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["npm", "run", "server"]
