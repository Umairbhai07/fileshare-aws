# Build context is the repo root:  docker build -f app/Dockerfile -t fileshare-api .
FROM public.ecr.aws/docker/library/node:22-alpine AS deps
WORKDIR /srv
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY app/package.json app/
COPY lambdas/package.json lambdas/
RUN npm ci --omit=dev --workspace=@fileshare/app --include-workspace-root=false --no-audit --no-fund

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /srv
COPY --from=deps /srv/node_modules ./node_modules
COPY package.json ./
COPY core ./core
COPY app ./app
RUN rm -rf core/test app/test && mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "app/src/server.js"]
