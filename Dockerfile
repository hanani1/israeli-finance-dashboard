# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — deps: install node_modules (with dev deps, needed for the build,
# tsx worker and Prisma CLI). Chromium download is skipped; the runtime stage
# installs Debian's chromium package instead.
###############################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Prisma detects the system OpenSSL version during postinstall/client generation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# israeli-bank-scrapers depends on Puppeteer — skip its bundled Chromium.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# prisma/ must be present BEFORE install: postinstall runs `prisma generate`,
# which reads prisma/schema.prisma.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

###############################################################################
# Stage 2 — build: compile the Next.js app (output: 'standalone').
###############################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma is evaluated during `next build`; make its runtime detection match
# the OpenSSL-enabled runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

###############################################################################
# Stage 3 — runtime: single image that serves BOTH roles:
#   * web app  (default):        CMD ["node", "server.js"]  — standalone server
#   * worker   (compose override): command: npm run worker  — tsx + src/
###############################################################################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# System Chromium + fonts for the Puppeteer-based bank scrapers.
# (apt pulls in the required shared libraries as chromium's dependencies.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openssl \
       tzdata \
       chromium \
       fonts-freefont-ttf \
       fonts-liberation \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# TZ: the scrapers parse provider dates in process-local time and those
# instants feed the deterministic transaction id — must match the host (ADR-0020).
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=Asia/Jerusalem \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root user (with a home dir — Chromium needs a writable profile dir).
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home --home-dir /home/app app

# Standalone server output (server.js + minimal .next server build).
COPY --from=build --chown=app:nodejs /app/.next/standalone ./
COPY --from=build --chown=app:nodejs /app/.next/static ./.next/static
# NOTE: this project has no public/ directory, so nothing to copy for it.

# Full node_modules (a superset of the pruned standalone set) so that the
# tsx-based worker, the Prisma CLI (migrate deploy / db seed) and the
# generated Prisma client (node_modules/.prisma) all work in this image.
COPY --from=build --chown=app:nodejs /app/node_modules ./node_modules

# Full package.json (scripts: worker, sync:once + the prisma.seed config) —
# overwrites the minimal one emitted by the standalone build.
COPY --from=build --chown=app:nodejs /app/package.json ./package.json

# Prisma schema + migrations, for `npx prisma migrate deploy` at startup.
COPY --from=build --chown=app:nodejs /app/prisma ./prisma

# Worker sources + tsconfig (tsx resolves the '@/…' path alias from it).
COPY --from=build --chown=app:nodejs /app/src ./src
COPY --from=build --chown=app:nodejs /app/scripts ./scripts
COPY --from=build --chown=app:nodejs /app/tsconfig.json ./tsconfig.json

USER app
EXPOSE 3000

CMD ["node", "server.js"]
