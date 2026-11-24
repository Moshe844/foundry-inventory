# CodeBuild passes the same official image from the ECR Public mirror (no Docker Hub rate limit).
ARG BASE=node:22.23.4-bookworm-slim
FROM ${BASE} AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${BASE}
ENV NODE_ENV=production FOUNDRY_SKIP_LOCAL_ENV=1
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Synthetic qualification sources only (src/imports/aws-qualification-million.js).
COPY scripts/lib ./scripts/lib
USER node
CMD ["node", "src/aws-import-worker-server.js"]
