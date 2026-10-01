# ─── Stage 1: builder ───
# Installs all deps (including devDeps like typescript) and compiles
# TypeScript to dist/. This stage's output is DISCARDED except for the
# artifacts explicitly copied into the runtime stage below.
FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10.30.0
# Install from the lockfile, never a fresh resolve: an unlocked install pulled
# a newer fastify whose types rejected the numeric trustProxy option, so the
# image failed to compile while local + CI (lockfile) passed. pnpm-workspace
# carries onlyBuiltDependencies (argon2/esbuild build-script allowlist).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN pnpm build

# ─── Stage 2: runtime ───
# Clean image with only: prod deps + compiled dist/ + migrations/.
# tsx is a prod dep (moved out of devDependencies) because the TS
# emit leaves extensionless ESM imports that plain node cannot resolve.
FROM node:20-alpine AS runtime
WORKDIR /app
RUN npm install -g pnpm@10.30.0

# Copy only what's needed at runtime
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/migrations/ ./migrations/

# Production install only — strips typescript, vitest, @types/*, etc.
RUN pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npx", "tsx", "dist/server.js"]
