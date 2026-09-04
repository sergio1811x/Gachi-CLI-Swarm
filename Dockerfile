# Multi-stage build for gachi-cli-swarm
# Stage 1: build TypeScript + web, stage 2: slim runtime image

# ── builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# TypeScript → dist/
RUN pnpm exec tsc -p tsconfig.build.json \
 && node scripts/prepare-build-artifacts.mjs

# Vite → web/dist/  (cats_from_memes + icons copied from web/public)
RUN pnpm run build:web

# ── runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN addgroup -g 1001 -S gachi && adduser -S gachi -u 1001 -G gachi

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# Install prod deps and rebuild native addons (better-sqlite3) for this arch
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist            ./dist
COPY --from=builder /app/web/dist        ./web/dist

# The server serves web/dist as static files and binds port 4010
EXPOSE 4010

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node dist/src/cli/gachi.js doctor || exit 1

USER gachi
CMD ["node", "dist/src/cli/gachi.js"]
