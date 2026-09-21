# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile=false
COPY tsconfig.base.json ./
COPY apps ./apps
RUN pnpm --filter @app/server db:generate \
 && pnpm --filter @app/server build \
 && pnpm --filter @app/dashboard build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
RUN pnpm install --filter @app/server --prod --frozen-lockfile=false
COPY apps/server/prisma apps/server/prisma
RUN cd apps/server && pnpm exec prisma generate
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/public apps/server/public
WORKDIR /app/apps/server
EXPOSE 3000
# Apply migrations, seed idempotently, then start.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/seed.js && node dist/index.js"]
