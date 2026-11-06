FROM node:22-bookworm-slim AS base
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN npm install --global --force node@24.22.2 && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY deploy/docker-cli /usr/local/bin/docker

FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM base AS app
WORKDIR /app
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY deploy/entrypoint.sh /usr/local/bin/codex-web-entrypoint
RUN chmod 755 /usr/local/bin/codex-web-entrypoint
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000 3001
CMD ["/usr/local/bin/codex-web-entrypoint"]
