# ─── Stage 1: builder ───
# Installs all deps (including devDeps like typescript) and compiles
# TypeScript to dist/. This stage's output is DISCARDED except for the
# artifacts explicitly copied into the runtime stage below.
FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@latest
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
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
RUN npm install -g pnpm@latest

# Copy only what's needed at runtime
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/migrations/ ./migrations/

# Production install only — strips typescript, vitest, @types/*, etc.
RUN pnpm install --prod --no-frozen-lockfile

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npx", "tsx", "dist/server.js"]
