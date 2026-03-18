FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Install dependencies (lockfile + package.json first for layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source + migrations
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/

# Build TypeScript
RUN pnpm build

# Runtime
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/server.js"]
