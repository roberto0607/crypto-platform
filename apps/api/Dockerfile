# ── Stage 1: Install dependencies ──
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.30.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build TypeScript ──
FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ── Stage 3: Production image ──
FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.30.0 --activate

# Security: run as non-root
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup
WORKDIR /app

# Copy only production deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

# Copy compiled JS + migrations
COPY --from=build /app/dist/ ./dist/
COPY migrations/ ./migrations/

# Runtime config
USER appuser
EXPOSE 3001
ENV NODE_ENV=production
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/server.js"]
