FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM node:22-bookworm-slim
RUN sed -i 's|deb.debian.org/debian|mirrors.cloud.tencent.com/debian|g; s|security.debian.org/debian-security|mirrors.cloud.tencent.com/debian-security|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production RUNTIME_WORKSPACE_ROOT=/var/lib/quarkfan/workspaces
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /var/lib/quarkfan/workspaces && chown -R node:node /var/lib/quarkfan/workspaces
USER node
CMD ["node","dist/src/index.js"]
