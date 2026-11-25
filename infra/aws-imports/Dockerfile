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
# PostgreSQL 17's pg_restore for the one-off restore of Render's export
# (src/db/aws-restore.js), from PostgreSQL's own signed package repository.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && pg_restore --version
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Synthetic qualification sources only (src/imports/aws-qualification-million.js).
COPY scripts/lib ./scripts/lib
# Operator command for adding private-pilot businesses to the live AWS database,
# run as a one-off task beside it (Render's web shell does not take pasted commands reliably).
COPY scripts/provision-private-production-pilot.js ./scripts/
USER node
CMD ["node", "src/aws-import-worker-server.js"]
